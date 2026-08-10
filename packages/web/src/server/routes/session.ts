import { OPENCODE_RUNNER_DEFAULTS, type RunPhase, TERMINAL_PHASES } from '@percussionist/api';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { fetchSessionMessages, getRun, readSessionConfigMap } from '../kube.js';
import { isKubeNotFound } from '../lib/kube-errors.js';
import { lookupSessionIdByRunName, replaySessionFromDb } from './stats.js';

const session = new Hono();

// GET /api/runs/:name/session — proxy session messages from the OpenCode API
// running inside the run's pod, with ConfigMap snapshot and stats-DB fallbacks.
//
// Strategy:
//   1. Get the run to find serviceName + sessionID. A missing Run CR (deleted
//      after runTTLDays) is NOT an error — the stats DB row outlives it, so we
//      fall through to the DB replay at the end.
//   2. Prefer the dispatcher's compact snapshot ConfigMap when it exists.
//   3. Otherwise try the live proxy to the OpenCode server inside the pod.
//   4. If neither works, replay the stored messages from the stats DB (this is
//      the only durable source for runs whose pod and Run CR are both gone).
//   5. Only if every source is unavailable, return an error.
session.get('/:name/session', auth(), async (c) => {
  const name = c.req.param('name');

  // 1. Get the run to find serviceName + sessionID.
  let serviceName = name;
  let sessionID: string;
  let runMissing = false;
  try {
    const run = await getRun(name);
    serviceName = run.status?.serviceName ?? name;
    sessionID = run.status?.sessionID ?? '';
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    if (!isKubeNotFound(e)) {
      return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, 500);
    }
    // Run CR deleted (run TTL) — the session ID may survive in the stats DB.
    runMissing = true;
    sessionID = lookupSessionIdByRunName(name) ?? '';
  }

  if (!runMissing && !sessionID) {
    return c.json({ error: 'Run has no session ID yet (still initializing?)' }, 404);
  }

  if (sessionID) {
    // Prefer the dispatcher's compact snapshot when it exists. Live OpenCode
    // sessions can include very large tool outputs; pulling them repeatedly
    // while viewing a run can OOM the web pod even if the route later falls
    // back. A deleted run may still have a surviving snapshot ConfigMap, so
    // this path is attempted regardless of run presence.
    try {
      const snapshot = await readSessionConfigMap(name, sessionID);
      if (snapshot) {
        return c.json({
          sessionID,
          messages: snapshot.messages,
          source: 'snapshot',
          truncated: snapshot.truncated,
        });
      }
    } catch {
      // Snapshot read failed — fall through to live proxy / DB replay.
    }

    // No snapshot yet: try the bounded live proxy (only for an existing run —
    // a deleted run's pod is gone by definition).
    if (!runMissing) {
      try {
        const messages = await fetchSessionMessages(serviceName, sessionID);
        return c.json({ sessionID, messages, source: 'live' });
      } catch (e) {
        console.warn(`[session] live fetch failed for ${name}:`, (e as Error).message);
        // Live proxy failed and no snapshot exists — fall through to DB replay.
      }
    }
  }

  // 4. Fall back to the stored messages in the stats DB. This is the durable
  //    source for deleted runs (the bug-fix path): the dispatcher persisted
  //    every message's parts, so the conversation survives the run TTL.
  const replay = replaySessionFromDb(name);
  if (replay) {
    return c.json({ sessionID: replay.sessionID, messages: replay.messages, source: 'db' });
  }

  if (runMissing) {
    return c.json({ error: 'Session unavailable: run deleted and no stored messages' }, 404);
  }
  return c.json({ error: 'Session unavailable: live proxy failed and no snapshot exists' }, 502);
});

// GET /api/runs/:name/session/events — proxy OpenCode SSE stream from the run service.
session.get('/:name/session/events', auth(), async (c) => {
  const name = c.req.param('name');

  let serviceName: string;
  let ns: string;
  let phase: string | undefined;
  let sessionID: string | undefined;
  try {
    const run = await getRun(name);
    serviceName = run.status?.serviceName ?? name;
    ns = run.metadata.namespace ?? 'percussionist';
    phase = run.status?.phase;
    sessionID = run.status?.sessionID;
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = isKubeNotFound(e) ? 404 : 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }

  if (phase && TERMINAL_PHASES.has(phase as RunPhase)) {
    return c.json({ error: `Run ${name} is ${phase}; no active event stream` }, 404);
  }

  if (!sessionID) {
    return c.json({ error: 'No active session for this run' }, 404);
  }

  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/event`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: c.req.raw.signal,
    });
  } catch (e) {
    return c.json({ error: `Failed to connect to event stream: ${(e as Error).message}` }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    return c.json({ error: `OpenCode event stream ${upstream.status}: ${body}` }, 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'off');

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
});

export default session;
