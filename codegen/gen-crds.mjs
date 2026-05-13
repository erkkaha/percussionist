#!/usr/bin/env node
// codegen/gen-crds.mjs — generate CRD YAML files from Zod schemas.
//
// Usage: node codegen/gen-crds.mjs [--out <dir>]
//
// Reads the compiled API package (packages/api/dist/index.js) and produces:
//   crds/opencoderun.yaml
//   crds/opencodeproject.yaml
//   crds/clusteragent.yaml
//
// Requires the api package to have been built first:
//   pnpm --filter @percussionist/api build
//
// zod-to-json-schema is a dev dependency of the api package.

import { zodToJsonSchema } from "zod-to-json-schema";
import * as YAML from "yaml";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve paths.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const apiDist = path.resolve(repoRoot, "packages/api/dist/index.js");

// Parse --out flag.
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.resolve(repoRoot, "crds");
mkdirSync(outDir, { recursive: true });

// Load compiled API.
const api = await import(apiDist);

// ---------------------------------------------------------------------------
// Convert a Zod schema to an OpenAPI-compatible JSON Schema object.
// We strip the $schema and title fields (not needed in CRDs).
function toOpenAPISchema(schema) {
  const js = zodToJsonSchema(schema, { target: "openApi3" });
  // Flatten — if the schema is a $ref wrapper, keep the definitions.
  const { $schema, title, ...rest } = js;
  return rest;
}

// ---------------------------------------------------------------------------
// CRD template helper.

function makeCRD({ group, version, kind, plural, scope, specSchema, statusSchema, additionalPrinterColumns = [] }) {
  const openApiV3Schema = {
    type: "object",
    properties: {
      apiVersion: { type: "string" },
      kind: { type: "string" },
      metadata: { type: "object" },
      spec: toOpenAPISchema(specSchema),
    },
    required: ["spec"],
  };

  if (statusSchema) {
    openApiV3Schema.properties.status = toOpenAPISchema(statusSchema);
  }

  const crd = {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
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
          ...(statusSchema ? {
            subresources: {
              status: {},
            },
          } : {}),
          additionalPrinterColumns,
          schema: { openAPIV3Schema: openApiV3Schema },
        },
      ],
    },
  };

  return YAML.stringify(crd, { lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// ClusterAgent CRD

const clusterAgentYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_CLUSTER_AGENT,
  plural: api.PLURAL_CLUSTER_AGENT,
  scope: "Cluster",
  specSchema: api.ClusterAgentSpecSchema,
  additionalPrinterColumns: [
    {
      name: "Age",
      type: "date",
      jsonPath: ".metadata.creationTimestamp",
    },
  ],
});

writeFileSync(path.join(outDir, "clusteragent.yaml"), clusterAgentYAML);
console.log(`wrote ${path.join(outDir, "clusteragent.yaml")}`);

// ---------------------------------------------------------------------------
// OpenCodeProject CRD

const projectYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_PROJECT,
  plural: api.PLURAL_PROJECT,
  scope: "Namespaced",
  specSchema: api.OpenCodeProjectSpecSchema,
  statusSchema: api.OpenCodeProjectStatusSchema,
  additionalPrinterColumns: [
    {
      name: "Phase",
      type: "string",
      jsonPath: ".status.board.phase",
    },
    {
      name: "Workers",
      type: "integer",
      jsonPath: ".status.board.activeWorkers",
    },
    {
      name: "Age",
      type: "date",
      jsonPath: ".metadata.creationTimestamp",
    },
  ],
});

writeFileSync(path.join(outDir, "opencodeproject.yaml"), projectYAML);
console.log(`wrote ${path.join(outDir, "opencodeproject.yaml")}`);

// ---------------------------------------------------------------------------
// OpenCodeRun CRD

const runYAML = makeCRD({
  group: api.API_GROUP,
  version: api.API_VERSION,
  kind: api.KIND_RUN,
  plural: api.PLURAL_RUN,
  scope: "Namespaced",
  specSchema: api.OpenCodeRunSpecSchema,
  statusSchema: api.OpenCodeRunStatusSchema,
  additionalPrinterColumns: [
    {
      name: "Phase",
      type: "string",
      jsonPath: ".status.phase",
    },
    {
      name: "Project",
      type: "string",
      jsonPath: ".spec.project",
    },
    {
      name: "Age",
      type: "date",
      jsonPath: ".metadata.creationTimestamp",
    },
  ],
});

writeFileSync(path.join(outDir, "opencoderun.yaml"), runYAML);
console.log(`wrote ${path.join(outDir, "opencoderun.yaml")}`);

console.log("CRD codegen complete.");
