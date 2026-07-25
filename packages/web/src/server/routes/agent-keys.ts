// routes/agent-keys.ts — operator-facing inventory and rotation of agent keys.
//
//   GET  /api/internal/agent-keys                    → list keys (no plaintext)
//   POST /api/internal/agent-keys/:component/rotate  → re-mint a component key
//
// Backs `beatctl auth key list|rotate`. Requires a human session: rotating a
// credential is not something an agent should be able to do to itself.
//
// Plaintext keys are never returned here. Rotation writes the new value into the
// component's k8s Secret; since components resolve it through secretKeyRef at
// pod start, they must be restarted to pick it up — the response says as much.

import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import { getDb } from '../db.js';
import {
  COMPONENTS,
  type ComponentName,
  rotateComponentKey,
  SERVICE_USER_ID,
} from '../lib/agent-keys.js';
import { apikey } from '../schema.js';

const agentKeys = new Hono();

agentKeys.get('/', auth(), async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      id: apikey.id,
      name: apikey.name,
      start: apikey.start,
      enabled: apikey.enabled,
      permissions: apikey.permissions,
      metadata: apikey.metadata,
      requestCount: apikey.requestCount,
      lastRequest: apikey.lastRequest,
      expiresAt: apikey.expiresAt,
      createdAt: apikey.createdAt,
    })
    .from(apikey)
    .where(eq(apikey.referenceId, SERVICE_USER_ID))
    .orderBy(desc(apikey.createdAt));

  return c.json({
    items: rows.map((r) => ({
      ...r,
      permissions: r.permissions ? JSON.parse(r.permissions) : null,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    })),
  });
});

agentKeys.post('/:component/rotate', adminAuth(), async (c) => {
  const component = c.req.param('component');
  if (!Object.hasOwn(COMPONENTS, component)) {
    return c.json(
      { error: `Unknown component '${component}'. Known: ${Object.keys(COMPONENTS).join(', ')}` },
      400,
    );
  }

  const name = component as ComponentName;
  try {
    await rotateComponentKey(name);
    return c.json({
      component: name,
      secret: COMPONENTS[name].secretName,
      restartRequired: true,
      message: `Rotated. Restart the ${name} Deployment for it to pick up the new key.`,
    });
  } catch (e) {
    console.error(`[agent-keys] rotate ${name} failed:`, (e as Error).message);
    return c.json({ error: 'Failed to rotate key' }, 500);
  }
});

export default agentKeys;
