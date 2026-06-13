// TaskListPanel.tsx — scrollable grouped task list with filter bar.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Filter, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { addBoardTask } from '../../lib/api';
import type { Task } from '../../lib/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import type { FilterState } from './FilterBar';
import { FilterBar } from './FilterBar';
import { TaskRow } from './TaskRow';

const DEFAULT_COLUMNS = ['ideas', 'backlog', 'blocked', 'in-progress', 'review', 'done'] as const;

interface AddTaskFormProps {
  projectName: string;
  roster: string[];
  defaultColumn?: string;
  onClose: () => void;
}

function AddTaskForm({
  projectName,
  roster,
  defaultColumn = 'backlog',
  onClose,
}: AddTaskFormProps) {
  const queryClient = useQueryClient();
  const [taskType, setTaskType] = useState<'PLAN' | 'BUILD'>('PLAN');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskAgent, setTaskAgent] = useState('');
  const [taskPriority, setTaskPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: async (task: {
      type: string;
      title: string;
      description?: string;
      agent: string;
      priority?: string;
    }) => addBoardTask(projectName, { ...task, column: defaultColumn }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['board', projectName] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3 mx-2">
      <h2 className="text-sm font-semibold">
        Add Task {defaultColumn === 'ideas' ? 'to Ideas' : 'to Backlog'}
      </h2>

      {/* Type */}
      <div className="flex gap-4">
        {(['PLAN', 'BUILD'] as const).map((t) => (
          <label key={t} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value={t}
              checked={taskType === t}
              onChange={() => setTaskType(t)}
              className="cursor-pointer"
            />
            <span className="text-sm">{t}</span>
          </label>
        ))}
      </div>

      {/* Agent */}
      {roster.length === 0 ? (
        <p className="text-xs text-phase-failed">
          No agents in roster.{' '}
          <Link
            to={`/projects/${encodeURIComponent(projectName)}/edit`}
            className="underline hover:opacity-80"
          >
            Add agents first.
          </Link>
        </p>
      ) : (
        <Select value={taskAgent} onValueChange={(v) => setTaskAgent(v)}>
          <SelectTrigger>
            <SelectValue placeholder="— agent —" />
          </SelectTrigger>
          <SelectContent>
            {roster.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Input placeholder="Title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />

      <Textarea
        placeholder="Description (optional, supports Markdown)"
        value={taskDesc}
        onChange={(e) => setTaskDesc(e.target.value)}
        rows={3}
      />

      <div className="flex items-center gap-3">
        <Select
          value={taskPriority}
          onValueChange={(v) => setTaskPriority(v as 'high' | 'medium' | 'low')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={() => {
            if (!taskTitle.trim() || !taskAgent) {
              setError('Title and agent required');
              return;
            }
            addMutation.mutate({
              type: taskType,
              title: taskTitle.trim(),
              description: taskDesc.trim() || undefined,
              agent: taskAgent,
              priority: taskPriority,
            });
          }}
          disabled={addMutation.isPending}
        >
          {addMutation.isPending ? 'Adding…' : 'Add'}
        </Button>
        <button
          onClick={onClose}
          className="text-sm text-text-dim hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-phase-failed">{error}</p>}
    </div>
  );
}

interface TaskListPanelProps {
  projectName: string;
  columns: Record<string, Task[]>;
  roster: string[];
  selectedTaskName: string | null;
  onSelectTask: (name: string) => void;
  showAddTask: boolean;
  onCloseAddTask: () => void;
  approvals?: Record<string, { approved: boolean; requestChanges: boolean }>;
}

export function TaskListPanel({
  projectName,
  columns,
  roster,
  selectedTaskName,
  onSelectTask,
  showAddTask,
  onCloseAddTask,
  approvals,
}: TaskListPanelProps) {
  const [filters, setFilters] = useState<FilterState>({
    column: 'all',
    search: '',
    type: 'all',
    priority: 'all',
  });

  const [filterVisible, setFilterVisible] = useState(true);

  // Collapsed state per column
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    ideas: true,
    done: true,
  });

  // Inline add-to-ideas form state
  const [showAddIdea, setShowAddIdea] = useState(false);

  const toggleCollapsed = (col: string) => setCollapsed((p) => ({ ...p, [col]: !p[col] }));

  // Column counts for filter bar
  const columnCounts = Object.fromEntries(
    DEFAULT_COLUMNS.map((col) => [col, (columns[col] ?? []).length]),
  );

  // Filter tasks
  const searchLower = filters.search.toLowerCase();
  function matchesFilters(task: Task, col: string): boolean {
    if (filters.column !== 'all' && col !== filters.column) return false;
    if (filters.type !== 'all' && task.spec.type !== filters.type) return false;
    if (filters.priority !== 'all' && task.spec.priority !== filters.priority) return false;
    if (filters.search) {
      const haystack =
        `${task.spec.title} ${task.metadata.name} ${task.spec.description ?? ''} ${task.spec.agent ?? ''}`.toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  }

  const isFiltering =
    filters.column !== 'all' ||
    filters.search ||
    filters.type !== 'all' ||
    filters.priority !== 'all';

  // Build filtered column map
  const filteredColumns = DEFAULT_COLUMNS.map((col) => ({
    col,
    tasks: (columns[col] ?? []).filter((t) => matchesFilters(t, col)),
  })).filter(({ tasks, col }) => {
    // Always show ideas when the ideas tab is active so the + button is reachable.
    if (col === 'ideas' && filters.column === 'ideas') return true;
    if (isFiltering && tasks.length === 0) return false;
    if (!isFiltering && tasks.length === 0 && collapsed[col] !== false) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 pt-2 pb-2 shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-dim">Filters</span>
          <button
            onClick={() => setFilterVisible(!filterVisible)}
            className="text-text-dim hover:text-text transition-colors p-0.5"
            title={filterVisible ? 'Hide filters' : 'Show filters'}
          >
            {filterVisible ? <X className="h-3.5 w-3.5" /> : <Filter className="h-3.5 w-3.5" />}
          </button>
        </div>
        {filterVisible && (
          <FilterBar filters={filters} onChange={setFilters} columnCounts={columnCounts} />
        )}
        {!filterVisible && isFiltering && (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-xs text-text-dim">Active filters</span>
          </div>
        )}
      </div>

      {showAddTask && (
        <div className="pb-2 shrink-0">
          <AddTaskForm projectName={projectName} roster={roster} onClose={onCloseAddTask} />
        </div>
      )}

      {/* Scrollable task list */}
      <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-3">
        {filteredColumns.length === 0 && (
          <p className="text-xs text-text-dim px-1 py-4 text-center italic">
            No tasks match filters.
          </p>
        )}
        {filteredColumns.map(({ col, tasks }) => {
          const isCollapsed = collapsed[col] ?? false;
          const allColTasks = columns[col] ?? [];
          return (
            <div key={col}>
              {/* Column header */}
              <div className="w-full flex items-center justify-between px-1 py-1 group">
                <button
                  onClick={() => toggleCollapsed(col)}
                  className="flex-1 flex items-center justify-between"
                >
                  <span className="text-label-md font-mono uppercase text-text-dim group-hover:text-text transition-colors">
                    {col}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-dim tabular-nums">{allColTasks.length}</span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-text-dim transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
                    />
                  </div>
                </button>
                {col === 'ideas' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAddIdea((v) => !v);
                      if (isCollapsed) toggleCollapsed(col);
                    }}
                    className="ml-2 p-0.5 rounded text-text-dim hover:text-text transition-colors"
                    title="Add idea"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {col === 'ideas' && showAddIdea && !isCollapsed && (
                <div className="pb-2">
                  <AddTaskForm
                    projectName={projectName}
                    roster={roster}
                    defaultColumn="ideas"
                    onClose={() => setShowAddIdea(false)}
                  />
                </div>
              )}

              {!isCollapsed && (
                <div className="space-y-0.5">
                  {tasks.length === 0 && !isFiltering ? (
                    <p className="text-xs text-text-dim italic px-1 py-1">empty</p>
                  ) : (
                    [...tasks]
                      .sort((a, b) => {
                        const aTime =
                          a.status?.worker?.completedAt ??
                          a.status?.worker?.startedAt ??
                          a.metadata.creationTimestamp ??
                          '';
                        const bTime =
                          b.status?.worker?.completedAt ??
                          b.status?.worker?.startedAt ??
                          b.metadata.creationTimestamp ??
                          '';
                        return String(bTime).localeCompare(String(aTime));
                      })
                      .map((task) => (
                        <TaskRow
                          key={task.metadata.name}
                          task={task}
                          col={col}
                          isSelected={selectedTaskName === task.metadata.name}
                          onClick={() => onSelectTask(task.metadata.name)}
                          projectName={projectName}
                          approvals={approvals}
                        />
                      ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
