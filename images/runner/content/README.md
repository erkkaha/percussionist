# Runner cluster-wide agents & skills

Files placed here are `COPY`'d into `/root/.config/opencode/` when the
`percussionist/runner` image is built. Every run pod launched from that image
sees them as cluster-wide OpenCode agents and skills.

## Structure

```
content/
├── agents/
│   └── <name>.md            # one file per agent, filename = agent name
└── skills/
    └── <name>/
        └── SKILL.md         # one folder per skill, folder name = skill name
```

### Agents

Each file is a markdown file with YAML front-matter. The filename (without
`.md`) becomes the agent name.

Example: `agents/code-reviewer.md`

```markdown
---
description: Reviews code for quality and security issues
mode: subagent
model: anthropic/claude-sonnet-4-20250514
permission:
  edit: deny
  bash: deny
---

You are a code reviewer. Focus on security, correctness, and maintainability.
Provide constructive feedback without modifying files.
```

See the [OpenCode agents docs](https://opencode.ai/docs/agents/) for all options.

### Skills

Each skill lives in its own subdirectory. The directory name must match the
`name` field in the front-matter.

Example: `skills/git-release/SKILL.md`

```markdown
---
name: git-release
description: Create consistent releases and changelogs
---

## What I do
Draft release notes from merged PRs and propose a version bump.
```

See the [OpenCode skills docs](https://opencode.ai/docs/skills/) for all
front-matter fields and validation rules.

## Updating cluster-wide content

Changes here take effect after a runner image rebuild and reload:

```bash
docker build -t percussionist/runner:dev images/runner
# For k3s / minikube — see scripts/minikube-load.sh
```

## Per-repo overrides

Individual workspace repos can ship their own agents and skills without any
image change. Commit them under `.opencode/` in the workspace repository:

```
<repo>/
└── .opencode/
    ├── agents/
    │   └── <name>.md
    └── skills/
        └── <name>/
            └── SKILL.md
```

When the operator clones the repo via `spec.source.git`, the files land in
`/workspace`. OpenCode walks up from `/workspace` and discovers them
automatically — no runner image change required.
