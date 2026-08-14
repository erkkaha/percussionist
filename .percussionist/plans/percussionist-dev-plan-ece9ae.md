# Plan: Replace the web dashboard's embedded SQLite DB with PostgreSQL

**Task:** `percussionist-dev-plan-ece9ae`
**Branch:** `feature/percussionist-dev-plan-ece9ae`
**Date:** 2026-08-14 (retry 2/3 — premise clarification)

---

## 0. Premise — READ THIS FIRST (corrected on retry 2)

> **THIS TASK IS NOT ABOUT MYSQL. THERE IS NO MYSQL ANYWHERE IN THIS
> REPOSITORY, AND NONE OF THE BUILD TASKS BELOW MAY SEARCH FOR, REFERENCE,
> CONFIGURE, OR MIGRATE ANYTHING CALLED "MySQL" or "MariaDB".**
>
> The task title — *"Plan replacing MySQL with postgresql"* — is a misnomer.
> Verified by exhaustive search (`rg -il "mysql|mariadb"` over the whole tree
> excluding `pnpm-lock.yaml` and `node_modules` → **0 matches**; git history
> `git log -S "mysql"` → the string only ever appeared inside `pnpm-lock.yaml`
> as optional peer deps of drizzle packages).
>
> **The corrected premise (per facilitator retry note "Correction litesql"):
> the embedded database actually in use is SQLite ("lite SQL"), and the intent
> of this task is to replace that embedded SQLite database with PostgreSQL.**

- **What this task IS:** migrate the web dashboard's data store
  (`@percussionist/web`) from the embedded single-node **SQLite** database
  (`bun:sqlite` + Drizzle ORM) to a real client-server **PostgreSQL** database,
  deployed in-cluster.
- **What this task is NOT:**
  - NOT a MySQL→PostgreSQL migration (nothing exists to replace).
  - NOT a migration of `@percussionist/memory-service` (a separate per-project
    service using `bun:sqlite` + `sqlite-vec`; pgvector is a distinct effort).
  - NOT touching CRD/etcd state, the dispatcher, the manager-controller, or the
    CLI — none of them read the web DB directly (they talk to it over HTTP).
- **Decision gate for reviewers:** if you did NOT intend a SQLite→PostgreSQL
  migration, stop here and close/re-scope the task — do not generate BUILD
  tasks. Everything below proceeds on the corrected premise above.
- **Guardrail for buildgen:** every BUILD task below is explicitly phrased as
  *SQLite → PostgreSQL*. Do not add any task mentioning MySQL/MariaDB. If a
  BUILD agent reports "no MySQL found", that is the *expected* state — the
  MySQL phrasing in the original task title is a known red herring.

---

## 1. Context — what exists today

### 1.1 The web dashboard DB (`@percussionist/web`)

- **Driver / ORM:** `bun:sqlite` (`Database`) + `drizzle-orm@0.45.2`
  (`drizzle-orm/bun-sqlite`), running under Bun (web pod image is `oven/bun`
  alpine — `images/web/Dockerfile`).
- **Schema:** `packages/web/src/server/schema.ts` — **18 tables**, all
  `sqliteTable`:
  - Domain tables: `runs`, `messages`, `tool_calls`, `file_ops`,
    `metric_snapshots`, `usage_daily`, `usage_daily_project`, `usage_settings`,
    `task_events`.
  - better-auth-owned tables (names must match better-auth's model names
    exactly): `user`, `session`, `account`, `verification`, `apikey`,
    `device_code`.
  - Web push: `push_vapid`, `push_subscription`.
  - SQLite-isms to convert: `integer(..., { mode: 'boolean' })`,
    `integer(..., { mode: 'timestamp' })`,
    `integer('id').primaryKey({ autoIncrement: true })`,
    `sql\`(datetime('now'))\`` defaults, `real()`.
- **Connection/singleton:** `packages/web/src/server/db.ts` (153 lines) — opens
  `DATA_DIR/percussionist.db` (default `/app/data`), sets WAL / `busy_timeout`
  / `foreign_keys` / `wal_autocheckpoint` PRAGMAs, runs corruption detection
  (`PRAGMA quick_check` + rename-to-`.corrupt.<ts>` recovery), applies
  migrations on first `getDb()` call, registers a 60 s WAL checkpoint interval
  and a SIGTERM WAL-checkpoint handler. Exports `closeDb()` and `Db` type. All
  of this SQLite-specific machinery disappears under Postgres.
- **Standalone migrator:** `packages/web/src/server/migrate.ts`
  (`pnpm db:migrate`) — same bun:sqlite wiring.
- **Migrations:** `packages/web/migrations/` — 10 drizzle-kit SQL files +
  `meta/` (journal + snapshot). Generated from `drizzle.config.ts`
  (`dialect: 'sqlite'`). These must be regenerated for Postgres — SQLite DDL
  will not run on Postgres.
- **Auth:** `packages/web/src/server/lib/better-auth.ts:112` —
  `drizzleAdapter(getDb(), { provider: 'sqlite', schema })` → must become
  `provider: 'pg'`.
- **Push:** `packages/web/src/server/lib/push.ts` uses `getDb()` for the
  `push_vapid` / `push_subscription` tables (VAPID key storage + subscription
  CRUD) — same driver swap, no schema semantics change.
- **Routes using the DB:** `routes/stats.ts` (heaviest user; raw
  `sql\`...\`` with `DATE()`, `COALESCE`, `COUNT(*)` — all portable to
  Postgres), `routes/usage.ts` (`sql\`max(...)\`` — portable),
  `routes/activity.ts`, `routes/board-db.ts`, `routes/board.ts`,
  `routes/agent-keys.ts`. No `strftime`/`json_`/`datetime()` usage in routes;
  `datetime('now')` appears only as schema column defaults.
- **Startup:** `packages/web/src/server/index.ts:14` imports `getDb()` eagerly.
- **Tests:** **12 test files** set `process.env.DATA_DIR` to a temp dir and rely
  on `getDb()` lazily creating SQLite there: `activity.test.ts`, `auth.test.ts`,
  `board-actions-project-check.test.ts`, `board-capability-gating.test.ts`,
  `board-move.test.ts`, `agent-keys.test.ts`, `github-profile-mapping.test.ts`,
  `push.test.ts`, `run-housekeeping.test.ts`, `smoke.test.ts`,
  `task-diff.test.ts`, `usage-routes.test.ts`. These will need a live Postgres
  instead. The suite runs via `bun test --isolate --preload ./tests/setup.ts`.

### 1.2 Deployment

- `k8s/deploy/web.yaml`: Deployment `percussionist-web` mounts PVC
  `percussionist-web-db-v3` (1 Gi, RWO) at `/app/data` via env
  `DATA_DIR=/app/data`; `RETENTION_DAYS=30`.
- `k8s/deploy/kustomization.yaml`: lists `agent-config.yaml`, `operator.yaml`,
  `manager-controller.yaml`, `web.yaml`, `networkpolicy.yaml` (no DB resource
  today).
- `k8s/deploy/networkpolicy.yaml`: ingress allowlists for manager/memory
  services; a new `percussionist-postgres` Service must be reachable by the web
  pod (web is already allowlisted to manager:4097, so a web→postgres rule slots
  into the same file).
- `images/web/Dockerfile`: runtime stage is `oven/bun:1.3.13-alpine`,
  `ENV DATA_DIR=/app/data`, `RUN mkdir -p /app/data`. No new native deps needed
  if we use Bun's built-in Postgres driver.
- CI: `.github/workflows/ci.yml` — the `unit-tests` job runs `pnpm test`
  (timeout 5 min, bun 1.3.14) and currently needs **no** database service; that
  will change. `release.yml` runs the same unit suite.

### 1.3 Not in scope (explicitly)

- **`@percussionist/memory-service`** — separate per-project Bun service using
  `bun:sqlite` + `sqlite-vec` for vector storage
  (`packages/memory-service/src/db.ts`). Migrating it would mean pgvector;
  that is a distinct effort and should be its own task.
- **CRD/etcd state, dispatcher, manager-controller, CLI** — none of them touch
  the web DB; manager/dispatcher write via HTTP (`board-client.ts`,
  `POST /api/stats/session`), so they are unaffected.
- **Any MySQL/MariaDB work** — nothing exists to replace; explicitly out.

---

## 2. Approach

1. **Driver:** use Bun's built-in Postgres client (`bun:sql`) via
   `drizzle-orm/bun-sql` and `drizzle-orm/bun-sql/migrator` (zero new runtime
   dependencies; web pod already runs Bun). Keep `postgres` (postgres.js) +
   `drizzle-orm/postgres-js` as the fallback if `bun:sql` hits a limitation
   (e.g. parameter-binding edge cases in the 1.3.x line). Decide the driver
   early in BUILD 2 so later tasks don't depend on the choice.
2. **Infra:** deploy an in-cluster `percussionist-postgres` (Deployment or
   StatefulSet, 1 replica, RWO PVC, `postgres:16-alpine`) with a `web-db`
   Secret carrying the credentials; wire `DATABASE_URL` into the web Deployment.
   NetworkPolicy must allow web→postgres:5432.
3. **Schema/driver migration:** convert `schema.ts` to `pg-core`, swap
   `db.ts` / `migrate.ts` / `drizzle.config.ts`, regenerate migrations for the
   `postgresql` dialect (delete old SQLite migration files), switch the
   better-auth adapter provider, drop all SQLite PRAGMA / checkpoint /
   corruption-recovery code.
4. **Data migration:** a one-shot, idempotent script exporting the current
   SQLite DB into Postgres (runs/tool_calls/messages/file_ops/usage/auth
   users/push). Board `task_events` are reconstructible from CRs; document
   retention expectations. For fresh installs the script is a no-op.
5. **Tests:** introduce a shared test helper that provisions a unique Postgres
   database (or schema) per test file, add a `postgres:16` service container to
   CI/release workflows, and update the 12 test files that currently set
   `DATA_DIR`. This is the largest DX change and is called out as the top risk.
6. **Deploy + docs:** update `web.yaml` (drop `DATA_DIR`/PVC, add
   `DATABASE_URL`), `kustomization.yaml`, `images/web/Dockerfile` if needed, and
   the docs that describe the SQLite stack (`AGENTS.md`, `README.md`,
   `docs/testing-strategy.md`, `docs/architecture.md`, `docs/index.md`,
   `web.yaml` header comments).

Ordering: **infra first** (independently deployable), then **code**, then
**tests**, then **data tooling**, then **deploy/docs** last.

---

## 3. Tasks (proposed BUILD breakdown)

BUILD tasks below are ordered; each can be reviewed/merged independently. Only
task 1 is fully independent — 2–5 depend on 1 (or on the chosen driver).

### BUILD 1 — PostgreSQL infrastructure in-cluster

*SQLite → PostgreSQL, step 1: stand up the Postgres service. No MySQL
involvement.*

- Add `k8s/deploy/postgres.yaml`:
  - `Secret web-db` (keys: `username`, `password`, `database`) — or generate
    via a bootstrap note.
  - `Deployment percussionist-postgres` (or StatefulSet), image
    `postgres:16-alpine`, single replica, `POSTGRES_DB/USER/PASSWORD` from the
    Secret, health checks (`pg_isready`), volume mount for `PGDATA` on a new
    RWO PVC (e.g. `percussionist-postgres-data`, 2 Gi).
  - `Service percussionist-postgres` on port 5432.
- Wire into `k8s/deploy/kustomization.yaml` (note: `beatctl deploy` applies
  each file with `kubectl apply -f` — keep that path working by making the file
  standalone, namespace baked in).
- Extend `k8s/deploy/networkpolicy.yaml` to allow the web pod → postgres:5432.
- **Acceptance:** `kubectl apply -f k8s/deploy/postgres.yaml` (or `-k`) brings
  up a healthy postgres; `kubectl exec` into the pod runs `pg_isready`; no web
  pod change yet (still on SQLite).

### BUILD 2 — Schema + driver migration to PostgreSQL (the core change)

*SQLite → PostgreSQL, step 2: swap the ORM/driver and regenerate the schema.
This is the SQLite→Postgres conversion — do not search for MySQL.*

- `packages/web/src/server/schema.ts`: convert all 18 `sqliteTable` →
  `pgTable` (`drizzle-orm/pg-core`); map types:
  - `integer(..., { mode: 'boolean' })` → `boolean(...)`
  - `integer(..., { mode: 'timestamp' })` → `timestamptz(...)` (keep
    better-auth's `new Date()` round-trip semantics)
  - `integer('id').primaryKey({ autoIncrement: true })` → `serial('id').primaryKey()`
  - `sql\`(datetime('now'))\`` → `sql\`(now())\``
  - keep `text`, `real`, `primaryKey({ columns })`, and index definitions (APIs
    match).
- `packages/web/src/server/db.ts`: replace `bun:sqlite` with `Bun.sql` (URL
  from `DATABASE_URL` env, defaulting to the in-cluster service URL for dev
  parity); delete PRAGMA WAL / busy_timeout / quick_check / corruption-recovery
  / WAL-checkpoint / SIGTERM logic; use `migrate` from
  `drizzle-orm/bun-sql/migrator`; keep `getDb()` lazy singleton, `closeDb()`,
  `Db` type.
- `packages/web/src/server/migrate.ts`: same driver swap.
- `packages/web/drizzle.config.ts`: `dialect: 'postgresql'`,
  `dbCredentials: { url }` from `DATABASE_URL`.
- Regenerate migrations: delete the 10 SQLite files under
  `packages/web/migrations/` + `meta/`, run `pnpm db:generate` (drizzle-kit,
  postgresql dialect), commit fresh baseline migration(s).
- `packages/web/src/server/lib/better-auth.ts:112`:
  `drizzleAdapter(getDb(), { provider: 'pg', schema })`; run the drift check
  against `getSchema()` from `better-auth/db` and reconcile the auth tables if
  needed (timestamps are the likely drift point).
- Audit `routes/*.ts` raw SQL (`stats.ts` `DATE()`/`COALESCE`/`COUNT`,
  `usage.ts` `max()`) — all portable; fix anything that trips on Postgres
  (`boolean` mode columns no longer store 0/1).
- `packages/web/package.json`: add `postgres` dep **only if** the bun:sql
  fallback is needed; update `db:migrate` script if paths change.
- **Acceptance:** `pnpm build && pnpm typecheck` green in `packages/web`;
  `pnpm db:migrate` against a local Postgres applies migrations; `getDb()`
  connects and the health route works; `rg "bun:sqlite|sqliteTable|provider:
  'sqlite'" packages/web/src` returns nothing.

### BUILD 3 — One-shot data migration tooling

*SQLite → PostgreSQL, step 3: copy existing SQLite data into Postgres. No
MySQL involvement.*

- New script `packages/web/scripts/migrate-sqlite-to-pg.ts` (run once,
  idempotent):
  - Connect to old SQLite (`percussionist.db`) + target Postgres
    (`DATABASE_URL`).
  - Copy in dependency order: `user/account/session/verification/apikey/
    device_code`, `runs` → `messages/tool_calls/file_ops`, then
    `metric_snapshots`, `usage_*`, `task_events`, `push_*`. Use
    `ON CONFLICT DO NOTHING` / truncate-first for idempotency.
  - Normalise SQLite text dates (`YYYY-MM-DD HH:MM:SS`) into `timestamptz`;
    map 0/1 boolean integers.
  - Print per-table row counts + a verification query comparing totals.
- Document the runbook for existing clusters (retention semantics: session
  history is preserved; board columns/workers are re-synced from CRs by the
  reconciler, so those tables do not need a faithful copy).
- **Acceptance:** running the script twice on the same source yields identical
  target row counts; spot-check a run's `messages`/`tool_calls` row
  round-trips; `pnpm typecheck` green.

### BUILD 4 — Test infrastructure + update web tests

*SQLite → PostgreSQL, step 4: make the 12 SQLite-backed test files run against
Postgres. No MySQL involvement.*

- Add `packages/web/tests/helpers/test-db.ts`:
  - Reads `TEST_DATABASE_URL` (CI) or connects to a local Postgres (dev default
    `postgres://localhost:5432/postgres`); creates a **unique database per test
    file** (`percussionist_test_<pid>_<rand>`) because `bun test` runs files in
    parallel; applies migrations; registers teardown to drop it; exposes a
    `resetDb()` equivalent of the old `closeDb()` seam.
- Replace the `DATA_DIR` pattern in the 12 test files listed in §1.1 with the
  helper (set `DATABASE_URL` before lazy `getDb()` import — same ordering
  discipline as today).
- `.github/workflows/ci.yml` + `.github/workflows/release.yml`: add a
  `postgres:16` service container (health: `pg_isready`) to the `unit-tests`
  job and set `TEST_DATABASE_URL` for the web suite.
- Update `docs/testing-strategy.md` if it mentions the SQLite test setup.
- **Acceptance:** `pnpm test` in `packages/web` passes in CI with the postgres
  service; the suite also passes locally against a local postgres (document
  one-line setup); no test sets `DATA_DIR` anymore.

### BUILD 5 — Deploy wiring + documentation

*SQLite → PostgreSQL, step 5: point the deployed web pod at Postgres and update
docs. No MySQL involvement.*

- `k8s/deploy/web.yaml`: remove `DATA_DIR` env + `percussionist-db`
  volume/volumeMount/claim; add `DATABASE_URL` (secretKeyRef → `web-db`);
  update header comment; keep `RETENTION_DAYS` (implemented in app code, not
  the DB engine).
- Remove/retire the `percussionist-web-db-v3` PVC from the base (or leave a
  comment; the PV holds legacy SQLite data for the migration script).
- `images/web/Dockerfile`: no change expected if `bun:sql` is used; bump
  `BUN_VERSION` pin if a newer Bun is required for a `bun:sql` fix; add nothing
  if using postgres.js.
- Docs: update `AGENTS.md` (Database section: schema workflow, drizzle-kit
  postgresql dialect, remove SQLite-specific guidance), `README.md`
  (deploy/architecture), `docs/testing-strategy.md`, `docs/architecture.md`,
  `docs/index.md`, and the `k8s/deploy/web.yaml` header.
- **Acceptance:** `kubectl apply -k k8s/deploy/` on a fresh cluster yields web +
  postgres healthy; dashboard loads, GitHub sign-in works, run stats appear;
  `pnpm e2e:core` still green; docs no longer describe SQLite in
  `@percussionist/web`.

---

## 4. Scope boundaries

| In scope | Out of scope |
|---|---|
| Web dashboard DB: SQLite → PostgreSQL (`@percussionist/web`) | `@percussionist/memory-service` (sqlite-vec; pgvector is a separate task) |
| In-cluster postgres Deployment/Service/PVC/Secret/NetworkPolicy | CRD/etcd state, dispatcher/manager/CLI (they use HTTP, not the DB) |
| better-auth adapter provider switch | **Any MySQL/MariaDB work — nothing exists** |
| One-shot data migration tooling + runbook | Multi-node HA / managed cloud Postgres (documented option only) |
| Web test infrastructure + CI services | Performance tuning of Postgres |

## 5. Risks / open questions

1. **bun:sql (`Bun.sql`) maturity** in the pinned Bun 1.3.x line — parameter
   binding and multi-statement edge cases. Mitigation: fallback to `postgres`
   (postgres.js) + `postgres-js` driver; decide early in BUILD 2 so BUILD 3–5
   don't depend on the choice.
2. **Test burden is the biggest cost.** 12 test files currently need zero
   external infra; after this they need a live Postgres (CI service + local dev
   requirement). Every reviewer/contributor DX changes. Mitigation: shared
   helper + per-file databases + documented one-liner.
3. **better-auth table drift on Postgres.** Timestamp handling differs
   (`timestamptz` vs integer ms); a mismatch breaks sign-in/session/device-code
   flows. Mitigation: regenerate expected shape with `getSchema()` and add an
   auth-focused e2e/unit test in BUILD 4.
4. **Data migration fidelity.** SQLite stores dates as text and booleans as
   0/1; conversion must be explicit. Old session history is only as good as the
   script. Mitigation: idempotent script with row-count verification; board
   state is reconstructible from CRs, so partial loss is tolerable there.
5. **Rolling upgrade on an existing cluster.** Web pod must start before/without
   postgres without crash-looping (lazy `getDb()` + readiness probe). Old PVC
   data stays for the migration script — don't delete it in the same change as
   switching `DATABASE_URL`.
6. **NetworkPolicy** — forgetting to open web→postgres:5432 produces a working
   deploy that 500s. Covered by BUILD 1 acceptance + BUILD 5 e2e.
7. **Secret handling / gitops:** `web-db` Secret must exist before the web pod
   references it (order in kustomization); `beatctl deploy --gitops` (Flux)
   path applies it before web.
8. **Open question for reviewers:** in-cluster Postgres vs. an external/managed
   instance? This plan assumes in-cluster (matches the "single-replica,
   self-contained control plane" pattern).
9. **Open question:** is keeping ~30 days of old stats history important enough
   to mandate the BUILD 3 migration on existing clusters, or is a clean slate
   acceptable? The script makes it cheap either way.

## 6. Acceptance criteria (overall)

- `rg -i "mysql|mariadb" packages k8s docs images .github` (excluding
  `pnpm-lock.yaml`) → nothing before *and* after this work (unchanged — no
  MySQL ever existed).
- `rg "bun:sqlite|sqliteTable" packages/web/src` → nothing; all DB access via
  `DATABASE_URL` pointing at Postgres.
- `pnpm test` (web suite incl. auth/board/stats/push) green against Postgres in
  CI.
- `pnpm e2e:core` green on a cluster deployed from `k8s/deploy/` with postgres.
- Dashboard stats, board, usage limits, push, and GitHub sign-in all functional
  post-migration.
- `AGENTS.md` / `README.md` / `docs/testing-strategy.md` /
  `docs/architecture.md` describe the Postgres workflow.
