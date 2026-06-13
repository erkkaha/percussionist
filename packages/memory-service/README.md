# @percussionist/memory-service

Per-project vector embedding service for semantic memory and context retrieval.

## Overview

The memory service is a standalone Bun server that provides vector embeddings
via Ollama and stores them in a local SQLite database backed by sqlite-vec.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_SERVICE_PORT` | `4100` | HTTP listen port |
| `MEMORY_DB_PATH` | `/data/memory/vectors.db` | SQLite database path |
| `OLLAMA_BASE_URL` | `http://ollama.percussionist.svc.cluster.local:11434` | Ollama API endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimension count (must match the model's output) |
| `PERCUSSIONIST_NAMESPACE` | `percussionist` | Cluster namespace |

## API

### `GET /health`
Health check. Returns `{ "ok": true }`.

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

The optional `task` field filters results to memories whose `metadata.task` matches the given value.

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
Delete a memory and its associated embedding vector atomically. Returns a not-found error if the ID does not exist.

**Response:**
```json
{ "deleted": true }
```

## Database

Two tables are created on startup:

- `memories` — contains the raw text content, metadata JSON, and timestamps
- `vec_memories` — virtual table (vec0 extension) with 768-dimensional float
  embeddings

The vector table is created via raw SQL DDL since sqlite-vec's vec0 extension
requires non-standard `CREATE VIRTUAL TABLE` syntax.

## Embedding

The service calls Ollama's `/api/embeddings` endpoint to generate vectors.
Batch embedding is supported via `/api/embed` for multiple texts in one request.

## Image

The Dockerfile is at `images/memory/Dockerfile`:

```bash
docker build -t percussionist/memory:dev -f images/memory/Dockerfile .
```
