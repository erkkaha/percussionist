import { useState, useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchBoard, deleteBoardTask, retryEscalatedTask, approveTask, requestChangesTask } from "../lib/api";
import type { Task, ManagerMetrics } from "../lib/types";
import { useBoardNotifications } from "../hooks/useBoardNotifications";
import { useBoardEvents } from "../hooks/useBoardEvents";
import { BoardHeader } from "./board/BoardHeader";
import { TaskDetailPanel, TaskDetailEmpty } from "./board/TaskDetailPanel";
import { Sheet, SheetContent } from "./ui/sheet";
import { AddTaskForm } from "./board/AddTaskForm";

export default function BoardView() {
  const { name } = useParams<{ name: string }>();
  const projectName = name!;
  const queryClient = useQueryClient();
  const { connected: boardSseConnected, eventTick } = useBoardEvents(projectName, true);

  const { data, isLoading, error } = useQuery({
    queryKey: ["board", projectName],
    queryFn: () => fetchBoard(projectName),
    refetchInterval: boardSseConnected ? false : 10_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (eventTick > 0) {
      void queryClient.invalidateQueries({ queryKey: ["board", projectName] });
    }
  }, [eventTick, projectName, queryClient]);

  // Responsive-aware add-task visibility: desktop uses inline form, mobile uses full-screen Sheet.
  const [showAddTaskDesktop, setShowAddTaskDesktop] = useState(false);
  const [showAddTaskMobile, setShowAddTaskMobile] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskName = searchParams.get("task") ?? null;
  const [sheetOpen, setSheetOpen] = useState(false);

  // Single handler that dispatches to the right state based on viewport width.
  const handleAddTask = () => {
    if (window.innerWidth < 768) {
      setShowAddTaskMobile((v) => !v);
    } else {
      setShowAddTaskDesktop((v) => !v);
    }
  };

  // Close mobile add-task overlay.
  const handleCloseAddTaskMobile = () => setShowAddTaskMobile(false);

  const allTasks: Task[] = data ? Object.values(data.columns).flat() : [];

  const invalidateBoard = () => queryClient.invalidateQueries({ queryKey: ["board", projectName] });

  const deleteMutation = useMutation({
    mutationFn: (taskName: string) => deleteBoardTask(projectName, taskName),
    onSuccess: () => {
      invalidateBoard();
      setSearchParams({}, { replace: true });
      setSheetOpen(false);
    },
  });

  const retryMutation = useMutation({
    mutationFn: (taskName: string) => retryEscalatedTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const approveMutation = useMutation({
    mutationFn: (taskName: string) => approveTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const requestChangesMutation = useMutation({
    mutationFn: ({ taskId, comment }: { taskId: string; comment: string }) =>
      requestChangesTask(projectName, taskId, comment),
    onSuccess: invalidateBoard,
  });

  useBoardNotifications(projectName, allTasks);

  const handleSelectTask = (name: string) => {
    setSearchParams({ task: name });
    // Only open the sheet on mobile (below md breakpoint).
    // On desktop the detail panel is rendered inline; opening the Sheet would
    // trigger its backdrop overlay even though SheetContent is hidden via CSS.
    if (window.innerWidth < 768) {
      setSheetOpen(true);
    }
  };

  const handleSheetClose = (open: boolean) => {
    setSheetOpen(open);
    if (!open) setSearchParams({}, { replace: true });
  };

  // Stabilise approvals reference so TaskDetailPanel's memo comparator isn't
  // invalidated on every board refetch when approvals haven't actually changed.
  // Must be before early returns to satisfy Rules of Hooks.
  const rawApprovals = data?.approvals;
  const approvals = useMemo(() => rawApprovals, [JSON.stringify(rawApprovals)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading && !data) return <p className="text-sm text-text-dim p-4">Loading board…</p>;
  if (error && !data) return <p className="text-sm text-phase-failed p-4">Failed to load board.</p>;
  if (!data) return <p className="text-sm text-phase-failed p-4">Failed to load board.</p>;

  const { settings, columns, status } = data;
  const roster = (settings.agents ?? []).map((a: { name: string }) => a.name);

  const selectedTask: Task | undefined = selectedTaskName
    ? allTasks.find((t) => t.metadata.name === selectedTaskName)
    : undefined;

  const selectedCol: string | undefined = selectedTaskName
    ? Object.entries(columns).find(([, tasks]) => tasks.some((t) => t.metadata.name === selectedTaskName))?.[0]
    : undefined;

  const detailPanel = selectedTask && selectedCol ? (
    <TaskDetailPanel
      task={selectedTask}
      col={selectedCol}
      projectName={projectName}
      approvals={approvals}
      onDeleted={() => { setSearchParams({}, { replace: true }); setSheetOpen(false); }}
    />
  ) : null;

  return (
    // Pull out of the parent p-6 padding so the board can fill the viewport correctly.
    <div className="-m-6 flex flex-col" style={{ height: "calc(100svh - 3.5rem)" }}>
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border">
        <BoardHeader
          projectName={projectName}
          roster={roster}
          maxParallel={settings.maxParallel}
          phase={settings.phase}
          sseConnected={boardSseConnected}
          metrics={status.managerMetrics as ManagerMetrics | undefined}
          onAddTask={handleAddTask}
          showAddTask={showAddTaskDesktop || showAddTaskMobile}
        />
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Task list — full width on mobile, constrained on desktop when detail is open */}
        <div className={`flex flex-col min-h-0 w-full ${selectedTask ? "md:w-2/5 md:border-r md:border-border" : ""}`}>
          <TaskListPanel
            projectName={projectName}
            columns={columns}
            roster={roster}
            selectedTaskName={selectedTaskName}
            onSelectTask={handleSelectTask}
            showAddTask={showAddTaskDesktop}
            onCloseAddTask={() => setShowAddTaskDesktop(false)}
            approvals={approvals}
          />
        </div>

        {/* Desktop detail panel — hidden on mobile */}
        <div className="hidden md:flex flex-col flex-1 min-h-0">
          {detailPanel ?? <TaskDetailEmpty />}
        </div>
      </div>

      {/* Mobile Sheet — slide-in detail panel. The SheetContent renders its own close
            button at top-right; TaskDetailPanel handles its own scrolling. */}
      <Sheet open={sheetOpen} onOpenChange={handleSheetClose}>
        <SheetContent
          side="right"
          className="md:hidden w-full sm:max-w-lg p-0 flex flex-col overflow-hidden bg-surface text-text border-border [&>button]:z-10"
        >
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {detailPanel ?? <TaskDetailEmpty />}
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile full-screen add-task overlay */}
      <Sheet open={showAddTaskMobile} onOpenChange={(open) => setShowAddTaskMobile(open)}>
        <SheetContent
          side="bottom"
          className="md:hidden w-screen max-w-none h-svh p-0 border-border [&>button]:z-10"
        >
          <div className="flex flex-col h-full min-h-0">
            {/* Scrollable inner region */}
            <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8 space-y-3">
              <AddTaskForm
                projectName={projectName}
                roster={roster}
                onClose={handleCloseAddTaskMobile}
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
