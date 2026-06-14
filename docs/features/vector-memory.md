# Vector Memory Service

Projects can enable a per-project vector memory service for semantic context retrieval and session summarization.

## Overview

When `spec.embedding.enabled: true`, the operator deploys a `memory-{project}` Deployment + Service running a Bun server with `bun:sqlite` and `sqlite-vec` for vector storage and search.

## How it Works

### 1. Memory Service Pod

A `memory-{project}` Bun container runs alongside the project's data PVC. It exposes REST endpoints on port 4100 for:

- Storing memories with vector embeddings
- Semantic search across stored memories
- Context retrieval for prompt injection

It calls Ollama's `/api/embeddings` endpoint to generate vector embeddings.

### 2. Context Injection

When constructing the agent prompt, if embedding is enabled, the system queries the memory service with the task description as the search query. Matching results are injected as a `RELEVANT PROJECT CONTEXT:` block so agents have relevant past decisions without manual context loading.

### 3. Session Summarization

When a worker run completes, a fire-and-forget summarization effect:
- Reads the session messages from the dispatcher's ConfigMap snapshot
- Compacts them and sends them to the LLM for summarization
- Stores the summary in the run's ConfigMap and the vector memory database

## Enable

```yaml
spec:
  embedding:
    enabled: true
    # Optional overrides:
    # model: nomic-embed-text           # default
    # dimensions: 768                    # default
    # ollamaUrl: http://ollama.percussionist.svc.cluster.local:11434     # default
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

## Prerequisites

- **Ollama Deployment** — The cluster must have an Ollama service:

```bash
kubectl apply -f k8s/deploy/ollama.yaml
```

Model warmup is handled by the memory service at startup.

## Resources

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | — |
| Memory | 256Mi | 512Mi |

## Lifecycle

- **Created**: Automatically when a Project with `embedding.enabled: true` is created
- **Deleted**: Automatically when the Project is deleted (via owner references) or when `embedding.enabled` is set to `false`
