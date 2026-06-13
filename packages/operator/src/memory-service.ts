// memory-service.ts — Renders Deployment and Service for per-project memory services.
//
// The memory service provides vector embeddings + semantic search for agent
// context and memory queries. It runs as a per-project Bun server that mounts
// the project's data PVC and stores vectors in a local SQLite database backed
// by sqlite-vec.
//
// Lifecycle: Tied to Project CR via spec.embedding.enabled. Created and
// destroyed by the operator's project reconciler (same pattern as code-server).

import type { V1Deployment, V1Service } from '@kubernetes/client-node';
import {
  API_GROUP_VERSION,
  KIND_PROJECT,
  LABELS,
  MANAGED_BY,
  MEMORY_SERVICE_DEFAULT_IMAGE,
  MEMORY_SERVICE_PORT,
  type Project,
} from '@percussionist/api';
import { OLLAMA_BASE_URL } from './config.js';

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
  const spec = project.spec;
  if (!spec.embedding?.enabled) return false;
  // Requires source.git or source.local for a data PVC to mount
  return !!(spec.source?.git || spec.source?.local);
}

// ---------------------------------------------------------------------------
// Resource renderers

export function renderMemoryServiceDeployment(project: Project): V1Deployment {
  const name = project.metadata.name!;
  const ns = project.metadata.namespace!;
  const uid = project.metadata.uid!;
  const spec = project.spec;
  const embedding = spec.embedding!;

  const image = MEMORY_SERVICE_DEFAULT_IMAGE;
  const pvcName = spec.data?.pvcName ?? `${name}-data`;
  const mountPath = spec.data?.mountPath ?? '/data';

  const resources = embedding.resources ?? {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { memory: '512Mi' },
  };

  const env = [
    { name: 'MEMORY_SERVICE_PORT', value: String(MEMORY_SERVICE_PORT) },
    { name: 'MEMORY_DB_PATH', value: `${mountPath}/memory/vectors.db` },
    { name: 'OLLAMA_BASE_URL', value: embedding.ollamaUrl ?? OLLAMA_BASE_URL },
    { name: 'EMBEDDING_MODEL', value: embedding.model },
    { name: 'EMBEDDING_DIMENSIONS', value: String(embedding.dimensions ?? 768) },
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
              env,
              ports: [
                {
                  containerPort: MEMORY_SERVICE_PORT,
                  name: 'http',
                  protocol: 'TCP',
                },
              ],
              resources,
              volumeMounts: [
                {
                  name: 'data',
                  mountPath,
                },
              ],
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
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: {
                claimName: pvcName,
              },
            },
          ],
        },
      },
    },
  };
}

export function renderMemoryServiceService(project: Project): V1Service {
  const name = project.metadata.name!;
  const ns = project.metadata.namespace!;
  const uid = project.metadata.uid!;

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
