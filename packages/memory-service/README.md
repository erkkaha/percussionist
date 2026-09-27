# @percussionist/memory-service

Per-project vector embedding service for semantic memory and context retrieval.

## Overview

The memory service is a standalone Bun server that provides vector embeddings
via Ollama and stores them in PostgreSQL with [pgvector](https://github.com/pgvector/pgvector),
through Drizzle ORM.

- Production: `pg.Pool` via `drizzle-orm/node-postgres` (selected by `DATABASE_URL`)
- Tests and local dev: an in-process [PGlite](https://pglite.dev) instance with
  the pgvector extension compiled in, wired through `drizzle-orm/pglite` (set
  `PERCUSSIONIST_ALLOW_PGLITE=1` when no `DATABASE_URL` is available)
- Every query is scoped by `MEMORY_PROJECT`, so one database can back several
  memory services without mixing their memories (the operator supplies the
  Project UID, not a reusable name)

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_SERVICE_PORT` | `4100` | HTTP listen port |
| `DATABASE_URL` | — | PostgreSQL connection string. Required outside tests; set `PERCUSSIONIST_ALLOW_PGLITE=1` for local PGlite |
| `DATABASE_POOL_MAX` | `10` | `pg.Pool` max connections |
| `MEMORY_PROJECT` | `default` | Project scope for every query |
| `MEMORY_MIGRATIONS_DIR` | `./migrations` | Where the drizzle migrator reads migrations from |
| `OLLAMA_BASE_URL` | `http://ollama.percussionist.svc.cluster.local:11434` | Ollama API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Vector width the embedding model must return (positive integer) |
| `PERCUSSIONIST_NAMESPACE` | `percussionist` | Cluster namespace |

### Embedding dimensions

`memories.embedding` is a bare `vector` column with no typmod, so the width is a
runtime setting (`spec.embedding.dimensions` → `EMBEDDING_DIMENSIONS`), not part
of the schema — switching embedding models needs no migration.

Two checks keep that from becoming a silent mismatch:

- every write validates the vector it was handed against the configured width
  before it reaches the database, so a model that returns the wrong number of
  dimensions fails the request instead of storing an unusable vector;
- startup compares the configured width against `vector_dims()` of the project's
  stored vectors and refuses to serve when they disagree, because a project that
  changed models would otherwise fail every search inside pgvector. Re-embed the
  existing memories, or point the project back at its original model.

### Distance semantics

`distance` is pgvector's **cosine distance** (`<=>`): `0` means identical
direction, `2` means opposite, and `1 - distance` is the cosine similarity that
`POST /context` reports as `relevance`. `GET /memories` and `GET /memory/:id`
return `distance: 0`, as before — those endpoints do not search.

## API

### `GET /health`
Health check. Queries the database and checks that the embedding model is
present in Ollama: `{ "ok": true }` with `200` when both are fine, otherwise
`{ "ok": false }` with `503`. Open (unauthenticated) so kubelet probes work
without the control-plane token.

### `POST /memory`
Store a memory with semantic embedding.

**Body:**
```json
{
  "content": "The user prefers TypeScript over JavaScript for new projects",
  "metadata": { "task": "BUILD-4", "run": "..." },
  "agentRun": "run:abc123"
}
```

**Response:** `{ "id": "uuid" }`

### `POST /search`
Semantic search across stored memories.

**Body:**
```json
{
  "query": "What language preference was recorded?",
  "limit": 10,
  "task": "task-abc"
}
```

The optional `task` field filters results to memories whose `metadata.task` matches
the given value. The filter is applied before the limit, so a filtered search
still returns up to `limit` matching memories.

**Response:**
```json
[
  {
    "id": "uuid",
    "content": "The user prefers TypeScript...",
    "metadata": { "task": "BUILD-4" },
    "distance": 0.15,
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
]
```

### `POST /context`
Retrieve relevant context formatted for prompt injection.

**Body:**
```json
{
  "query": "What do we know about deployment preferences?",
  "task": "BUILD-5"
}
```

**Response:**
```json
{
  "context": "[1] (relevance: 0.923)\n<memory>\n\n[2] (relevance: 0.874)\n<memory>"
}
```

### `GET /memories`
List stored memories with pagination and optional task filter. Returns results ordered by `created_at DESC`.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `task` | string | — | Filter to memories whose `metadata.task` matches this value |
| `limit` | number | 50 | Max results (capped at 200) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "memories": [
    {
      "id": "uuid",
      "content": "The user prefers TypeScript...",
      "metadata": { "task": "BUILD-4" },
      "distance": 0,
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 42
}
```

### `GET /memory/:id`
Retrieve a single memory by its UUID. Returns a not-found error if the ID does not exist.

**Response:**
```json
{
  "id": "uuid",
  "content": "The user prefers TypeScript...",
  "metadata": { "task": "BUILD-4" },
  "distance": 0,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### `PATCH /memory/:id`
Update a memory's content and/or metadata. If the content changes, the embedding vector is regenerated automatically to keep semantic search accurate. Metadata-only updates skip re-embedding.

**Body:**
```json
{
  "content": "Updated preference: TypeScript for all new projects",
  "metadata": { "task": "BUILD-4", "updatedBy": "admin" }
}
```

Both `content` and `metadata` are optional — provide only the fields you want to change.

**Response:**
```json
{
  "id": "uuid",
  "content": "Updated preference: TypeScript for all new projects",
  "metadata": { "task": "BUILD-4", "updatedBy": "admin" },
  "agentRun": "run:abc123",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### `DELETE /memory/:id`
Delete a memory and its embedding. Returns a not-found error if the ID does not exist in the current project.

**Response:**
```json
{ "deleted": true }
```

## Database

One table, created by the migrations in [`migrations/`](./migrations):

- `memories` — `(project, id)` primary key, `content`, `metadata` (jsonb),
  `agent_run`, `embedding vector`, `created_at`

Content and embedding share the row, so storing, updating and deleting a memory
is one statement and the two can never drift apart.

### Migrations

`migrations/` is generated from `src/schema.ts` and applied on startup by the
drizzle migrator — there is no separate migrate step:

```bash
pnpm db:generate   # regenerate after editing src/schema.ts
```

The baseline migration (`0000_*.sql`) starts with a hand-written
`CREATE EXTENSION IF NOT EXISTS vector`; keep it first, since pgvector is not
part of a vanilla PostgreSQL image and the `vector` column does not
resolve without it.

The migrations folder must be present wherever the service runs — including
inside the container image, where it sits next to `dist/`
(`MEMORY_MIGRATIONS_DIR` overrides the location).

## Embedding

The service calls Ollama's `/api/embeddings` endpoint to generate vectors.

## Image

The Dockerfile is at `images/memory/Dockerfile`:

```bash
docker build -t percussionist/memory:dev -f images/memory/Dockerfile .
```
