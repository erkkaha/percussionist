import { AlertTriangle, Database, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useCreateMemory,
  useDeleteMemory,
  useProjectMemories,
  useUpdateMemory,
} from '../../hooks/useProjectMemories';
import type { ProjectMemory } from '../../lib/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../ui/sheet';
import { Textarea } from '../ui/textarea';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function formatMetadata(meta: Record<string, unknown> | null): string {
  try {
    return meta ? JSON.stringify(meta, null, 2) : '{}';
  } catch {
    return '{}';
  }
}

function validateJson(text: string): { valid: boolean; error?: string } {
  if (!text.trim()) return { valid: true };
  try {
    JSON.parse(text);
    return { valid: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid JSON';
    return { valid: false, error: msg };
  }
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return d;
  }
}

// ---------------------------------------------------------------------------
// Memory form fields (shared between create and edit)
// ---------------------------------------------------------------------------

interface MemoryFormFields {
  content: string;
  metadataText: string;
  jsonError?: string;
}

function emptyMemoryForm(): MemoryFormFields {
  return { content: '', metadataText: '{}' };
}

// ---------------------------------------------------------------------------
// Create / Edit Sheet
// ---------------------------------------------------------------------------

interface MemorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: ProjectMemory | null;
  project: string;
}

function MemoryFormSheet({ open, onOpenChange, mode, initial, project }: MemorySheetProps) {
  const [fields, setFields] = useState<MemoryFormFields>(() => {
    if (mode === 'edit' && initial) {
      return {
        content: initial.content,
        metadataText: formatMetadata(initial.metadata),
      };
    }
    return emptyMemoryForm();
  });

  const jsonValidation = useMemo(() => validateJson(fields.metadataText), [fields.metadataText]);

  const createMutation = useCreateMemory(project);
  const updateMutation = useUpdateMemory(project);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fields.content.trim()) return;
    if (jsonValidation.error) return;

    const metadata = fields.metadataText.trim()
      ? (JSON.parse(fields.metadataText) as Record<string, unknown>)
      : undefined;

    if (mode === 'edit' && initial) {
      updateMutation.mutate(
        { id: initial.id, req: { content: fields.content, metadata } },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    } else {
      createMutation.mutate(
        { content: fields.content, metadata },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setFields(emptyMemoryForm());
      }}
    >
      <SheetContent className="w-[90vw] sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{mode === 'create' ? 'Create Memory' : 'Edit Memory'}</SheetTitle>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Content */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">Content</label>
            <Textarea
              value={fields.content}
              onChange={(e) => setFields((f) => ({ ...f, content: e.target.value }))}
              placeholder="The core memory content — what the agent should remember…"
              rows={5}
              required
            />
          </div>

          {/* Metadata */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-muted">
              Metadata <span className="font-normal text-text-dim">(optional JSON)</span>
            </label>
            <Textarea
              value={fields.metadataText}
              onChange={(e) => setFields((f) => ({ ...f, metadataText: e.target.value }))}
              placeholder='{"tags": ["context"], "source": "session"}'
              rows={3}
              className="font-mono text-xs"
            />
            {jsonValidation.error && (
              <p className="text-xs text-error">Invalid JSON: {jsonValidation.error}</p>
            )}
          </div>

          {/* Actions */}
          <SheetFooter className="pt-2">
            <SheetClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </SheetClose>
            <Button
              type="submit"
              disabled={
                !fields.content.trim() ||
                !!jsonValidation.error ||
                createMutation.isPending ||
                updateMutation.isPending
              }
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {mode === 'create' ? 'Create' : 'Save'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog (inline, no external library)
// ---------------------------------------------------------------------------

interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memoryId: string;
  project: string;
}

function DeleteConfirmDialog({ open, onOpenChange, memoryId, project }: DeleteConfirmProps) {
  const deleteMutation = useDeleteMemory(project);

  function handleDelete() {
    deleteMutation.mutate(memoryId, {
      onSuccess: () => onOpenChange(false),
    });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        role="button"
        tabIndex={0}
        className="absolute inset-0 bg-black/60"
        onClick={() => onOpenChange(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === ' ') onOpenChange(false);
        }}
      />
      {/* Dialog */}
      <div className="relative w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-text">Delete Memory</h3>
            <p className="mt-1 text-xs text-text-dim leading-relaxed">
              This action cannot be undone. The memory record and its embedding vector will be
              permanently removed.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteMutation.isPending}
            onClick={handleDelete}
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Deleting…
              </>
            ) : (
              'Delete'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory card
// ---------------------------------------------------------------------------

interface MemoryCardProps {
  memory: ProjectMemory;
  onEdit: () => void;
  onDelete: () => void;
}

function MemoryCard({ memory, onEdit, onDelete }: MemoryCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-container p-4 space-y-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text leading-relaxed line-clamp-3">
            {truncate(memory.content, 280)}
          </p>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onEdit}
            title="Edit memory"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-error hover:text-error/80 hover:bg-error-container"
            onClick={onDelete}
            title="Delete memory"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 flex-wrap">
        {memory.metadata && Object.keys(memory.metadata).length > 0 && (
          <Badge variant="secondary" className="text-xs font-normal">
            {Object.keys(memory.metadata).join(', ')}
          </Badge>
        )}
        <span className="text-xs text-text-dim">{formatDate(memory.createdAt)}</span>
      </div>

      {/* Full content (expandable) */}
      {memory.content.length > 280 && (
        <details className="mt-1">
          <summary className="text-xs text-accent cursor-pointer hover:underline select-none">
            Show full content
          </summary>
          <p className="mt-1 text-xs text-text-dim whitespace-pre-wrap leading-relaxed">
            {memory.content}
          </p>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Database className="h-10 w-10 text-text-dim mb-3" />
      <p className="text-sm font-medium text-text-muted">No memories yet</p>
      <p className="text-xs text-text-dim mt-1 max-w-xs leading-relaxed">
        Memories are persistent context records that agents can retrieve during runs. Create one to
        give your agents shared knowledge across sessions.
      </p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        Create first memory
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="space-y-3 py-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-surface-container p-4 animate-pulse"
        >
          <div className="h-4 bg-border rounded w-3/4 mb-2" />
          <div className="h-3 bg-border rounded w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container">
      <p>{error}</p>
      <Button
        variant="link"
        size="sm"
        className="mt-2 p-0 h-auto text-xs underline"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create mode guidance (shown when editing a new project)
// ---------------------------------------------------------------------------

function CreateModeGuidance() {
  return (
    <div className="rounded-md border border-border bg-surface-container p-5 space-y-2">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-text-dim" />
        <p className="text-sm font-medium text-text-muted">Memories</p>
      </div>
      <p className="text-xs text-text-dim leading-relaxed">
        Memories are persistent context records stored in the project&apos;s vector memory service.
        They give agents shared knowledge across runs — useful for project conventions, past
        decisions, and reusable context snippets.
      </p>
      <p className="text-xs text-text-dim leading-relaxed">
        Memory management (create, edit, delete) is available after the project is created. Enable
        the memory service in the{' '}
        <span className="font-medium text-text-muted">Workspace &amp; Services</span> tab to
        activate it.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main MemoriesTab component
// ---------------------------------------------------------------------------

interface MemoriesTabProps {
  isEdit: boolean;
  projectName?: string;
}

export default function MemoriesTab({ isEdit, projectName }: MemoriesTabProps) {
  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectMemory | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch memories (only in edit mode)
  const { data, isLoading, error, refetch } = useProjectMemories(isEdit ? projectName : undefined);

  const memories = data?.memories ?? [];
  const total = data?.total ?? 0;

  // Filter by search query (client-side on content + metadata keys)
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const q = searchQuery.toLowerCase();
    return memories.filter((m) => {
      if (m.content.toLowerCase().includes(q)) return true;
      if (m.metadata && Object.keys(m.metadata).some((k) => k.toLowerCase().includes(q)))
        return true;
      return false;
    });
  }, [memories, searchQuery]);

  // Open edit sheet
  function openEdit(memory: ProjectMemory) {
    setEditTarget(memory);
    setSheetOpen(true);
  }

  // Open create sheet
  function openCreate() {
    setEditTarget(null);
    setSheetOpen(true);
  }

  // Delete handler
  function requestDelete(id: string) {
    setDeleteTargetId(id);
  }

  return (
    <div className="space-y-4">
      {/* Section header */}
      <fieldset className="rounded-md border border-border p-4 space-y-3">
        <legend className="px-1 text-sm font-medium text-text-muted">Project Memories</legend>
        <p className="text-xs text-text-dim leading-relaxed">
          Manage stored memories for this project. Memories are injected into agent prompts as
          relevant context during runs. The memory service must be enabled in the{' '}
          <span className="font-medium text-text-muted">Workspace &amp; Services</span> tab.
        </p>

        {/* Create mode guidance */}
        {!isEdit && !projectName ? <CreateModeGuidance /> : null}

        {/* Edit mode: CRUD panel */}
        {isEdit && projectName && (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-dim" />
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search memories…"
                  className="pl-9"
                />
              </div>
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Create
              </Button>
            </div>

            {/* Content area */}
            {isLoading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState
                error={error.message ?? 'Failed to load memories'}
                onRetry={() => refetch()}
              />
            ) : filtered.length === 0 && total === 0 ? (
              <EmptyState onCreate={openCreate} />
            ) : filtered.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-text-dim">
                  No memories match &ldquo;{searchQuery}&rdquo;
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {filtered.map((m) => (
                    <MemoryCard
                      key={m.id}
                      memory={m}
                      onEdit={() => openEdit(m)}
                      onDelete={() => requestDelete(m.id)}
                    />
                  ))}
                </div>
                {total > filtered.length && (
                  <p className="text-xs text-text-dim text-center pt-1">
                    Showing {filtered.length} of {total} memories
                  </p>
                )}
              </>
            )}
          </>
        )}
      </fieldset>

      {/* Create / Edit Sheet */}
      <MemoryFormSheet
        open={sheetOpen}
        onOpenChange={(v) => {
          setSheetOpen(v);
          if (!v) setEditTarget(null);
        }}
        mode={editTarget ? 'edit' : 'create'}
        initial={editTarget}
        project={projectName ?? ''}
      />

      {/* Delete confirmation */}
      <DeleteConfirmDialog
        open={deleteTargetId !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTargetId(null);
        }}
        memoryId={deleteTargetId ?? ''}
        project={projectName ?? ''}
      />
    </div>
  );
}
