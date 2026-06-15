import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { getDb, usageDaily, usageDailyProject, usageSettings } from '../db.js';
import { setCachedLocked } from '../usage-lock-middleware.js';

type ProjectUsageCounters = {
  reviewing: number;
  planning: number;
};

type HeartbeatProjectUsagePayload = Record<
  string,
  {
    reviewing?: number;
    planning?: number;
  }
>;

type UsageHeartbeatBody = {
  reviewing?: number;
  planning?: number;
  other?: number;
  projectUsage?: HeartbeatProjectUsagePayload;
};

export type UsageResponse = {
  locked: boolean;
  reviewing: number;
  planning: number;
  other: number;
  total: number;
  projectUsage: Record<string, ProjectUsageCounters>;
  settings: {
    maxTimeHours: number;
    showPercent: boolean;
    lockOnMax: boolean;
  };
};

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildResponse(
  row: { reviewing: number | null; planning: number | null; other: number | null } | undefined,
  projectRows:
    | Array<{ project: string; reviewing: number | null; planning: number | null }>
    | undefined,
  settings:
    | { maxTimeHours: number | null; showPercent: boolean | null; lockOnMax: boolean | null }
    | undefined,
): UsageResponse {
  const reviewing = row?.reviewing ?? 0;
  const planning = row?.planning ?? 0;
  const other = row?.other ?? 0;
  const total = reviewing + planning + other;
  const maxSeconds = (settings?.maxTimeHours ?? 0) * 3600;
  const locked = maxSeconds > 0 && (settings?.lockOnMax ?? false) && total >= maxSeconds;
  const projectUsage: Record<string, ProjectUsageCounters> = {};
  for (const projectRow of projectRows ?? []) {
    projectUsage[projectRow.project] = {
      reviewing: projectRow.reviewing ?? 0,
      planning: projectRow.planning ?? 0,
    };
  }

  setCachedLocked(locked);
  return {
    locked,
    reviewing,
    planning,
    other,
    total,
    projectUsage,
    settings: {
      maxTimeHours: settings?.maxTimeHours ?? 0,
      showPercent: settings?.showPercent ?? false,
      lockOnMax: settings?.lockOnMax ?? false,
    },
  };
}

const router = new Hono();

router.post('/heartbeat', auth(), async (c) => {
  const body = await c.req.json<UsageHeartbeatBody>();
  const db = getDb();
  const date = today();

  db.insert(usageDaily)
    .values({
      date,
      reviewing: body.reviewing ?? 0,
      planning: body.planning ?? 0,
      other: body.other ?? 0,
    })
    .onConflictDoUpdate({
      target: usageDaily.date,
      set: {
        reviewing: sql`max(${usageDaily.reviewing}, ${body.reviewing ?? 0})`,
        planning: sql`max(${usageDaily.planning}, ${body.planning ?? 0})`,
        other: sql`max(${usageDaily.other}, ${body.other ?? 0})`,
      },
    })
    .run();

  for (const [project, usage] of Object.entries(body.projectUsage ?? {})) {
    const name = project.trim();
    if (!name) continue;

    const reviewing = usage.reviewing ?? 0;
    const planning = usage.planning ?? 0;

    db.insert(usageDailyProject)
      .values({
        date,
        project: name,
        reviewing,
        planning,
      })
      .onConflictDoUpdate({
        target: [usageDailyProject.date, usageDailyProject.project],
        set: {
          reviewing: sql`max(${usageDailyProject.reviewing}, ${reviewing})`,
          planning: sql`max(${usageDailyProject.planning}, ${planning})`,
        },
      })
      .run();
  }

  const row = db.select().from(usageDaily).where(eq(usageDaily.date, date)).get();
  const projectRows = db
    .select()
    .from(usageDailyProject)
    .where(eq(usageDailyProject.date, date))
    .all();
  const settings = db.select().from(usageSettings).where(eq(usageSettings.id, 1)).get();

  return c.json(buildResponse(row, projectRows, settings));
});

router.get('/today', auth(), async (c) => {
  const db = getDb();
  const date = today();
  const row = db.select().from(usageDaily).where(eq(usageDaily.date, date)).get();
  const projectRows = db
    .select()
    .from(usageDailyProject)
    .where(eq(usageDailyProject.date, date))
    .all();
  const settings = db.select().from(usageSettings).where(eq(usageSettings.id, 1)).get();
  return c.json(buildResponse(row, projectRows, settings));
});

router.get('/settings', auth(), async (c) => {
  const db = getDb();
  const settings = db.select().from(usageSettings).where(eq(usageSettings.id, 1)).get();
  return c.json(settings ?? { maxTimeHours: 0, showPercent: false, lockOnMax: false });
});

router.put('/settings', auth(), async (c) => {
  const body = await c.req.json<{
    maxTimeHours?: number;
    showPercent?: boolean;
    lockOnMax?: boolean;
  }>();
  const db = getDb();

  const existing = db.select().from(usageSettings).where(eq(usageSettings.id, 1)).get();

  if (existing) {
    db.update(usageSettings)
      .set({
        ...(body.maxTimeHours !== undefined ? { maxTimeHours: body.maxTimeHours } : {}),
        ...(body.showPercent !== undefined ? { showPercent: body.showPercent } : {}),
        ...(body.lockOnMax !== undefined ? { lockOnMax: body.lockOnMax } : {}),
      })
      .where(eq(usageSettings.id, 1))
      .run();
  } else {
    db.insert(usageSettings)
      .values({
        id: 1,
        maxTimeHours: body.maxTimeHours ?? 0,
        showPercent: body.showPercent ?? false,
        lockOnMax: body.lockOnMax ?? false,
      })
      .run();
  }

  // Recalculate lock after settings change.
  const date = today();
  const row = db.select().from(usageDaily).where(eq(usageDaily.date, date)).get();
  const projectRows = db
    .select()
    .from(usageDailyProject)
    .where(eq(usageDailyProject.date, date))
    .all();
  const newSettings = db.select().from(usageSettings).where(eq(usageSettings.id, 1)).get();
  buildResponse(row, projectRows, newSettings);

  return c.json(newSettings ?? { maxTimeHours: 0, showPercent: false, lockOnMax: false });
});

export default router;
