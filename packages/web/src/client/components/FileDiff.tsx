import { ChevronDown, ChevronRight, File, GitCommit } from 'lucide-react';
import { useState } from 'react';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface FileDiffProps {
  filename: string;
  path?: string;
  diff?: string;
  beforeContent?: string;
  afterContent?: string;
}

export function FileDiff({ filename, path, diff, beforeContent, afterContent }: FileDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');

  // Parse the diff
  let files: ReturnType<typeof parseDiff> = [];
  let addedLines = 0;
  let removedLines = 0;

  try {
    if (diff) {
      files = parseDiff(diff);
      // Calculate stats from first file
      if (files.length > 0) {
        const file = files[0];
        if (file) {
          file.hunks.forEach((hunk) => {
            hunk.changes.forEach((change) => {
              if (change.type === 'insert') addedLines++;
              if (change.type === 'delete') removedLines++;
            });
          });
        }
      }
    }
  } catch (err) {
    console.error('Failed to parse diff:', err);
  }

  const displayPath = path || filename;
  const hasValidDiff = files.length > 0;

  return (
    <div className="rounded-lg border border-border-muted bg-surface overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-surface-overlay/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-text-dim" />
        ) : (
          <ChevronRight className="h-4 w-4 text-text-dim" />
        )}
        <File className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        <span className="text-sm font-mono text-text flex-1 text-left truncate">{displayPath}</span>
        {hasValidDiff && (
          <div className="flex items-center gap-2 text-xs">
            <GitCommit className="h-3 w-3 text-text-dim" />
            {addedLines > 0 && (
              <span className="text-green-600 dark:text-green-400">+{addedLines}</span>
            )}
            {removedLines > 0 && (
              <span className="text-red-600 dark:text-red-400">-{removedLines}</span>
            )}
          </div>
        )}
      </button>

      {/* Diff content */}
      {expanded && (
        <div className="border-t border-border-muted">
          {hasValidDiff ? (
            <div className="bg-surface-sunken">
              {/* View type toggle */}
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-muted bg-surface">
                <button
                  type="button"
                  onClick={() => setViewType('unified')}
                  className={`px-2 py-1 text-xs rounded ${
                    viewType === 'unified'
                      ? 'bg-surface-raised text-text font-medium'
                      : 'text-text-dim hover:text-text'
                  }`}
                >
                  Unified
                </button>
                <button
                  type="button"
                  onClick={() => setViewType('split')}
                  className={`px-2 py-1 text-xs rounded ${
                    viewType === 'split'
                      ? 'bg-surface-raised text-text font-medium'
                      : 'text-text-dim hover:text-text'
                  }`}
                >
                  Split
                </button>
              </div>

              {/* Diff view */}
              <div className="overflow-x-auto text-xs font-mono">
                {files.map((file, i) => (
                  <Diff key={i} viewType={viewType} diffType={file.type} hunks={file.hunks}>
                    {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                  </Diff>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-text-dim italic">
              {diff ? 'Failed to parse diff' : 'File modified (no diff available)'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
