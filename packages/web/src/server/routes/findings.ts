// routes/findings.ts — findings endpoints nested under projects.
//
// Mounted at /api/projects (so :project param is accessible).
//
// GET    /api/projects/:project/findings          — list curated findings from board status
// GET    /api/projects/:project/findings/:id       — get a single finding detail
// PATCH  /api/projects/:project/findings/:id       — update finding status (dismiss, mark duplicate)
// POST   /api/projects/:project/findings/:id/task  — create a task from a finding

import type { Finding } from '@percussionist/api';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import {
  buildTask,
  createTask,
  getFindingsConfigMap,
  getProject,
  NAMESPACE,
  parseTriagedFindings,
  patchFindingsConfigMap,
  patchProjectStatus,
  patchTask,
  patchTaskStatus,
} from '../kube.js';

const findings = new Hono();

type KubeError = { statusCode?: number; body?: { message?: string }; message?: string };
function errStatus(e: KubeError) {
  return e.statusCode === 404 ? 404 : 500;
}
function errMsg(e: KubeError) {
  return e.body?.message ?? e.message ?? String(e);
}

// ---------------------------------------------------------------------------
// GET /api/projects/:project/findings — list curated findings from board status

findings.get('/:project/findings', auth(), async (c) => {
  const name = c.req.param('project');
  try {
    const project = await getProject(name);
    const boardFindings =
      (project.status?.board as { findings?: Finding[] } | undefined)?.findings ?? [];
    return c.json({ findings: boardFindings });
  } catch (e) {
    return c.json({ error: errMsg(e as KubeError) }, errStatus(e as KubeError));
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:project/findings/:id — get a single finding from ConfigMap

findings.get('/:project/findings/:id', auth(), async (c) => {
  const name = c.req.param('project');
  const findingId = c.req.param('id');
  const ns = NAMESPACE;
  try {
    const data = await getFindingsConfigMap(name, ns);
    if (!data) {
      return c.json({ error: 'findings configmap not found' }, 404);
    }
    // Search both triaged and inbox keys.
    const triagedKey = `triaged/${findingId}.json`;
    const inboxKey = `inbox/${findingId}.json`;
    if (data[triagedKey]) {
      return c.json({ finding: JSON.parse(data[triagedKey]) });
    }
    if (data[inboxKey]) {
      return c.json({ finding: JSON.parse(data[inboxKey]) });
    }
    // Also check by clusterId in triaged entries.
    const triagedMap = parseTriagedFindings(data);
    for (const f of triagedMap.values()) {
      if (f.clusterId === findingId || f.id === findingId) {
        return c.json({ finding: f });
      }
    }
    return c.json({ error: 'finding not found' }, 404);
  } catch (e) {
    return c.json({ error: errMsg(e as KubeError) }, errStatus(e as KubeError));
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/:project/findings/:id — update finding status
// Supports: status → wontfix, status → duplicate (with duplicateOf), status → resolved

findings.patch('/:project/findings/:id', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const findingId = c.req.param('id');
  const ns = NAMESPACE;
  try {
    const body = await c.req.json();
    const newStatus = body.status as string | undefined;
    const duplicateOf = body.duplicateOf as string | undefined;

    if (!newStatus || !['wontfix', 'resolved', 'duplicate', 'in-progress'].includes(newStatus)) {
      return c.json(
        { error: 'status must be one of: wontfix, resolved, duplicate, in-progress' },
        400,
      );
    }

    const data = await getFindingsConfigMap(name, ns);
    if (!data) {
      return c.json({ error: 'findings configmap not found' }, 404);
    }

    // Find the triaged finding.
    const triagedMap = parseTriagedFindings(data);
    let target: Finding | undefined;
    let targetKey = '';
    for (const [clusterId, f] of triagedMap.entries()) {
      if (f.id === findingId || f.clusterId === findingId) {
        target = f;
        targetKey = `triaged/${clusterId}.json`;
        break;
      }
    }

    if (!target) {
      return c.json({ error: 'finding not found in triaged entries' }, 404);
    }

    // Update the finding status.
    target.status = newStatus as Finding['status'];
    if (newStatus === 'duplicate' && duplicateOf) {
      target.duplicateOf = duplicateOf;
      target.clusterId = duplicateOf;
    }

    // Write updated finding back to ConfigMap.
    const patchData: Record<string, string | null> = {
      [targetKey]: JSON.stringify(target),
    };
    await patchFindingsConfigMap(name, patchData, ns);

    // Refresh board status.
    const project = await getProject(name);
    const currentFindings =
      (project.status?.board as { findings?: Finding[] } | undefined)?.findings ?? [];
    const updatedFindings = currentFindings.map((f) =>
      f.id === findingId || f.clusterId === findingId ? target! : f,
    );
    await patchProjectStatus(name, { board: { findings: updatedFindings } }, ns);

    return c.json({ finding: target });
  } catch (e) {
    return c.json({ error: errMsg(e as KubeError) }, errStatus(e as KubeError));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/findings/:id/task — create a task from a finding

findings.post('/:project/findings/:id/task', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const findingId = c.req.param('id');
  const ns = NAMESPACE;
  try {
    const body = await c.req.json();
    const taskType = (body.type as 'PLAN' | 'BUILD') ?? 'BUILD';
    const agentOverride = body.agent as string | undefined;

    const data = await getFindingsConfigMap(name, ns);
    if (!data) {
      return c.json({ error: 'findings configmap not found' }, 404);
    }

    // Find the finding.
    const triagedMap = parseTriagedFindings(data);
    let target: Finding | undefined;
    let targetKey = '';
    for (const [clusterId, f] of triagedMap.entries()) {
      if (f.id === findingId || f.clusterId === findingId) {
        target = f;
        targetKey = `triaged/${clusterId}.json`;
        break;
      }
    }

    if (!target) {
      return c.json({ error: 'finding not found in triaged entries' }, 404);
    }

    const project = await getProject(name);
    const agents = project.spec.agents ?? [];
    const defaultAgent =
      agentOverride ??
      agents.find((a) =>
        taskType === 'PLAN'
          ? a.name.toLowerCase().includes('planner')
          : a.name.toLowerCase().includes('builder'),
      )?.name ??
      (agents.length > 0 ? agents[0]!.name : 'default');

    const taskPriority =
      target.severity === 'critical' ? 'high' : (target.severity as 'high' | 'medium' | 'low');
    const { createHash } = await import('node:crypto');
    const taskSuffix = createHash('sha256').update(target.id).digest('hex').slice(0, 6);
    const taskName = `${name}-${taskType.toLowerCase()}-${taskSuffix}`;

    const newTask = buildTask({
      name: taskName,
      projectName: name,
      projectUid: project.metadata.uid ?? '',
      ns,
      spec: {
        projectRef: name,
        type: taskType,
        title: `[Finding] ${target.title.slice(0, 240)}`,
        description: `Created from finding ${target.id}:\n\n${target.description}${target.filePath ? `\n\nFile: ${target.filePath}` : ''}`,
        agent: defaultAgent,
        priority: taskPriority,
      },
    });

    await createTask(newTask, ns);
    await patchTaskStatus(taskName, { phase: 'pending' }, ns).catch(() => {
      /* best effort */
    });
    await patchTask(
      taskName,
      {
        metadata: {
          name: taskName,
          annotations: {
            'percussionist.dev/finding-id': target.id,
            'percussionist.dev/finding-cluster': target.clusterId ?? target.id,
          },
        },
      },
      ns,
    ).catch(() => {
      /* best effort */
    });

    // Update finding status.
    target.taskRef = taskName;
    target.status = 'in-progress';
    const patchData: Record<string, string | null> = {
      [targetKey]: JSON.stringify(target),
    };
    await patchFindingsConfigMap(name, patchData, ns);

    // Refresh board status.
    const currentFindings =
      (project.status?.board as { findings?: Finding[] } | undefined)?.findings ?? [];
    const updatedFindings = currentFindings.map((f) =>
      f.id === findingId || f.clusterId === findingId ? target! : f,
    );
    await patchProjectStatus(name, { board: { findings: updatedFindings } }, ns);

    return c.json({ taskName, finding: target, type: taskType, phase: 'pending' });
  } catch (e) {
    return c.json({ error: errMsg(e as KubeError) }, errStatus(e as KubeError));
  }
});

export default findings;
