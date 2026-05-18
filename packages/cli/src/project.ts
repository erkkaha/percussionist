// `beatctl project` — manage reusable Project templates.
//
// Projects are lightweight CRs that bundle the "boring" bits of a run spec
// (git URL/ref, SSH secret, LLM/auth secrets, default model/agent) under a
// short name. `beatctl submit --project <name>` then pulls those defaults in
// so the user only has to specify the task.

import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  API_GROUP_VERSION,
  KIND_PROJECT,
  ProjectSchema,
  type Project,
} from "@percussionist/api";
import {
  DEFAULT_NAMESPACE,
  age,
  createProject,
  deleteProject,
  fatal,
  getProject,
  listProjects,
  loadKube,
  padCols,
} from "./kube.js";

export interface ProjectCreateOpts {
  name?: string;
  namespace?: string;
  file?: string;
  displayName?: string;
  gitUrl?: string;
  gitRef?: string;
  gitSshSecret?: string;
  gitGithubTokenSecret?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  llmKeysSecret?: string;
  authSecret?: string;
  authKey?: string;
  model?: string;
  agent?: string;
  dryRun?: boolean;
}

function buildProjectFromFlags(opts: ProjectCreateOpts): Project {
  if (!opts.name) {
    throw new Error("--name is required when --file is not supplied");
  }
  if ((opts.gitAuthorName && !opts.gitAuthorEmail) || (!opts.gitAuthorName && opts.gitAuthorEmail)) {
    throw new Error("git author requires both --git-author-name and --git-author-email");
  }
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const raw: unknown = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_PROJECT,
    metadata: { name: opts.name, namespace: ns },
    spec: {
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.llmKeysSecret || opts.authSecret
        ? {
            secrets: {
              ...(opts.llmKeysSecret
                ? { llmKeysSecret: opts.llmKeysSecret }
                : {}),
              ...(opts.authSecret
                ? {
                    opencodeAuthSecret: {
                      name: opts.authSecret,
                      ...(opts.authKey ? { key: opts.authKey } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(opts.gitUrl
        ? {
            source: {
              git: {
                url: opts.gitUrl,
                ...(opts.gitRef ? { ref: opts.gitRef } : {}),
                ...(opts.gitSshSecret
                  ? { sshSecret: { name: opts.gitSshSecret } }
                  : {}),
                ...(opts.gitGithubTokenSecret
                  ? { githubTokenSecret: { name: opts.gitGithubTokenSecret } }
                  : {}),
                ...(opts.gitAuthorName && opts.gitAuthorEmail
                  ? {
                      author: {
                        name: opts.gitAuthorName,
                        email: opts.gitAuthorEmail,
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    },
  };
  return ProjectSchema.parse(raw);
}

function buildProjectFromFile(
  path: string,
  opts: ProjectCreateOpts,
): Project {
  const doc = YAML.parse(readFileSync(path, "utf8"));
  if (opts.name) doc.metadata = { ...(doc.metadata ?? {}), name: opts.name };
  if (opts.namespace) {
    doc.metadata = { ...(doc.metadata ?? {}), namespace: opts.namespace };
  }
  return ProjectSchema.parse(doc);
}

export async function runProjectCreate(opts: ProjectCreateOpts): Promise<void> {
  let project: Project;
  try {
    project = opts.file
      ? buildProjectFromFile(opts.file, opts)
      : buildProjectFromFlags(opts);
  } catch (e) {
    fatal("invalid project spec", e);
  }
  const ns = project.metadata.namespace ?? DEFAULT_NAMESPACE;
  project.metadata.namespace = ns;

  if (opts.dryRun) {
    console.log(YAML.stringify(project));
    return;
  }

  const { custom } = loadKube();
  try {
    const created = await createProject(custom, ns, project);
    console.log(
      `project ${created.metadata.name} created in namespace ${ns}`,
    );
  } catch (e) {
    fatal("create project failed", e);
  }
}

export interface ProjectListOpts {
  namespace?: string;
}

export async function runProjectList(opts: ProjectListOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  let items: Project[];
  try {
    items = await listProjects(custom, ns);
  } catch (e) {
    fatal("list projects failed", e);
  }
  if (items.length === 0) {
    console.log(`No projects in namespace ${ns}.`);
    return;
  }
  const rows: string[][] = [
    ["NAME", "DISPLAY NAME", "GIT URL", "MODEL", "AGE"],
  ];
  for (const p of items) {
    rows.push([
      p.metadata.name,
      p.spec.displayName ?? "-",
      p.spec.source?.git?.url ?? "-",
      p.spec.model ?? "-",
      age(p.metadata.creationTimestamp),
    ]);
  }
  console.log(padCols(rows));
}

export interface ProjectGetOpts {
  namespace?: string;
  output?: "yaml" | "json";
}

export async function runProjectGet(
  name: string,
  opts: ProjectGetOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  let project: Project;
  try {
    project = await getProject(custom, ns, name);
  } catch (e) {
    fatal("get project failed", e);
  }
  if (opts.output === "json") {
    console.log(JSON.stringify(project, null, 2));
  } else {
    console.log(YAML.stringify(project));
  }
}

export interface ProjectDeleteOpts {
  namespace?: string;
}

export async function runProjectDelete(
  name: string,
  opts: ProjectDeleteOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  try {
    await deleteProject(custom, ns, name);
    console.log(`project ${name} deleted from namespace ${ns}`);
  } catch (e) {
    fatal("delete project failed", e);
  }
}
