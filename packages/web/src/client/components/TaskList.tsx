import { CheckCircle, ChevronDown, ChevronRight, Circle, Clock, XCircle } from 'lucide-react';
import { useState } from 'react';

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

interface TaskListProps {
  todos: Todo[];
}

export function TaskList({ todos }: TaskListProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['in_progress', 'pending']),
  );

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  // Group todos by status
  const grouped = {
    in_progress: todos.filter((t) => t.status === 'in_progress'),
    pending: todos.filter((t) => t.status === 'pending'),
    completed: todos.filter((t) => t.status === 'completed'),
    cancelled: todos.filter((t) => t.status === 'cancelled'),
  };

  const completed = grouped.completed.length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  const getStatusIcon = (status: Todo['status']) => {
    switch (status) {
      case 'completed':
        return CheckCircle;
      case 'in_progress':
        return Clock;
      case 'cancelled':
        return XCircle;
      default:
        return Circle;
    }
  };

  const getStatusColor = (status: Todo['status']) => {
    switch (status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400';
      case 'in_progress':
        return 'text-blue-600 dark:text-blue-400';
      case 'cancelled':
        return 'text-gray-600 dark:text-gray-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  const getPriorityColor = (priority: Todo['priority']) => {
    switch (priority) {
      case 'high':
        return 'text-red-600 dark:text-red-400';
      case 'medium':
        return 'text-yellow-600 dark:text-yellow-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  return (
    <div className="rounded-lg border border-border-muted bg-surface p-3 space-y-2">
      {/* Header with progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text">Tasks</span>
          <span className="text-xs text-text-dim">
            {completed} of {total} completed
          </span>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-surface-overlay rounded-full h-1.5">
          <div
            className="bg-green-600 dark:bg-green-400 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Task groups */}
      <div className="space-y-1">
        {/* In Progress */}
        {grouped.in_progress.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleSection('in_progress')}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-surface-overlay/30 transition-colors"
            >
              {expandedSections.has('in_progress') ? (
                <ChevronDown className="h-3 w-3 text-text-dim" />
              ) : (
                <ChevronRight className="h-3 w-3 text-text-dim" />
              )}
              <span className="text-xs font-medium text-text">
                In Progress ({grouped.in_progress.length})
              </span>
            </button>
            {expandedSections.has('in_progress') && (
              <div className="ml-5 space-y-1 mt-1">
                {grouped.in_progress.map((todo, i) => {
                  const Icon = getStatusIcon(todo.status);
                  return (
                    <div key={i} className="flex items-start gap-2 px-2 py-1 rounded text-xs">
                      <Icon
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${getStatusColor(todo.status)}`}
                      />
                      <span className={`flex-1 ${getPriorityColor(todo.priority)}`}>
                        {todo.content}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Pending */}
        {grouped.pending.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleSection('pending')}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-surface-overlay/30 transition-colors"
            >
              {expandedSections.has('pending') ? (
                <ChevronDown className="h-3 w-3 text-text-dim" />
              ) : (
                <ChevronRight className="h-3 w-3 text-text-dim" />
              )}
              <span className="text-xs font-medium text-text">
                Pending ({grouped.pending.length})
              </span>
            </button>
            {expandedSections.has('pending') && (
              <div className="ml-5 space-y-1 mt-1">
                {grouped.pending.map((todo, i) => {
                  const Icon = getStatusIcon(todo.status);
                  return (
                    <div key={i} className="flex items-start gap-2 px-2 py-1 rounded text-xs">
                      <Icon
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${getStatusColor(todo.status)}`}
                      />
                      <span className={`flex-1 ${getPriorityColor(todo.priority)}`}>
                        {todo.content}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Completed */}
        {grouped.completed.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleSection('completed')}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-surface-overlay/30 transition-colors"
            >
              {expandedSections.has('completed') ? (
                <ChevronDown className="h-3 w-3 text-text-dim" />
              ) : (
                <ChevronRight className="h-3 w-3 text-text-dim" />
              )}
              <span className="text-xs font-medium text-text">
                Completed ({grouped.completed.length})
              </span>
            </button>
            {expandedSections.has('completed') && (
              <div className="ml-5 space-y-1 mt-1">
                {grouped.completed.map((todo, i) => {
                  const Icon = getStatusIcon(todo.status);
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 px-2 py-1 rounded text-xs opacity-70"
                    >
                      <Icon
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${getStatusColor(todo.status)}`}
                      />
                      <span className="flex-1 line-through text-text-dim">{todo.content}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Cancelled */}
        {grouped.cancelled.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleSection('cancelled')}
              className="flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-surface-overlay/30 transition-colors"
            >
              {expandedSections.has('cancelled') ? (
                <ChevronDown className="h-3 w-3 text-text-dim" />
              ) : (
                <ChevronRight className="h-3 w-3 text-text-dim" />
              )}
              <span className="text-xs font-medium text-text">
                Cancelled ({grouped.cancelled.length})
              </span>
            </button>
            {expandedSections.has('cancelled') && (
              <div className="ml-5 space-y-1 mt-1">
                {grouped.cancelled.map((todo, i) => {
                  const Icon = getStatusIcon(todo.status);
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 px-2 py-1 rounded text-xs opacity-70"
                    >
                      <Icon
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${getStatusColor(todo.status)}`}
                      />
                      <span className="flex-1 line-through text-text-dim">{todo.content}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
