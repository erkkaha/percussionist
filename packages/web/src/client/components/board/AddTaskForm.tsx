// AddTaskForm.tsx — inline/full-screen add-task form for board tasks.
//
// Shared between TaskListPanel (desktop inline) and BoardView mobile Sheet.
// Preserves the original mutation contract (addBoardTask) and required-field
// validation (title + agent).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { addBoardTask } from '../../lib/api';
import type { Task } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

export interface AddTaskFormProps {
  projectName: string;
  roster: string[];
  defaultColumn?: string;
  onClose: () => void;
  className?: string;
}

export function AddTaskForm({
  projectName,
  roster,
  defaultColumn = 'backlog',
  onClose,
  className,
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
    <div className={cn('rounded-md border border-border bg-surface p-4 space-y-3', className)}>
      <h2 className="text-sm font-semibold">
        Add Task {defaultColumn === 'ideas' ? 'to Ideas' : 'to Backlog'}
      </h2>

      {/* Type */}
      <RadioGroup
        value={taskType}
        onValueChange={(v) => setTaskType(v as 'PLAN' | 'BUILD')}
        className="flex gap-4"
      >
        {(['PLAN', 'BUILD'] as const).map((t) => (
          <label key={t} className="flex items-center gap-2 cursor-pointer text-sm">
            <RadioGroupItem value={t} id={`type-${t}`} />
            <span>{t}</span>
          </label>
        ))}
      </RadioGroup>

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
