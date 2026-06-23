// OrphanFindings.tsx — renders findings whose anchored file is NOT part of the
// diff (e.g. a reviewer flagged a required deletion/edit that never happened).
// Such findings have no file in the unified diff to attach to, so without this
// they were silently counted in the summary but never displayed. Here we show
// the finding alongside the file's current contents at HEAD, with the anchored
// lines highlighted, so the reviewer has real context.

import { AlertTriangle } from 'lucide-react';
import { normalizeAnchorPath } from '../lib/diff-findings';
import type { OrphanFindingFile, TaskDiffFinding } from '../lib/types';
import { SeverityBadge } from './FileDiff';

interface OrphanFindingsProps {
  /** Findings already determined to reference no file in the diff. */
  findings: TaskDiffFinding[];
  orphanFiles?: OrphanFindingFile[];
}

function FindingSnippet({ file, finding }: { file: OrphanFindingFile; finding: TaskDiffFinding }) {
  const lines = file.content.replace(/\n$/, '').split('\n');
  const ranges = finding.anchors
    .filter((a) => normalizeAnchorPath(a.path) === normalizeAnchorPath(file.path))
    .map((a) => ({ start: a.line, end: a.endLine ?? a.line }));
  const isHighlighted = (lineNo: number) =>
    ranges.some((r) => lineNo >= r.start && lineNo <= r.end);

  return (
    <div className="overflow-x-auto rounded border border-border-muted bg-surface-sunken text-xs font-mono leading-relaxed">
      {lines.map((line, i) => {
        const lineNo = file.startLine + i;
        const hot = isHighlighted(lineNo);
        return (
          <div key={lineNo} className={`flex ${hot ? 'bg-red-500/10' : ''}`}>
            <span
              className="shrink-0 select-none px-2 text-right text-text-dim/50"
              style={{ width: '4ch' }}
            >
              {lineNo}
            </span>
            <span className="whitespace-pre pr-3 text-text">{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OrphanFindings({ findings, orphanFiles }: OrphanFindingsProps) {
  if (findings.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <span className="text-xs font-medium text-text">
          Findings outside the diff ({findings.length})
        </span>
      </div>
      <p className="text-[11px] text-text-dim leading-relaxed">
        These findings reference files that were not changed in this diff — typically a required
        deletion or edit that the worker did not perform. Showing the file's current contents at
        HEAD with the referenced lines highlighted.
      </p>

      <div className="space-y-2.5">
        {findings.map((finding) => {
          const file = orphanFiles?.find((f) =>
            finding.anchors.some(
              (a) => normalizeAnchorPath(a.path) === normalizeAnchorPath(f.path),
            ),
          );
          return (
            <div
              key={finding.id}
              className="rounded border border-border-muted bg-surface px-2.5 py-2 space-y-1.5"
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
              {file ? (
                <FindingSnippet file={file} finding={finding} />
              ) : (
                <p className="text-[11px] italic text-text-dim/70">
                  File content unavailable — it may not exist at HEAD (e.g. the deletion was already
                  performed, making this finding stale).
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
