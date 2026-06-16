// findings-ingestion.ts — per-project findings ingestion pipeline.
//
// Reads raw inbox findings from the {project}-findings ConfigMap,
// deduplicates them against existing triaged findings, and updates the
// board.status.findings curated view.

import { createHash } from 'node:crypto';
import type { Finding, Project } from '@percussionist/api';
import { FindingCategory, FindingSeverity } from '@percussionist/api';
import {
  buildTask,
  createTask,
  getFindingsConfigMap,
  parseInboxFindings,
  parseTriagedFindings,
  patchFindingsConfigMap,
  patchProjectStatus,
  patchTask,
  patchTaskStatus,
} from '@percussionist/kube';
import { queryMemory, storeMemory } from '../agent/memory-client.js';
import { emitEvent } from '../events.js';

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

const MAX_BOARD_FINDINGS = 100;

const AUTO_TASK_SEVERITIES = new Set<string>([
  FindingSeverity.enum.high,
  FindingSeverity.enum.critical,
]);
const AUTO_TASK_CATEGORIES = new Set<string>([
  FindingCategory.enum.bug,
  FindingCategory.enum.security,
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function computeSnippetHash(snippet: string | undefined): string {
  if (!snippet) return '';
  return createHash('sha256').update(normalize(snippet)).digest('hex').slice(0, 16);
}

export async function ingestFindings(project: Project, ns: string = NAMESPACE): Promise<void> {
  const projectName = project.metadata.name;

  const data = await getFindingsConfigMap(projectName, ns);
  if (!data) return;

  const inbox = parseInboxFindings(data);
  if (inbox.length === 0) return;

  const triagedMap = parseTriagedFindings(data);

  const existingDedupKeys = new Set<string>();
  const fileSnippetIndex = new Map<string, string>();
  for (const f of triagedMap.values()) {
    if (f.dedupKey) existingDedupKeys.add(f.dedupKey);
    if (f.filePath && f.snippet) {
      const hash = computeSnippetHash(f.snippet);
      if (hash) fileSnippetIndex.set(`${normalize(f.filePath)}:${hash}`, f.clusterId ?? f.id);
    }
  }

  const patchData: Record<string, string | null> = {};
  let hasChanges = false;

  for (const finding of inbox) {
    // Layer 1: exact dedupKey match
    if (existingDedupKeys.has(finding.dedupKey)) {
      const canonical = [...triagedMap.values()].find((f) => f.dedupKey === finding.dedupKey);
      if (canonical) {
        canonical.occurrences = (canonical.occurrences ?? 1) + 1;
        canonical.triagedAt = new Date().toISOString();

        patchData[`triaged/${canonical.clusterId ?? canonical.id}.json`] =
          JSON.stringify(canonical);

        patchData[`inbox/${finding.id}.json`] = null;
        // Don't write the duplicate back to triaged — it's just marked duplicate.
        hasChanges = true;

        emitEvent(
          projectName,
          finding.source.task ?? '',
          finding.source.run ?? 'finding',
          'FindingDuplicate',
          {
            fromPhase: undefined,
            toPhase: undefined,
            message: `Finding "${finding.title}" is a duplicate of "${canonical.title}"`,
            effects: [],
          },
        );
      }
      continue;
    }

    // Layer 2: file + snippet hash match
    if (finding.filePath && finding.snippet) {
      const hash = computeSnippetHash(finding.snippet);
      const key = `${normalize(finding.filePath)}:${hash}`;
      const matchClusterId = fileSnippetIndex.get(key);
      if (matchClusterId) {
        const canonical = triagedMap.get(matchClusterId);
        if (canonical) {
          canonical.occurrences = (canonical.occurrences ?? 1) + 1;
          canonical.triagedAt = new Date().toISOString();
          patchData[`triaged/${canonical.clusterId ?? canonical.id}.json`] =
            JSON.stringify(canonical);
          patchData[`inbox/${finding.id}.json`] = null;
          hasChanges = true;

          emitEvent(
            projectName,
            finding.source.task ?? '',
            finding.source.run ?? 'finding',
            'FindingDuplicate',
            {
              fromPhase: undefined,
              toPhase: undefined,
              message: `Finding "${finding.title}" is a file+snippet duplicate of "${canonical.title}"`,
              effects: [],
            },
          );
          continue;
        }
      }
    }

    // Layer 3: semantic similarity (optional, gated on embedding enabled)
    if (project.spec.embedding?.enabled) {
      try {
        const results = await queryMemory(
          projectName,
          `${finding.title}\n${finding.description}`,
          5,
        );
        const findingsResults = results.filter((r) => r.metadata?.kind === 'finding');
        if (findingsResults.length > 0 && findingsResults[0]!.distance < 0.15) {
          const matchId = findingsResults[0]!.metadata?.clusterId as string | undefined;
          if (matchId) {
            const canonical = triagedMap.get(matchId);
            if (canonical) {
              canonical.occurrences = (canonical.occurrences ?? 1) + 1;
              canonical.triagedAt = new Date().toISOString();
              patchData[`triaged/${canonical.clusterId ?? canonical.id}.json`] =
                JSON.stringify(canonical);
              patchData[`inbox/${finding.id}.json`] = null;
              hasChanges = true;

              emitEvent(
                projectName,
                finding.source.task ?? '',
                finding.source.run ?? 'finding',
                'FindingDuplicate',
                {
                  fromPhase: undefined,
                  toPhase: undefined,
                  message: `Finding "${finding.title}" is a semantic duplicate of "${canonical.title}"`,
                  effects: [],
                },
              );
              continue;
            }
          }
        }
      } catch {
        // Memory service unavailable — skip semantic dedup, treat as new.
      }
    }

    // New finding: triage it
    const clusterId = finding.id;
    const triaged: Finding = {
      ...finding,
      status: 'triaged',
      clusterId,
      triagedAt: new Date().toISOString(),
    };
    triagedMap.set(clusterId, triaged);
    existingDedupKeys.add(finding.dedupKey);
    if (triaged.filePath && triaged.snippet) {
      const hash = computeSnippetHash(triaged.snippet);
      if (hash) fileSnippetIndex.set(`${normalize(triaged.filePath)}:${hash}`, clusterId);
    }
    patchData[`triaged/${clusterId}.json`] = JSON.stringify(triaged);
    patchData[`inbox/${finding.id}.json`] = null;
    hasChanges = true;

    emitEvent(
      projectName,
      finding.source.task ?? '',
      finding.source.run ?? 'finding',
      'FindingTriaged',
      {
        fromPhase: undefined,
        toPhase: undefined,
        message: `Finding "${finding.title}" triaged as ${finding.severity} ${finding.category}`,
        effects: [],
      },
    );

    // Severity-gated auto Task creation: high/critical bugs and security issues.
    if (AUTO_TASK_SEVERITIES.has(finding.severity) && AUTO_TASK_CATEGORIES.has(finding.category)) {
      try {
        const taskType =
          finding.category === 'security' || finding.category === 'debt' ? 'PLAN' : 'BUILD';
        const taskSuffix = createHash('sha256').update(finding.id).digest('hex').slice(0, 6);
        const taskName = `${projectName}-${taskType.toLowerCase()}-${taskSuffix}`;
        const taskPriority =
          finding.severity === 'critical'
            ? 'high'
            : (finding.severity as 'high' | 'medium' | 'low');

        const agents = project.spec.agents ?? [];
        const defaultAgent =
          agents.find((a) =>
            taskType === 'PLAN'
              ? a.name.toLowerCase().includes('planner')
              : a.name.toLowerCase().includes('builder'),
          )?.name ?? (agents.length > 0 ? agents[0]!.name : 'default');

        const newTask = buildTask({
          name: taskName,
          projectName,
          projectUid: project.metadata.uid ?? '',
          ns,
          spec: {
            projectRef: projectName,
            type: taskType as 'PLAN' | 'BUILD',
            title: `[Finding] ${finding.title.slice(0, 240)}`,
            description: `Auto-created from finding ${finding.id}:\n\n${finding.description}${finding.filePath ? `\n\nFile: ${finding.filePath}` : ''}`,
            agent: defaultAgent,
            priority: taskPriority,
          },
        });

        await createTask(newTask, ns);
        await patchTaskStatus(taskName, { phase: 'pending' }, ns).catch(() => {
          /* best effort */
        });

        // Annotate the task with finding linkage.
        await patchTask(
          taskName,
          {
            metadata: {
              name: taskName,
              annotations: {
                'percussionist.dev/finding-id': finding.id,
                'percussionist.dev/finding-cluster': clusterId,
              },
            },
          },
          ns,
        ).catch(() => {
          /* best effort */
        });

        triaged.taskRef = taskName;
        triaged.status = 'in-progress';
        patchData[`triaged/${clusterId}.json`] = JSON.stringify(triaged);

        emitEvent(
          projectName,
          finding.source.task ?? '',
          finding.source.run ?? 'finding',
          'FindingTaskCreated',
          {
            fromPhase: undefined,
            toPhase: undefined,
            message: `Auto-created ${taskType} task ${taskName} for finding "${finding.title}"`,
            effects: [],
          },
        );
      } catch (e) {
        console.error(
          `[findings-ingestion] Failed to auto-create task for finding ${finding.id}:`,
          (e as Error).message,
        );
      }
    }

    // Store in vector memory for future semantic dedup (if embedding is enabled)
    if (project.spec.embedding?.enabled) {
      try {
        await storeMemory(
          projectName,
          `${finding.title}\n${finding.description}`,
          { kind: 'finding', clusterId },
          finding.source.run,
        );
      } catch {
        // Memory service unavailable — skip silently.
      }
    }
  }

  if (!hasChanges) return;

  // Write triaged findings and remove processed inbox entries.
  await patchFindingsConfigMap(projectName, patchData, ns);

  // Rebuild board.status.findings from triaged set (capped, newest first).
  const allTriaged = [...triagedMap.values()];
  allTriaged.sort((a, b) => (b.triagedAt ?? b.createdAt).localeCompare(a.triagedAt ?? a.createdAt));
  const boardFindings = allTriaged.slice(0, MAX_BOARD_FINDINGS);

  try {
    await patchProjectStatus(projectName, { board: { findings: boardFindings } }, ns);
  } catch (e) {
    console.error(
      `[findings-ingestion] Failed to patch board status for ${projectName}:`,
      (e as Error).message,
    );
  }
}
