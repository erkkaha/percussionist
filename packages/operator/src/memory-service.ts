// memory-service.ts — Renders Deployment and Service for per-project memory services.
//
// The memory service provides vector embeddings + semantic search for agent
// context and memory queries. It runs as a per-project Bun server backed by
// PostgreSQL with pgvector; every query is scoped by MEMORY_PROJECT.
//
// Lifecycle: Tied to Project CR via spec.embedding.enabled. Created and
// destroyed by the operator's project reconciler (same pattern as code-server).

import type { V1Deployment, V1Service } from '@kubernetes/client-node';
import {
  API_GROUP_VERSION,
  KIND_PROJECT,
  LABELS,
  MANAGED_BY,
  MEMORY_SERVICE_PORT,
  type Project,
} from '@percussionist/api';
import {
  MEMORY_DATABASE_SECRET,
  MEMORY_SERVICE_IMAGE,
  OLLAMA_ALLOWED_ORIGINS,
  OLLAMA_BASE_URL,
} from './config.js';

// ---------------------------------------------------------------------------
// Naming helpers

export function memoryServiceDeploymentName(project: Project): string {
  return `memory-${project.metadata.name}`;
}

export function memoryServiceServiceName(project: Project): string {
  return `memory-${project.metadata.name}`;
}

// ---------------------------------------------------------------------------
// Condition check

export function shouldReconcileMemoryService(project: Project): boolean {
  return project.spec.embedding?.enabled === true;
}

// ---------------------------------------------------------------------------
// Resource renderers

export function renderMemoryServiceDeployment(project: Project): V1Deployment {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';
  // Memories are scoped by the Project's Kubernetes UID, never by its name: a
  // deleted project leaves rows behind (they are UID-scoped, so nothing new can
  // read them), and recreating a project with the same name gets a fresh UID and
  // therefore a fresh, empty scope. Falling back to the name here would hand the
  // new project the deleted one's memories, so a missing UID is a hard error
  // rather than a default. The API server always sets it.
  if (!uid) {
    throw new Error(
      `Project ${ns}/${name} has no metadata.uid; cannot scope its memory service. ` +
        'This means the object did not come from the API server.',
    );
  }
  const projectScope = uid;
  const spec = project.spec;
  const embedding = spec.embedding;
  if (!embedding) throw new Error('embedding config is required');

  const image = MEMORY_SERVICE_IMAGE;

  const resources = embedding.resources ?? {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { memory: '512Mi' },
  };

  const env = [
    { name: 'MEMORY_SERVICE_PORT', value: String(MEMORY_SERVICE_PORT) },
    { name: 'MEMORY_PROJECT', value: projectScope },
    { name: 'DATABASE_POOL_MAX', value: '2' },
    {
      name: 'DATABASE_URL',
      valueFrom: { secretKeyRef: { name: MEMORY_DATABASE_SECRET, key: 'url', optional: false } },
    },
    { name: 'OLLAMA_BASE_URL', value: embedding.ollamaUrl ?? OLLAMA_BASE_URL },
    { name: 'OLLAMA_ALLOWED_ORIGINS', value: OLLAMA_ALLOWED_ORIGINS },
    { name: 'EMBEDDING_MODEL', value: embedding.model },
    { name: 'EMBEDDING_DIMENSIONS', value: String(embedding.dimensions ?? 768) },
    // Shared control-plane token gating every route except /health. The manager
    // is the only legitimate caller; this Secret is deliberately not projected
    // into run pods, so an agent that reaches :4100 still cannot read or poison
    // a project's memories. The operator provisions this Secret at startup.
    {
      name: 'MCP_TOKEN',
      valueFrom: { secretKeyRef: { name: 'manager-mcp-token', key: 'token', optional: false } },
    },
  ];

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'memory-service',
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: memoryServiceDeploymentName(project),
      namespace: ns,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name,
          uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          [LABELS.projectName]: name,
          'percussionist.dev/component': 'memory-service',
        },
      },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'memory',
              image,
              // Every other operator-managed pod uses IfNotPresent (runner,
              // dispatcher, workspace-init, ttl). Memory was the lone Always,
              // which meant a locally built image could never be used: kubelet
              // ignored the loaded image and went to the registry every time.
              // Since the operator server-side-applies this Deployment with
              // force, a manual patch could not work around it either.
              imagePullPolicy: 'IfNotPresent',
              env,
              ports: [
                {
                  containerPort: MEMORY_SERVICE_PORT,
                  name: 'http',
                  protocol: 'TCP',
                },
              ],
              resources,
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: MEMORY_SERVICE_PORT,
                },
                // Health check now verifies Ollama model availability via /api/tags.
                // Tune for ~60s grace period to allow model pull to complete.
                initialDelaySeconds: 10,
                periodSeconds: 5,
                failureThreshold: 12,
              },
            },
          ],
        },
      },
    },
  };
}

export function renderMemoryServiceService(project: Project): V1Service {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'memory-service',
  };

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: memoryServiceServiceName(project),
      namespace: ns,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name,
          uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        [LABELS.projectName]: name,
        'percussionist.dev/component': 'memory-service',
      },
      ports: [
        {
          port: MEMORY_SERVICE_PORT,
          targetPort: MEMORY_SERVICE_PORT,
          name: 'http',
          protocol: 'TCP',
        },
      ],
    },
  };
}
