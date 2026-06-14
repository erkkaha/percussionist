#!/usr/bin/env node

// codegen/gen-crds.mjs — generate CRD YAML files from Zod schemas.
//
// Usage: node codegen/gen-crds.mjs [--out <dir>]
//
// Reads the compiled API package (packages/api/dist/index.js) and produces:
//   k8s/crds/run.yaml
//   k8s/crds/project.yaml
//   k8s/crds/task.yaml
//   k8s/crds/clusteragent.yaml
//
// Requires the api package to have been built first:
//   pnpm --filter @percussionist/api build
//
// zod-to-json-schema is a dev dependency of the api package.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Resolve paths.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiDist = path.resolve(repoRoot, 'packages/api/dist/index.js');

// Parse --out flag.
const outIdx = process.argv.indexOf('--out');
const outDir =
  outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.resolve(repoRoot, 'k8s/crds');
mkdirSync(outDir, { recursive: true });

// Load compiled API.
const api = await import(apiDist);

// ---------------------------------------------------------------------------
// Convert a Zod schema to an OpenAPI-compatible JSON Schema object.
// We strip the $schema and title fields (not needed in CRDs).
// We also strip additionalProperties only when the object node also has a
// `properties` field — that's the combination Kubernetes CRD validation
// forbids.  When an object has `additionalProperties` but NO `properties`
// it is a free-form map (z.record()); we replace it with
// `x-kubernetes-preserve-unknown-fields: true` so Kubernetes doesn't prune
// the map's keys.
// We also inline all $ref references — Kubernetes CRD validation forbids $ref.
function stripAdditionalProperties(obj) {
  if (Array.isArray(obj)) {
    return obj.map(stripAdditionalProperties);
  }
  if (obj !== null && typeof obj === 'object') {
    const { additionalProperties, default: _default, ...rest } = obj;
    void _default;
    const result = {};
    for (const [k, v] of Object.entries(rest)) {
      result[k] = stripAdditionalProperties(v);
    }
    if (additionalProperties !== undefined) {
      if (rest.properties) {
        // Kubernetes forbids additionalProperties alongside properties — drop it.
        void additionalProperties;
      } else {
        // Free-form map (z.record): preserve unknown fields so K8s doesn't prune keys.
        result['x-kubernetes-preserve-unknown-fields'] = true;
      }
    }
    return result;
  }
  return obj;
}

/**
 * Recursively resolve all $ref pointers in a JSON Schema.
 * Only handles local refs of the form "#/$defs/Foo".
 */
function _inlineRefs(obj, defs) {
  if (Array.isArray(obj)) {
    return obj.map((v) => _inlineRefs(v, defs));
  }
  if (obj !== null && typeof obj === 'object') {
    if (typeof obj.$ref === 'string') {
      const refPath = obj.$ref; // e.g. "#/$defs/ResourceRequirements"
      const name = refPath.replace(/^#\/\$defs\//, '');
      const resolved = defs[name];
      if (!resolved) throw new Error(`Cannot resolve $ref: ${refPath}`);
      // Inline the resolved definition (recursively).
      return _inlineRefs({ ...resolved }, defs);
    }
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$defs') continue; // drop the defs block itself
      result[k] = _inlineRefs(v, defs);
    }
    return result;
  }
  return obj;
}

function toOpenAPISchema(schema) {
  // $refStrategy: "none" forces all schemas to be inlined — no $ref or $defs
  // generated. This is required for Kubernetes CRD validation which forbids $ref.
  const js = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
  const { $schema, title, $defs, ...rest } = js;
  void $defs; // should be empty with $refStrategy:"none" but drop anyway
  return stripAdditionalProperties(rest);
}

// ---------------------------------------------------------------------------
// CRD template helper.

function makeCRD({
  group,
  version,
  kind,
  plural,
  scope,
  specSchema,
  statusSchema,
  additionalPrinterColumns = [],
}) {
  const openApiV3Schema = {
    type: 'object',
    properties: {
      apiVersion: { type: 'string' },
      kind: { type: 'string' },
      metadata: { type: 'object' },
      spec: toOpenAPISchema(specSchema),
    },
    required: ['spec'],
  };

  if (statusSchema) {
    openApiV3Schema.properties.status = toOpenAPISchema(statusSchema);
  }

  const crd = {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${plural}.${group}`,
    },
    spec: {
      group,
      names: {
        kind,
        plural,
        singular: kind.toLowerCase(),
      },
      scope,
      versions: [
        {
          name: version,
          served: true,
          storage: true,
          ...(statusSchema
            ? {
                subresources: {
                  status: {},
                },
              }
            : {}),
          additionalPrinterColumns,
          schema: { openAPIV3Schema: openApiV3Schema },
        },
      ],
    },
  };

  return YAML.stringify(crd, { lineWidth: 0, version: '1.1' });
}

// ---------------------------------------------------------------------------
// ClusterAgent CRD

const clusterAgentYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_CLUSTER_AGENT,
  plural: api.PLURAL_CLUSTER_AGENT,
  scope: 'Cluster',
  specSchema: api.ClusterAgentSpecSchema,
  additionalPrinterColumns: [
    {
      name: 'Age',
      type: 'date',
      jsonPath: '.metadata.creationTimestamp',
    },
  ],
});

writeFileSync(path.join(outDir, 'clusteragent.yaml'), clusterAgentYAML);
console.log(`wrote ${path.join(outDir, 'clusteragent.yaml')}`);

// ---------------------------------------------------------------------------
// Project CRD

const projectYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_PROJECT,
  plural: api.PLURAL_PROJECT,
  scope: 'Namespaced',
  specSchema: api.ProjectSpecSchema,
  statusSchema: api.ProjectStatusSchema,
  additionalPrinterColumns: [
    {
      name: 'Phase',
      type: 'string',
      jsonPath: '.spec.phase',
    },
    {
      name: 'Workers',
      type: 'integer',
      jsonPath: '.status.board.activeWorkers',
    },
    {
      name: 'Age',
      type: 'date',
      jsonPath: '.metadata.creationTimestamp',
    },
  ],
});

writeFileSync(path.join(outDir, 'project.yaml'), projectYAML);
console.log(`wrote ${path.join(outDir, 'project.yaml')}`);

// ---------------------------------------------------------------------------
// Run CRD

const runYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_RUN,
  plural: api.PLURAL_RUN,
  scope: 'Namespaced',
  specSchema: api.RunSpecSchema,
  statusSchema: api.RunStatusSchema,
  additionalPrinterColumns: [
    {
      name: 'Phase',
      type: 'string',
      jsonPath: '.status.phase',
    },
    {
      name: 'Project',
      type: 'string',
      jsonPath: '.spec.project',
    },
    {
      name: 'Age',
      type: 'date',
      jsonPath: '.metadata.creationTimestamp',
    },
  ],
});

writeFileSync(path.join(outDir, 'run.yaml'), runYAML);
console.log(`wrote ${path.join(outDir, 'run.yaml')}`);

// ---------------------------------------------------------------------------
// Task CRD

const taskYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_TASK,
  plural: api.PLURAL_TASK,
  scope: 'Namespaced',
  specSchema: api.TaskSpecSchema,
  statusSchema: api.TaskStatusSchema,
  additionalPrinterColumns: [
    {
      name: 'Phase',
      type: 'string',
      jsonPath: '.status.phase',
    },
    {
      name: 'Column',
      type: 'string',
      jsonPath: '.status.column',
    },
    {
      name: 'Type',
      type: 'string',
      jsonPath: '.spec.type',
    },
    {
      name: 'Project',
      type: 'string',
      jsonPath: '.spec.projectRef',
    },
    {
      name: 'Age',
      type: 'date',
      jsonPath: '.metadata.creationTimestamp',
    },
  ],
});

writeFileSync(path.join(outDir, 'task.yaml'), taskYAML);
console.log(`wrote ${path.join(outDir, 'task.yaml')}`);

console.log('CRD codegen complete.');
