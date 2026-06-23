import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useIsMobile } from '../hooks/use-mobile';
import { useBoardEvents } from '../hooks/useBoardEvents';
import { useBoardNotifications } from '../hooks/useBoardNotifications';
import {
  approveTask,
  deleteBoardTask,
  fetchBoard,
  requestChangesTask,
  retryEscalatedTask,
} from '../lib/api';
import type { ManagerMetrics, Task } from '../lib/types';
import { AddTaskForm } from './board/AddTaskForm';
import { BoardHeader } from './board/BoardHeader';
import { FindingsPanel } from './board/FindingsPanel';
import { TaskDetailEmpty, TaskDetailPanel } from './board/TaskDetailPanel';
import { TaskListPanel } from './board/TaskListPanel';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

export default function BoardView() {
  const { name } = useParams<{ name: string }>();
  const projectName = name;
  const queryClient = useQueryClient();
  const { connected: boardSseConnected, eventTick } = useBoardEvents(projectName ?? '', true);

  const { data, isLoading, error } = useQuery({
    queryKey: ['board', projectName],
    queryFn: () => fetchBoard(projectName),
    enabled: !!projectName,
    refetchInterval: boardSseConnected ? false : 10_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (eventTick > 0) {
      void queryClient.invalidateQueries({ queryKey: ['board', projectName] });
    }
  }, [eventTick, projectName, queryClient]);

  const isMobile = useIsMobile();

  // Responsive-aware add-task visibility: desktop uses inline form, mobile uses full-screen Sheet.
  const [showAddTaskDesktop, setShowAddTaskDesktop] = useState(false);
  const [desktopDefaultColumn, setDesktopDefaultColumn] = useState('backlog');
  const [showAddTaskMobile, setShowAddTaskMobile] = useState(false);
  const [mobileDefaultColumn, setMobileDefaultColumn] = useState('backlog');
  const [showFindings, setShowFindings] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskName = searchParams.get('task') ?? null;
  const [sheetOpen, setSheetOpen] = useState(false);

  // Clear any add-task overlay that belongs to the other breakpoint when the
  // viewport crosses the threshold, so a mobile sheet cannot leak onto desktop.
  useEffect(() => {
    if (!isMobile) setShowAddTaskMobile(false);
    if (isMobile) setShowAddTaskDesktop(false);
  }, [isMobile]);

  // Toggle the add-task form for the current viewport.
  const toggleAddTask = (defaultColumn: string) => {
    if (isMobile) {
      if (showAddTaskMobile && mobileDefaultColumn === defaultColumn) {
        setShowAddTaskMobile(false);
      } else {
        setMobileDefaultColumn(defaultColumn);
        setShowAddTaskMobile(true);
        setSheetOpen(false);
      }
    } else {
      if (showAddTaskDesktop && desktopDefaultColumn === defaultColumn) {
        setShowAddTaskDesktop(false);
      } else {
        setDesktopDefaultColumn(defaultColumn);
        setShowAddTaskDesktop(true);
      }
    }
  };

  // Header trigger defaults to the backlog column.
  const handleAddTask = () => toggleAddTask('backlog');

  // Ideas-column trigger defaults to the ideas column on mobile (desktop keeps
  // its local inline form).
  const handleAddIdea = () => toggleAddTask('ideas');

  // Close mobile add-task overlay.
  const handleCloseAddTaskMobile = () => setShowAddTaskMobile(false);

  const allTasks: Task[] = data ? Object.values(data.columns).flat() : [];

  const invalidateBoard = () =>
    queryClient.invalidateQueries({ queryKey: ['board', projectName ?? ''] });

  const _deleteMutation = useMutation({
    mutationFn: (taskName: string) => deleteBoardTask(projectName, taskName),
    onSuccess: () => {
      invalidateBoard();
      setSearchParams({}, { replace: true });
      setSheetOpen(false);
    },
  });

  const _retryMutation = useMutation({
    mutationFn: (taskName: string) => retryEscalatedTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const _approveMutation = useMutation({
    mutationFn: (taskName: string) => approveTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const _requestChangesMutation = useMutation({
    mutationFn: ({ taskId, comment }: { taskId: string; comment: string }) =>
      requestChangesTask(projectName, taskId, comment),
    onSuccess: invalidateBoard,
  });

  useBoardNotifications(projectName ?? '', allTasks);

  const handleSelectTask = (name: string) => {
    setSearchParams({ task: name });
    // Only open the sheet on mobile (below md breakpoint).
    // On desktop the detail panel is rendered inline; opening the Sheet would
    // trigger its backdrop overlay even though SheetContent is hidden via CSS.
    if (isMobile) {
      setSheetOpen(true);
      // Enforce a single active mobile overlay path.
      setShowAddTaskMobile(false);
    }
  };

  const handleSheetClose = (open: boolean) => {
    setSheetOpen(open);
    if (!open) setSearchParams({}, { replace: true });
  };

  const rawApprovals = data?.approvals;
  const approvals = useMemo(() => rawApprovals, [rawApprovals]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!name) return null;

  if (isLoading && !data) return <p className="text-sm text-text-dim p-4">Loading board…</p>;
  if (error && !data) return <p className="text-sm text-phase-failed p-4">Failed to load board.</p>;
  if (!data) return <p className="text-sm text-phase-failed p-4">Failed to load board.</p>;

  const { settings, columns, status, authWarning } = data;
  const roster = (settings.agents ?? []).map((a: { name: string }) => a.name);

  const selectedTask: Task | undefined = selectedTaskName
    ? allTasks.find((t) => t.metadata.name === selectedTaskName)
    : undefined;

  const selectedCol: string | undefined = selectedTaskName
    ? Object.entries(columns).find(([, tasks]) =>
        tasks.some((t) => t.metadata.name === selectedTaskName),
      )?.[0]
    : undefined;

  const detailPanel =
    selectedTask && selectedCol ? (
      <TaskDetailPanel
        task={selectedTask}
        col={selectedCol}
        projectName={projectName}
        approvals={approvals}
        onDeleted={() => {
          setSearchParams({}, { replace: true });
          setSheetOpen(false);
        }}
      />
    ) : null;

  return (
    // Pull out of the parent p-6 padding so the board can fill the viewport correctly.
    <div className="-m-6 flex flex-col" style={{ height: 'calc(100svh - 3.5rem)' }}>
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border">
        <BoardHeader
          projectName={projectName}
          roster={roster}
          maxParallel={settings.maxParallel}
          phase={settings.phase}
          sseConnected={boardSseConnected}
          metrics={status.managerMetrics as ManagerMetrics | undefined}
          findings={status.findings}
          onAddTask={handleAddTask}
          showAddTask={showAddTaskDesktop || showAddTaskMobile}
          onToggleFindings={() => setShowFindings((f) => !f)}
          showFindings={showFindings}
          authWarning={authWarning}
          codeServerUrl={data.codeServerUrl}
        />
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Task list — full width on mobile, constrained on desktop when detail is open */}
        <div
          className={`flex flex-col min-h-0 w-full ${selectedTask ? 'md:w-2/5 md:border-r md:border-border' : ''}`}
        >
          <TaskListPanel
            projectName={projectName}
            columns={columns}
            roster={roster}
            selectedTaskName={selectedTaskName}
            onSelectTask={handleSelectTask}
            showAddTask={showAddTaskDesktop}
            addTaskDefaultColumn={desktopDefaultColumn}
            onCloseAddTask={() => setShowAddTaskDesktop(false)}
            onAddIdea={handleAddIdea}
            renderInlineAddTask={!isMobile}
            approvals={approvals}
          />
        </div>

        {/* Desktop detail panel — hidden on mobile */}
        <div className="hidden md:flex flex-col flex-1 min-h-0">
          {detailPanel ?? <TaskDetailEmpty />}
        </div>

        {/* Desktop findings panel — shown when toggled */}
        {showFindings && (
          <div className="hidden md:flex flex-col w-80 border-l border-border bg-surface overflow-hidden">
            <FindingsPanel findings={status.findings ?? []} projectName={projectName} />
          </div>
        )}
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

      {/* Mobile findings Sheet */}
      <Sheet
        open={showFindings && isMobile}
        onOpenChange={(open) => {
          if (!open) setShowFindings(false);
        }}
      >
        <SheetContent
          side="right"
          className="md:hidden w-full sm:max-w-lg p-0 flex flex-col overflow-hidden bg-surface text-text border-border [&>button]:z-10"
        >
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <FindingsPanel
              findings={status.findings ?? []}
              projectName={projectName}
              onClose={() => setShowFindings(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile full-screen add-task overlay */}
      <Sheet open={showAddTaskMobile} onOpenChange={setShowAddTaskMobile}>
        <SheetContent
          side="bottom"
          className="md:hidden w-screen max-w-none h-svh p-0 border-border [&>button]:z-10"
        >
          <div className="flex flex-col h-full min-h-0">
            {/* Accessibility title/description for the sheet; visually hidden
                because the form itself already renders a visible heading. */}
            <div className="sr-only">
              <SheetHeader>
                <SheetTitle>{mobileDefaultColumn === 'ideas' ? 'Add idea' : 'Add task'}</SheetTitle>
                <SheetDescription>
                  Create a new board task in the {mobileDefaultColumn} column.
                </SheetDescription>
              </SheetHeader>
            </div>
            {/* Scrollable inner region */}
            <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8 space-y-3">
              <AddTaskForm
                projectName={projectName}
                roster={roster}
                defaultColumn={mobileDefaultColumn}
                onClose={handleCloseAddTaskMobile}
                className="rounded-none border-0 shadow-none bg-transparent mx-0"
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
