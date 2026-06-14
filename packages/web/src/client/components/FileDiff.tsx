import { ChevronDown, ChevronRight, File, GitCommit } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ChangeData, FileData, GutterOptions } from 'react-diff-view';
import {
  Diff,
  findChangeByNewLineNumber,
  findChangeByOldLineNumber,
  getChangeKey,
  Hunk,
  parseDiff,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import {
  DIFF_FINDING_SEVERITIES,
  normalizeAnchorPath,
  SEVERITY_BG_CLASS,
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL,
  SEVERITY_RANK,
} from '../lib/diff-findings';
import type { DiffFindingSeverity, TaskDiffFinding } from '../lib/types';

interface FileDiffProps {
  filename: string;
  path?: string;
  diff?: string;
  beforeContent?: string;
  afterContent?: string;
  findings?: TaskDiffFinding[];
}

function SeverityBadge({ severity }: { severity: DiffFindingSeverity }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase border ${SEVERITY_BG_CLASS[severity]}`}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export function FileDiff({ filename, path, diff, findings }: FileDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');

  const displayPath = path || filename;

  const { parsedFiles, addedLines, removedLines } = useMemo(() => {
    let files: FileData[] = [];
    let added = 0;
    let removed = 0;

    try {
      if (diff) {
        files = parseDiff(diff);
        const file = files[0];
        if (file) {
          for (const hunk of file.hunks) {
            for (const change of hunk.changes) {
              if (change.type === 'insert') added++;
              if (change.type === 'delete') removed++;
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to parse diff:', err);
    }

    return { parsedFiles: files, addedLines: added, removedLines: removed };
  }, [diff]);

  const fileData = parsedFiles[0];
  const hasValidDiff = parsedFiles.length > 0;

  const fileFindings = useMemo(() => {
    return (
      findings?.filter((finding) =>
        finding.anchors.some(
          (anchor) => normalizeAnchorPath(anchor.path) === normalizeAnchorPath(displayPath),
        ),
      ) ?? []
    );
  }, [findings, displayPath]);

  const { markers, unmappedFindings } = useMemo(() => {
    const markers = new Map<string, { severity: DiffFindingSeverity; titles: string[] }>();
    const unmapped: TaskDiffFinding[] = [];

    if (!fileData) {
      return { markers, unmappedFindings: unmapped };
    }

    for (const finding of fileFindings) {
      let anyMapped = false;

      for (const anchor of finding.anchors) {
        if (normalizeAnchorPath(anchor.path) !== normalizeAnchorPath(displayPath)) {
          continue;
        }

        const side = anchor.side;
        const start = anchor.line;
        const end = anchor.endLine ?? start;

        for (let line = start; line <= end; line++) {
          const change =
            side === 'old'
              ? findChangeByOldLineNumber(fileData.hunks, line)
              : findChangeByNewLineNumber(fileData.hunks, line);

          if (change) {
            anyMapped = true;
            const key = `${side}:${getChangeKey(change)}`;
            const existing = markers.get(key);

            if (!existing || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
              markers.set(key, {
                severity: finding.severity,
                titles: existing ? [finding.title, ...existing.titles] : [finding.title],
              });
            } else {
              existing.titles.push(finding.title);
            }
          }
        }
      }

      if (!anyMapped) {
        unmapped.push(finding);
      }
    }

    return { markers, unmappedFindings: unmapped };
  }, [fileData, fileFindings, displayPath]);

  const severityCounts = useMemo(() => {
    return DIFF_FINDING_SEVERITIES.map((severity) => ({
      severity,
      count: fileFindings.filter((f) => f.severity === severity).length,
    })).filter(({ count }) => count > 0);
  }, [fileFindings]);

  const renderGutter = ({ change, side, renderDefault }: GutterOptions) => {
    const key = `${side}:${getChangeKey(change as ChangeData)}`;
    const marker = markers.get(key);

    return (
      <span className="flex items-center gap-1">
        {marker && (
          <span
            className={`inline-block rounded-full ${SEVERITY_DOT_CLASS[marker.severity]}`}
            style={{ width: 6, height: 6 }}
            title={marker.titles.join('\n')}
          />
        )}
        {renderDefault()}
      </span>
    );
  };

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
        {severityCounts.length > 0 && (
          <div className="flex items-center gap-1.5">
            {severityCounts.map(({ severity, count }) => (
              <span
                key={severity}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border ${SEVERITY_BG_CLASS[severity]}`}
                title={`${count} ${SEVERITY_LABEL[severity].toLowerCase()} finding${count === 1 ? '' : 's'}`}
              >
                <span
                  className={`inline-block rounded-full ${SEVERITY_DOT_CLASS[severity]}`}
                  style={{ width: 5, height: 5 }}
                />
                {count}
              </span>
            ))}
          </div>
        )}
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
                {parsedFiles.map((file) => (
                  <Diff
                    key={file.newPath ?? file.oldPath}
                    viewType={viewType}
                    diffType={file.type}
                    hunks={file.hunks}
                    renderGutter={renderGutter}
                  >
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

          {unmappedFindings.length > 0 && (
            <div className="border-t border-border-muted bg-surface px-3 py-2 space-y-2">
              <p className="text-xs font-medium text-text-dim">
                Unmapped findings ({unmappedFindings.length})
              </p>
              <div className="space-y-1.5">
                {unmappedFindings.map((finding) => (
                  <div
                    key={finding.id}
                    className="rounded border border-border-muted bg-surface-overlay/20 px-2.5 py-1.5 space-y-1"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <SeverityBadge severity={finding.severity} />
                      {finding.isStale && (
                        <span className="text-[10px] uppercase text-text-dim/70">stale</span>
                      )}
                      <span className="text-xs font-medium text-text">{finding.title}</span>
                    </div>
                    <p className="text-xs text-text-dim leading-relaxed">{finding.comment}</p>
                    <p className="text-[10px] text-text-dim/60 font-mono">
                      {finding.anchors
                        .map(
                          (a) =>
                            `${normalizeAnchorPath(a.path)}:${a.side}:${a.line}${a.endLine ? `-${a.endLine}` : ''}`,
                        )
                        .join(', ')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
