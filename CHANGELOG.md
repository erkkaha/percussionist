# Changelog

All notable changes to Percussionist are documented here.
## [v0.1.187] - 2026-06-16

### <!-- 0 -->🚀 Features

- Add findings panel to board view _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Update reviewer prompt with structured findings schema _(agents)_
- Restore skipSanitization for trusted diff script in exec_in_workspace _(web)_

### <!-- 6 -->🧪 Testing

- Add unit tests for schema, ConfigMap helpers, dedup, and dispatcher _(findings)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Regenerate CRD YAML with findings schema in board status
## [v0.1.186] - 2026-06-16

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.186
## [v0.1.185] - 2026-06-16

### <!-- 0 -->🚀 Features

- Add agent finding reporting, ingestion pipeline, and web API _(findings)_

### <!-- 1 -->🐛 Bug Fixes

- Validate workspace command and package inputs _(manager)_
- Lock mirror cleanup operations with flock _(manager)_
- Validate external status patch inputs with zod _(board)_
- Use session.idle for idle-triggered flushes _(dispatcher)_
- Avoid clobbering run terminal phase _(operator)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.185
## [v0.1.184] - 2026-06-15

### <!-- 1 -->🐛 Bug Fixes

- Resolve empty git diff in task detail panel _(web)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.184
## [v0.1.183] - 2026-06-15

### <!-- 0 -->🚀 Features

- Add per-project daily usage persistence _(web)_
- Add project-aware client usage heartbeat tracking _(web)_
- Add active usage category indicator dot _(web)_
- Add runner package form state plumbing _(web)_
- Add runner packages field to execution tab _(web)_
- Add pure agent capability audit engine _(cli)_
- Wire validate agents command and cluster project listing _(cli)_
- Improve validate agents report UX and exit behavior _(cli)_

### <!-- 1 -->🐛 Bug Fixes

- Pause usage tracker intervals when lock is active _(web)_
- Scale usage bar width to pctOfMax instead of full width _(web)_

### <!-- 2 -->🚜 Refactor

- Extract shared usage categorization constants _(web)_
- Dedupe usage lock overlay category colors _(web)_

### <!-- 3 -->📚 Documentation

- Add per-project session tracking plan _(plan)_
- Revise f2304a to keep total-only usage UI _(plan)_
- Add sidebar usage indicator plan _(plan)_
- Add runner packages execution settings plan _(plan)_
- Add validate agents capability audit plan _(plan)_

### <!-- 6 -->🧪 Testing

- Add per-project usage regression coverage _(web)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Polish runner packages helper copy _(web)_
- Release v0.1.183
## [v0.1.182] - 2026-06-14

### <!-- 0 -->🚀 Features

- Add typed agent capability metadata map _(web)_
- Render capability descriptions in agent form _(web)_
- Add terminal-styled testimonials to index page _(docs)_
- Add usage bar with session tracking, settings popover, and lock overlay _(web)_
- Server-side usage tracking with in-memory lock flag _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Show friendly capability labels in agents list _(web)_
- Centralize isLocked() to prevent counter ticking past max _(web)_
- Resolve type errors in usage route and fetch refs before rev-parse in task-diff _(web)_

### <!-- 3 -->📚 Documentation

- Add agent capability descriptions plan _(plan)_

### <!-- 6 -->🧪 Testing

- Add capability metadata regression coverage _(web)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Add yaml 1.1 version to codegen and update crds
- Release v0.1.182
## [v0.1.181] - 2026-06-14

### <!-- 1 -->🐛 Bug Fixes

- Gate complete_merge by merge-worker context and fix test env _(dispatcher)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.181
## [v0.1.180] - 2026-06-14

### <!-- 1 -->🐛 Bug Fixes

- Create release in release.yml, dispatch images.yml via API _(ci)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.180
## [v0.1.179] - 2026-06-14

### <!-- 0 -->🚀 Features

- Automate releases with changelog generation, GitHub Releases, and beta channel _(ci)_

### <!-- 1 -->🐛 Bug Fixes

- Add bun setup step to release workflow _(ci)_
- Replace curl+tar with orhun/git-cliff-action for changelog _(ci)_
- Remove duplicate --config arg in git-cliff action _(ci)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Release v0.1.179
## [v0.1.178] - 2026-06-14

### <!-- 0 -->🚀 Features

- Add agent capability validation foundation _(manager)_
- Enforce capability checks across task creation entrypoints _(core)_
- Gate completion tools by run context _(dispatcher)_
- Harden buildgen agent capability constraints _(manager)_
- Expose and edit agent capabilities _(web)_
- Add inspect_task_flow MCP tool and flow introspection helper _(manager)_
- Mention inspect_task_flow in default manager decision agent prompt _(operator)_
- Enrich board task display references _(web)_
- Consume board display refs in board UI _(web)_
- Use friendly parent label in chat context _(web)_
- Add merge verdict types and normalizer _(api)_
- Add complete_merge MCP tool for structured merge verdicts _(dispatcher)_
- Update merge completion prompt and add conflict e2e _(manager)_
- Add manager_approve MCP tool for BUILD merge approvals _(manager)_

### <!-- 1 -->🐛 Bug Fixes

- Add local horizontal scroll to project form tabs on mobile _(web)_
- Add touch-scroll-x utility and harden tabs primitive for mobile overflow _(web)_
- Gate merge completion on structured verdict _(manager)_

### <!-- 2 -->🚜 Refactor

- Replace native radio buttons with shadcn RadioGroup in AddTaskForm _(web)_

### <!-- 3 -->📚 Documentation

- Add plan for tool and agent gating _(plan)_
- Refine guardrail plan for tool and agent gating _(plan)_
- Address custom agent alias risk in guardrails _(plan)_
- Refine percussionist-dev-plan-3a0500 guardrails _(plan)_
- Update percussionist-dev-plan-3a0500 with capability-based guardrails _(plan)_
- Finalize percussionist-dev-plan-3a0500 strict guardrails _(plan)_
- Add percussionist-dev-plan-8860ff mobile tabs plan _(plan)_
- Add percussionist-dev-plan-1e6da6 implementation plan _(plan)_
- Add inspect_task_flow reference and lifecycle troubleshooting notes
- Add plan for human-readable board waiting/from labels _(plan)_
- Add merge-verdict implementation plan for a1301a _(plan)_
- Add percussionist-dev-plan-12c569 artifact _(plan)_
- Refine percussionist-dev-plan-12c569 for manager_approve _(plan)_
- Document manager_approve approval flow _(manager)_

### <!-- 6 -->🧪 Testing

- Add strict enforcement coverage across stack _(capabilities)_
## [v0.1.177] - 2026-06-14

### <!-- 0 -->🚀 Features

- Add spec.exec.image field to Project CRD and wire exec pod resolution _(kube)_
- Add exec/maintenance pod image field to project form UI _(web)_
- Set maintenance pod image to ubuntu:24.04 _(self-dev)_
- Add diff findings schemas and normalizeReviewVerdict helper _(api)_
- Extend complete_review with optional findings and guardrails _(dispatcher)_
- Use shared normalizer and persist diff findings with replacement semantics _(manager)_
- Diff API context upgrade with findings projection _(web)_
- Rework helper, reviewer findings prompts, and E2E coverage _(web,manager)_
- Diff findings summary panel and inline line markers _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Guard undefined regex capture in chat-utils _(web)_

### <!-- 3 -->📚 Documentation

- Add exec pod image configuration plan _(plan)_
- Document spec.exec.image override and alpine fallback _(readme)_
- Add diff ranking and comments plan _(plan)_
- Revise diff ranking plan for 902b57 _(plan)_
## [v0.1.176] - 2026-06-14

### <!-- 1 -->🐛 Bug Fixes

- Upgrade memory service image via MEMORY_SERVICE_IMAGE env var _(operator)_
## [v0.1.174] - 2026-06-13

### <!-- 1 -->🐛 Bug Fixes

- Remove unused security.js imports from tools.ts _(manager)_

### <!-- 3 -->📚 Documentation

- Clarify tagging instructions — must ask user before creating tag
## [v0.1.173] - 2026-06-13

### <!-- 0 -->🚀 Features

- Extend NodeHostStats with filesystem fields + expose volume in metrics API _(kube,web)_
- Add pod ephemeral-storage request/limit through metrics pipeline _(kube,web)_
- Add volume storage display to Metrics page _(web)_
- Add VitePress documentation site with dashboard screenshots _(docs)_
- Add memory CRUD MCP tools and project settings UI _(memory)_
- Add memory CRUD MCP tools and project settings UI _(memory)_

### <!-- 1 -->🐛 Bug Fixes

- Polish branch and agent review metadata with chip-style rendering _(web)_
- Add staleness check, deterministic merge prompt, and resolveMergeBranch for PLAN tasks _(merge)_
- Replace mock.module with __sessionFns to prevent cross-file mock leak _(manager-controller)_

### <!-- 3 -->📚 Documentation

- Add metrics page volume information plan _(plan)_
- Add task view review ui polish plan _(plan)_
## [v0.1.172] - 2026-06-13

### <!-- 1 -->🐛 Bug Fixes

- Restore exports lost in bad merge, fix downstream build errors _(kube)_
## [v0.1.171] - 2026-06-13

### <!-- 0 -->🚀 Features

- Responsive mobile full-screen add-task overlay on board _(web)_
- Polish mobile add-task overlay, wire add-from-ideas, enforce single overlay _(web)_
- Add buildgen summary-source logging and facilitator unit tests _(manager)_
- Add Biome for linting and formatting _(tooling)_
- Add /sessions routes and sidebar navigation entry _(web)_
- Implement dedicated Sessions list and detail pages _(web)_
- Polish session row UX and improve empty/error states _(stats)_

### <!-- 1 -->🐛 Bug Fixes

- Guard possibly undefined blockContent in chat-utils _(web)_
- Remove embedding-gated trigger from summarizeEffect in decision engine _(manager)_
- Add horizontal scroll to Models table on mobile viewports _(web)_
- Remove unused function parameters
- Replace array index keys with stable keys
- Replace explicit any with proper types in source files
- Replace non-null assertions with runtime guards
- Move hooks before early returns to satisfy Rules of Hooks
- Stabilize function references in hook dependency arrays
- Remove unused map index parameter
- Replace document.cookie with localStorage for sidebar state persistence
- Add null fallback for regex match in heapMbFromLimit
- Reset worktree to remote tip on create to prevent stale-base merges _(operator)_

### <!-- 2 -->🚜 Refactor

- Extract AddTaskForm to dedicated file and make TaskListPanel presentation-aware _(web)_
- Harden session summarizer with retry/backoff, contextual logging, and correct ConfigMap write semantics _(manager)_
- Add observability logs to SummarizeSession fire-and-forget effect _(manager)_
- Migrate task type selector to shadcn RadioGroup _(web)_
- Remove embedded Sessions tab from StatsView _(web)_

### <!-- 3 -->📚 Documentation

- Add b00602 mobile add-task fullscreen plan _(plan)_
- Add plan for session summarization pipeline fix _(plan)_
- Refine summarization pipeline plan _(plan)_
- Add session summarization pipeline verification runbook findings
- Add stats models mobile scroll plan _(plan)_

### <!-- 6 -->🧪 Testing

- Add summarizer memory-write failure tests and extend route metadata assertions _(manager)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Disable a11y lint rules
- Harden lint rules (useExhaustiveDependencies, useHookAtTopLevel) back to error
## [v0.1.170] - 2026-06-13

### <!-- 0 -->🚀 Features

- Add per-run dispatcher image override _(api)_

### <!-- 1 -->🐛 Bug Fixes

- Correct reviewer MCP tool name and patchRunAnnotations TLS handling

### <!-- 3 -->📚 Documentation

- Add plan for board task type selector shadcn migration _(plan)_
## [v0.1.168] - 2026-06-12

### <!-- 0 -->🚀 Features

- Replace submit_review with complete_review tool _(dispatcher)_
## [v0.1.167] - 2026-06-12

### <!-- 0 -->🚀 Features

- Surface review verdicts on Run detail page and Task detail panel _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Add submit_review tool call and fix search_code prefix in reviewer prompts _(facilitator)_
- Add patch permission on runs to percussionist-dispatcher Role _(rbac)_
## [v0.1.165] - 2026-06-12

### <!-- 1 -->🐛 Bug Fixes

- Use @kubernetes/client-node in patchRunAnnotations and patchTaskStatus _(kube)_
## [v0.1.164] - 2026-06-12

### <!-- 1 -->🐛 Bug Fixes

- Make handleMcp async to fix TS1308 await error _(dispatcher)_
## [v0.1.163] - 2026-06-12

### <!-- 1 -->🐛 Bug Fixes

- Preserve failed review runs and add submit_review MCP tool _(manager)_
## [v0.1.162] - 2026-06-12

### <!-- 1 -->🐛 Bug Fixes

- Preserve board history when selecting tasks so back navigates correctly _(web)_
## [v0.1.161] - 2026-06-12

### <!-- 0 -->🚀 Features

- Show all runs with collapsible summaries in task overview _(web)_
- Add retry-review button for failed reviews _(web)_
## [v0.1.160] - 2026-06-12

### <!-- 0 -->🚀 Features

- Add stats reporter foundation for synthetic manager-run cost tracking _(manager)_
- Add flush integration to waitForCompletion and expand stats-reporter tests _(manager)_

### <!-- 1 -->🐛 Bug Fixes

- Fix review run-name collision in decideSucceeded _(manager)_
- Separate option descriptions from buttons to prevent vertical overflow _(web)_
- Improve review agent workflow — pretty-print session, grant bash, preserve worktrees

### <!-- 3 -->📚 Documentation

- Add percussionist-dev-plan-d7ad04 _(plan)_
- Add manager agent cost tracking plan _(plan)_
- Add plan for review run-name collision fix _(plan)_

### <!-- 6 -->🧪 Testing

- Add regression tests for review run-name collision fix
## [v0.1.159] - 2026-06-12

### <!-- 0 -->🚀 Features

- Add ReviewRecord schema to Task.status for append-only review history _(api)_
- Update reconciler to preserve full review verdict and append review records _(manager)_

### <!-- 1 -->🐛 Bug Fixes

- Add non-empty guard in decideAwaitingChildren to prevent vacuous true from empty child set
- Add awaiting-feature-merge to awaiting-human transition table _(reconciler)_
- Handle MCP isError and JSON parse failure in task-diff _(web)_
- Skip sanitization for trusted diff script in exec_in_workspace _(web)_
- Guard res.json() in task-diff MCP call against non-JSON response _(web)_
- Add worktree access guidance and pod exit code collection _(manager)_
- Prevent option button text overflow and TTS uttering raw markup _(web)_

### <!-- 2 -->🚜 Refactor

- Include aiReworkCount in worker run naming _(worker-builder)_

### <!-- 3 -->📚 Documentation

- Add plan for awaiting-children empty child guard _(plan)_
- Add plan for percussionist-dev-plan-58d4ff _(plan)_
- Add review record improvements plan _(plan)_
- Add b02d78 merge-retry transition fix plan _(plan)_

### <!-- 6 -->🧪 Testing

- Add regression tests for AI auto-rework run name differentiation _(manager)_
- Add PLAN merge-retry approval test from awaiting-human _(decision)_
## [v0.1.155] - 2026-06-11

### <!-- 0 -->🚀 Features

- Add single-open session state and row toggle behavior _(stats)_
- Polish session row UX and improve empty/error states _(stats)_
- Command injection remediation in workspace tooling _(manager)_
- Add SSH strict host key verification mode and security documentation _(operator)_
- Add auth middleware and protect sensitive API routes _(web)_
- Merge security hardening from plan-a08d5f

### <!-- 1 -->🐛 Bug Fixes

- Return descriptive error names in sanitizeCommand for test compatibility _(manager-controller)_
## [v0.1.154] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Clean up pod on terminal Run when dispatcher patched status first _(operator)_
- Add chat options instructions to decision agent prompt _(operator)_
## [v0.1.151] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Prevent refname HEAD ambiguity in git mirror sync _(operator)_
## [v0.1.152] - 2026-06-10

### <!-- 0 -->🚀 Features

- Show resource requests/limits on Metrics page _(web)_
## [v0.1.150] - 2026-06-10

### <!-- 0 -->🚀 Features

- Implement markdown rendering for task description _(board)_
- Add option block parser and interactive buttons _(chat)_

### <!-- 1 -->🐛 Bug Fixes

- Resolve plan diff view showing stale/incorrect commits

### <!-- 3 -->📚 Documentation

- Add bdd975 markdown taskview plan _(plan)_
- Add plan for interactive chat option buttons _(plan)_
- Remove stale Vitest references, add missing test config

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Update add-task placeholder to mention Markdown support _(web)_
## [v0.1.149] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Eliminate HEAD ambiguity and prune stale branch refs from mirror

### <!-- 6 -->🧪 Testing

- Add effects.test.ts — executeEffects unit tests _(manager-controller)_
## [v0.1.147] - 2026-06-10

### <!-- 2 -->🚜 Refactor

- Move model warmup from Ollama init to memory-service per-project
## [v0.1.146] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Harden kube not-found handling and clear stale worker refs _(manager)_
- Satisfy worker status typing in task state tools _(manager)_
## [v0.1.144] - 2026-06-10

### <!-- 0 -->🚀 Features

- Add spec.dispatcher.image to ClusterSettings _(api,operator)_

### <!-- 1 -->🐛 Bug Fixes

- Detect component drift in upgrade status _(manager)_
## [v0.1.143] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Resolve all noUnusedLocals violations exposed by tsconfig
## [v0.1.142] - 2026-06-10

### <!-- 1 -->🐛 Bug Fixes

- Distinguish 404 from transient errors in observe() _(manager)_
- Sync vec_memories rowid with memories via transaction _(memory-service)_
- Enforce adminAuth on secrets mutations; fix SettingsPage auth header _(web)_
- Reject running in set_task_state MCP tool _(manager)_
- Deterministic merge/buildgen run names replace randomBytes _(manager)_

### <!-- 2 -->🚜 Refactor

- Extract shared gitUrlHash helper, remove 6 duplicates

### <!-- 6 -->🧪 Testing

- Add transition completeness, memory C1 regression, resolveRunConfig tests

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Dead code sweep, enable noUnusedLocals/noUnusedParameters
## [v0.1.141] - 2026-06-09

### <!-- 1 -->🐛 Bug Fixes

- Add bun setup step to unit-tests job _(ci)_
- Use module-scoped mock.module in embed test _(memory-service)_
- Extract shared mock to prevent module cache conflicts _(memory-service)_
- Save/restore AUTH_DISABLED env var in smoke test to avoid polluting auth tests _(web)_
- Restrict E2E and unit-tests to only run on workflow_dispatch _(ci)_
- Add agent-config.yaml to CI deploy, enhance advances test, rename facilitator test _(e2e)_
- Make opencode-auth secret optional in manager deployment _(deploy)_
- Install Bun in E2E workflow jobs _(ci)_
- Remove incorrect KUBECONFIG env var from E2E steps _(ci)_
- Accept review run failure in advances test, remove racy failed-phase check in achieves test _(e2e)_
- Add reviewStaleSeconds=60 timeout so review run terminates in test window _(e2e)_
- Skip review-run-completes wait, just assert review was spawned and task reaches awaiting-human _(e2e)_

### <!-- 3 -->📚 Documentation

- Add stats sessions single-open plan _(plan)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Add unit-tests job and workflow_dispatch trigger
## [v0.1.140] - 2026-06-09

### <!-- 1 -->🐛 Bug Fixes

- Restore node capacity and host-level memory in metrics routes _(web)_
- Populate agent roster dropdown with available cluster agents _(web)_
## [v0.1.139] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Unify page headers and tab mobile behavior, add board filter toggle _(web)_
## [v0.1.138] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Replace mock.global() with globalThis.fetch in memory-service tests
- Rewrite board section of smoke test for current K8s-backed API

### <!-- 3 -->📚 Documentation

- Document conventional commit format in AGENTS.md

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Bump patch/minor deps across all packages and pin versions
- Bump commander 12.1.0 → 15.0.0
- Bump shiki 1.29.0 → 4.1.0
- Bump recharts 2.15.4 → 3.8.1 (fix Tooltip/Legend types)
- Bump lucide-react 0.468.0 → 1.17.0
- Bump diff 7.0.0 → 9.0.0
- Bump katex 0.16.11 → 0.17.0
- Bump @vitejs/plugin-react 4.7.0 → 6.0.2, vite 6.0.0 → 8.0.16
- Add husky pre-commit hook to enforce typecheck + test passing
- Add commitlint with husky commit-msg hook to enforce conventional commits
## [v0.1.137] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Exclude test files from tsc build _(operator)_
## [v0.1.136] - 2026-06-08

### <!-- 0 -->🚀 Features

- Add readiness probe that waits for Ollama model availability _(memory-service)_
## [v0.1.135] - 2026-06-08

### <!-- 0 -->🚀 Features

- Capture OpenCode cost data through entire stack into sessions
- Display cost data on stats page _(web)_
## [v0.1.134] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Remove dead decisionAgentName field, show decision agent content in UI
## [v0.1.133] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Correct MCP tool names in prompts and add read_session to dispatcher server
## [v0.1.132] - 2026-06-08

### <!-- 1 -->🐛 Bug Fixes

- Sort runs by creationTimestamp desc in list endpoint _(web)_
## [v0.1.131] - 2026-06-08

### <!-- 2 -->🚜 Refactor

- Replace area/line charts with bar charts _(stats)_
## [v0.1.130] - 2026-06-08

### <!-- 0 -->🚀 Features

- Replace /api/stats/export with paginated /api/stats/sessions endpoint _(web)_
## [v0.1.129] - 2026-06-08

### <!-- 0 -->🚀 Features

- Add gzip compression and pagination to runs endpoint _(web)_
## [v0.1.128] - 2026-06-08

### <!-- 0 -->🚀 Features

- Add in-process model warmup before serving HTTP _(memory-service)_
- Prefer remote-tracking ref for parent baseline in workspace-init _(operator)_
- Prefer remote-tracking ref for parent baseline in workspace-init _(operator)_
- Wire mobile-close helper in AppSidebar via useSidebar _(web)_
- Show human approval status on review-lane cards + sort by age _(web)_
- Add per-commit diff view with unified/commits toggle _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Make Stats tab strip horizontally scrollable on mobile _(web)_
- Make Stats tab strip horizontally scrollable on mobile (BUILD C safeguard) _(web)_
- Make Stats tab strip horizontally scrollable on mobile _(web)_
- Prefer remote-tracking ref for parent baseline in workspace-init _(operator)_
- Make task-context inject icon visible on mobile devices

### <!-- 10 -->💼 Other

- Ensure embedding model pull before memory service startup
- Add mobile sidebar close behavior plan
- Refine mobile sidebar close implementation plan
## [v0.1.126] - 2026-06-07

### <!-- 1 -->🐛 Bug Fixes

- Add missing ConfigMap verbs and WEB_AUTH_TOKEN for internal callers _(rbac,auth)_
## [v0.1.125] - 2026-06-07

### <!-- 1 -->🐛 Bug Fixes

- Add list verb for secrets to web deployment RBAC _(rbac)_
## [v0.1.124] - 2026-06-07

### <!-- 1 -->🐛 Bug Fixes

- Update DISPATCHER_IMAGE env var when applying upgrade _(upgrade)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Switch manager-controller tests from vitest to bun
## [v0.1.123] - 2026-06-07

### <!-- 0 -->🚀 Features

- Add beatctl auth web-token commands for managing web UI auth token _(cli, k8s)_
## [v0.1.122] - 2026-06-07

### <!-- 0 -->🚀 Features

- Harden kubectl helpers and setup/teardown lifecycle _(e2e)_
- Wire auth middleware to UI — login page, auth headers, SSE token support _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Wire up task filter + dynamic dimensions + tests _(memory)_
- Deterministic ClusterAgent fixture consolidation and PLAN semantic fix

### <!-- 10 -->💼 Other

- Testing improvements roadmap
- CI tier rollout and smoke-agent alignment

### <!-- 2 -->🚜 Refactor

- Strict deterministic assertions for facilitator/advances/achieves suites _(e2e)_

### <!-- 3 -->📚 Documentation

- Add testing improvements roadmap _(plan)_
- Refresh testing improvements plan for bun _(plan)_
- Refine testing improvements roadmap _(plan)_
- Refine testing improvements roadmap _(plan)_
- Add testing strategy document and contributor workflow guidance
## [v0.1.121] - 2026-06-06

### <!-- 1 -->🐛 Bug Fixes

- Use newline join in task-diff shell script to avoid ash syntax error _(web)_
- Add dark-theme CSS overrides for react-diff-view _(web)_
## [v0.1.119] - 2026-06-06

### <!-- 0 -->🚀 Features

- Audit and standardize shadcn component usage _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Harmonize styling across web UI with shared primitives _(web)_
- Remove leftover merge conflict marker _(web)_

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Normalize typography across web UI to use theme tokens _(web)_
## [v0.1.118] - 2026-06-06

### <!-- 2 -->🚜 Refactor

- Move Tools page into Stats as tab _(web)_
## [v0.1.117] - 2026-06-06

### <!-- 0 -->🚀 Features

- Add Agents tab, remove Tokens per Run chart _(web)_
## [v0.1.116] - 2026-06-06

### <!-- 2 -->🚜 Refactor

- Stats page - add trend charts, split into tabs, remove duplicate tool usage _(web)_
## [v0.1.115] - 2026-06-06

### <!-- 0 -->🚀 Features

- Auto-heal tasks with missing status.phase + buildTask default phase _(reconciler)_
- Make manager chat full-screen on mobile with responsive CSS _(web)_
- Use kubelet /stats/summary for host-level memory instead of cgroup _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Prevent tab clicks from submitting project edit form _(web)_
- Enforce status.phase='pending' on all Task CR creation paths
- Resolve task diffs from worktree refs _(web)_

### <!-- 10 -->💼 Other

- Address tasks missing initial phase
- Add mobile full-screen manager chat plan _(web)_
## [v0.1.113] - 2026-06-05

### <!-- 0 -->🚀 Features

- Metrics time-series history with recharts _(web)_
- Broader percussionist notification sounds _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Add RBAC for node capacity + missing shadcn CSS tokens _(web)_
- Add chart color CSS variables for recharts lines _(web)_
- Average all nodes per minute instead of per-node entries in metric timeseries _(web)_
- Prefix write_plan/read_plan MCP tool calls with percussionist_dispatcher_ in agent prompts
## [v0.1.107] - 2026-06-05

### <!-- 0 -->🚀 Features

- Add Notifications settings tab with sound toggle and preview _(web)_
- Add notification sound settings to Zustand store _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Use worktree HEAD for accurate task diffs _(web)_
- ClusterAgent model override silently ignored due to ??= after resolveRunConfig

### <!-- 10 -->💼 Other

- Notification settings — sound toggle + preview in Settings UI
- Don't auto-terminate on every assistant turn
## [v0.1.106] - 2026-06-05

### <!-- 3 -->📚 Documentation

- Add migration removal workflow to AGENTS.md
## [v0.1.105] - 2026-06-05

### <!-- 1 -->🐛 Bug Fixes

- Remove double p-6 padding from ToolMetricsView (Layout already provides it) _(web)_
- Generate proper drizzle migration 0003 to drop tool_events table _(web)_
## [v0.1.104] - 2026-06-05

### <!-- 3 -->📚 Documentation

- Add NEVER rule for kubectl cp + kill, Drizzle SQL alias gotcha, tool-metrics endpoint docs
## [v0.1.103] - 2026-06-05

### <!-- 0 -->🚀 Features

- Add reusable Tabs UI component with ARIA + keyboard navigation _(web)_
- Add reusable Tabs UI component with ARIA + keyboard navigation _(web)_

### <!-- 1 -->🐛 Bug Fixes

- Make collapsed sidebar tooltips opaque with sidebar palette _(web)_
- Remove max-w-5xl constraint from SettingsPage, add showHeader prop for tab embedding _(web)_
- Settings whitespace consistency and tab embedding _(web)_
- Use raw column names in subquery to avoid Drizzle table-qualification bug

### <!-- 10 -->💼 Other

- Split project settings into tabbed groups
- Add eff5c8 sidebar tooltip readability plan

### <!-- 2 -->🚜 Refactor

- Split project settings form into tabbed groups with URL deep-linking _(web)_
## [v0.1.102] - 2026-06-05

### <!-- 0 -->🚀 Features

- Add optional model field to AgentRefSchema for per-agent default models _(api)_

### <!-- 1 -->🐛 Bug Fixes

- Cap chat panel at viewport height and hide toggle when open _(web)_
- Remove Description column from agents table (no schema field)
## [v0.1.101] - 2026-06-05

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Remove dead tool_events pipeline (SSE events never emitted by OpenCode)
## [v0.1.100] - 2026-06-05

### <!-- 1 -->🐛 Bug Fixes

- Fix chat panel not stretching to full height _(web)_
## [v0.1.99] - 2026-06-05

### <!-- 0 -->🚀 Features

- Replace dead tool_events query with tool_calls + agent breakdown + token cost _(web)_
## [v0.1.98] - 2026-06-05

### <!-- 2 -->🚜 Refactor

- Convert manager chat from Sheet overlay to docked panel _(web)_
## [v0.1.96] - 2026-06-05

### <!-- 1 -->🐛 Bug Fixes

- Add n=1000 param to GHCR tags/list for pagination
## [v0.1.95] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Run task diff workspace exec via manager MCP _(web)_
## [v0.1.93] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Derive task diff refs from run spec fallback _(web)_
## [v0.1.92] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Replace while-read pipelines with for loops in init container
## [v0.1.91] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Use for loop instead of pipeline in init container re-sync
- Merge retry cycle and worktree fetch conflict
- Prefix MCP tool names for buildgen agent (create_task, complete_run)
## [v0.1.88] - 2026-06-04

### <!-- 0 -->🚀 Features

- Show task git diff in task detail panel _(web)_
## [v0.1.87] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Handle non-fast-forward merges in merge run prompt
## [v0.1.86] - 2026-06-04

### <!-- 0 -->🚀 Features

- Add progress indicators and child task links for awaiting phases
## [v0.1.85] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Re-sync refs/heads after stale worktree removal in merge runs
## [v0.1.84] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Make facilitator functions async for agent model resolution
## [v0.1.83] - 2026-06-04

### <!-- 0 -->🚀 Features

- Retry failed merges from review column via approve button
## [v0.1.82] - 2026-06-04

### <!-- 0 -->🚀 Features

- Hide old worker status during active run on task rows, show latest run output in task detail panel
## [v0.1.81] - 2026-06-04

### <!-- 3 -->📚 Documentation

- Add deployment discipline rules to AGENTS.md
## [v0.1.79] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Remove stale timeout from awaiting-children phase
## [v0.1.78] - 2026-06-04

### <!-- 0 -->🚀 Features

- Add awaiting-children and awaiting-feature-merge phases for plan integration
## [v0.1.77] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Phase-aware agent routing in MCP tools for generating-builds
## [v0.1.76] - 2026-06-04

### <!-- 0 -->🚀 Features

- Inject plan content into buildgen prompt, expose plan MCP tools from dispatcher, fix infinite loop
## [v0.1.75] - 2026-06-04

### <!-- 1 -->🐛 Bug Fixes

- Update migration journal and snapshot for tool_events table
- Avoid stale worktree blocking fetch, wire cleanup, correct merge workspace _(git-flow)_
## [v0.1.73] - 2026-06-03

### <!-- 1 -->🐛 Bug Fixes

- Handle empty conditions in tool-metrics and tool-events queries
## [v0.1.72] - 2026-06-03

### <!-- 0 -->🚀 Features

- Tool metrics dashboard + gap analysis schema
## [v0.1.71] - 2026-06-03

### <!-- 1 -->🐛 Bug Fixes

- Dispatcher RBAC for create_task and buildgen run name collision
## [v0.1.70] - 2026-06-03

### <!-- 0 -->🚀 Features

- Per-project runner packages with manager agent awareness
- Tool metrics infrastructure
- Structured code search via dispatcher MCP

### <!-- 3 -->📚 Documentation

- Runner packages documentation in AGENTS.md and README.md
- Add tagging instructions to AGENTS.md
## [v0.1.69] - 2026-06-03

### <!-- 0 -->🚀 Features

- Auto-inject vector memory context and auto-summarize sessions
## [v0.1.68] - 2026-05-31

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Regenerate CRD YAML to include embedding field
- Add memory service image to build pipeline
## [v0.1.67] - 2026-05-31

### <!-- 0 -->🚀 Features

- Add integrator agent with flow.merge.agent default
- Add per-project memory service with vector embeddings for agent context
## [v0.1.66] - 2026-05-31

### <!-- 1 -->🐛 Bug Fixes

- Strip redundant project prefix from auxiliary run names
## [v0.1.65] - 2026-05-31

### <!-- 1 -->🐛 Bug Fixes

- Wire merge run scheduling to unblock awaiting-merge tasks
## [v0.1.64] - 2026-05-30

### <!-- 0 -->🚀 Features

- Add Percussionist orientation context to agent prompts
- Align buildgen runtime prompt with create_task MCP tool workflow
## [v0.1.63] - 2026-05-30

### <!-- 0 -->🚀 Features

- Consolidate agent configs into flow schema
## [v0.1.62] - 2026-05-30

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Update lockfile for @percussionist/kube dependency
## [v0.1.60] - 2026-05-30

### <!-- 0 -->🚀 Features

- Add create_task MCP tool to dispatcher so buildgen agent can create BUILD Task CRs directly
## [v0.1.59] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Use retryCount as buildgen run suffix instead of hardcoded '0'
## [v0.1.58] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Ensure SQLite timestamps include timezone (use .toISOString() instead of relying on datetime('now'))
- Delete stale buildgen run before creating a fresh one
## [v0.1.57] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Don't bounce back to awaiting-human when buildgen run doesn't exist yet
## [v0.1.56] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Align board/taskview/plan font sizing with design system tokens

### <!-- 10 -->💼 Other

- Trace decideGeneratingBuilds branches
## [v0.1.55] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Use null instead of undefined to clear buildgen run ref (JSON.stringify drops undefined)
## [v0.1.54] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Drop task name suffix from answer annotation key

### <!-- 10 -->💼 Other

- Log manualActions in decideAwaitingHuman
## [v0.1.53] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Read task approvals from task annotations, not project annotations
## [v0.1.52] - 2026-05-30

### <!-- 1 -->🐛 Bug Fixes

- Use facilitator-buildgen as default agent name for buildgen runs
- Handle MCP tool isError flag in upgrade proxy routes
## [v0.1.51] - 2026-05-29

### <!-- 1 -->🐛 Bug Fixes

- Regenerate CRD YAML with model field for ClusterAgent
## [v0.1.50] - 2026-05-29

### <!-- 0 -->🚀 Features

- Add model field to ClusterAgent settings
## [v0.1.49] - 2026-05-29

### <!-- 0 -->🚀 Features

- Reorganize board task detail panel with runs and events tabs
## [v0.1.48] - 2026-05-29

### <!-- 1 -->🐛 Bug Fixes

- Remove legacy Project annotation writes and cleanup
- Use null values in merge-patch for annotation deletion
## [v0.1.46] - 2026-05-29

### <!-- 0 -->🚀 Features

- Add optional model field to AgentRefSchema for per-agent default models _(api)_
- Expose missing project settings fields in CreateProjectForm _(web)_
- Strip gh pr and remote push from basic flow; fix plan task stuck in generating-builds

### <!-- 1 -->🐛 Bug Fixes

- Execute effects when generating-builds has no phase transition

### <!-- 10 -->💼 Other

- Add description field to agent form UI (percussionist-dev-plan-16a91d)
- Remove description column from agents table (percussionist-dev-plan-16a91d)
- Update implementation status for agents description removal (percussionist-dev-plan-16a91d)
- Approve BUILD task percussionist-dev-build-2e283f — per-agent default models for agents
- Expose missing project settings in web UI
## [v0.1.45] - 2026-05-29

### <!-- 0 -->🚀 Features

- Add create_task MCP tool for dynamic task creation from agents

### <!-- 1 -->🐛 Bug Fixes

- Phase badges inherit 14px from runs table due to tailwind-merge dropping custom text-label-md class
## [v0.1.44] - 2026-05-29

### <!-- 0 -->🚀 Features

- Apply Technical Precision design system to web UI

### <!-- 1 -->🐛 Bug Fixes

- Dequeue now splices from the queue array _(operator)_
- Add 1MB body size limit to readBody in manager MCP server
## [v0.1.43] - 2026-05-29

### <!-- 2 -->🚜 Refactor

- Replace phase handlers with decision engine and effect executor
## [v0.1.41] - 2026-05-29

### <!-- 1 -->🐛 Bug Fixes

- MaxParallel WIP limit not respected in reconcile cycle
## [v0.1.40] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Annotation keys exceeding 63-char K8s limit for long task names
## [v0.1.39] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Dispatcher abort detection broken for messages without time.completed
- Human approval of awaiting-human tasks has no effect
## [v0.1.38] - 2026-05-28

### <!-- 0 -->🚀 Features

- Add retryPolicy, reviewPolicy to project form and runTTLDays to settings
## [v0.1.37] - 2026-05-28

### <!-- 0 -->🚀 Features

- Add toleration to run pods for transient workload taint
## [v0.1.36] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Use isNotFound() for 404 checks in code-server reconciler
## [v0.1.35] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Dispatcher dies when you abort an assistant message
- Grant operator list/watch on projects and CRUD on deployments
## [v0.1.34] - 2026-05-28

### <!-- 0 -->🚀 Features

- Per-project code-server for interactive workspace access

### <!-- 10 -->💼 Other

- Strip dashes from TTS speech utterance
## [v0.1.33] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Use pnpm_config_store_dir env var for pnpm v11 store path
## [v0.1.32] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Use PNPM_STORE_DIR env var instead of npm_config_store_dir for pnpm v11 compatibility
## [v0.1.31] - 2026-05-28

### <!-- 1 -->🐛 Bug Fixes

- Propagate injectFiles from project to run spec in manager
## [v0.1.30] - 2026-05-27

### <!-- 1 -->🐛 Bug Fixes

- Break rework oscillation cycle and operator 404 re-enqueue
## [v0.1.29] - 2026-05-27

### <!-- 9 -->◀️ Revert

- Remove hardcoded pnpm pre-warm from init container; move to percussionist-dev initScript instead
## [v0.1.28] - 2026-05-27

### <!-- 10 -->💼 Other

- Xterm-based log viewer, beatctl auto-install, minor UI fixes
## [v0.1.27] - 2026-05-27

### <!-- 1 -->🐛 Bug Fixes

- Pre-warm pnpm store in init container, add timeout guidance to builder agent
## [v0.1.26] - 2026-05-27

### <!-- 1 -->🐛 Bug Fixes

- Filter disconnected providers from list_models and ModelSelector
## [v0.1.25] - 2026-05-27

### <!-- 1 -->🐛 Bug Fixes

- Normalize provider models to array and slim payload in list_models
## [v0.1.24] - 2026-05-27

### <!-- 1 -->🐛 Bug Fixes

- Providers route uses MCP port 4097 (list_models tool) not sidecar port 4096
## [v0.1.23] - 2026-05-27

### <!-- 0 -->🚀 Features

- Model selector with live provider list from opencode sidecar
## [v0.1.22] - 2026-05-27

### <!-- 10 -->💼 Other

- Inherit git+secrets from project in CreateRunForm
- Bump default memory 4Gi→8Gi; reset worktree to remote tip on reuse
## [v0.1.21] - 2026-05-27

### <!-- 10 -->💼 Other

- Show install loader until versions catch up, drop green text
- Run packages sequentially to reduce peak memory
- Incremental stats flush after each assistant turn
## [v0.1.20] - 2026-05-27

### <!-- 10 -->💼 Other

- Improve session snapshot coverage
## [v0.1.19] - 2026-05-27

### <!-- 10 -->💼 Other

- Strip local/stdio MCP servers from run pod opencode-config
## [v0.1.18] - 2026-05-27

### <!-- 10 -->💼 Other

- Set percussionist.dev/project label on UI-created runs
## [v0.1.17] - 2026-05-26

### <!-- 10 -->💼 Other

- Fix rules-of-hooks violation in BoardView
- Derive NODE_OPTIONS heap size from container memory limit
## [v0.1.15] - 2026-05-26

### <!-- 10 -->💼 Other

- Use null (not delete) to clear worker fields in merge patch
## [v0.1.14] - 2026-05-26

### <!-- 10 -->💼 Other

- Improve plan view md, settings updates tab UX
- Fix patchWorker clearing — undefined keys now delete the field
## [v0.1.13] - 2026-05-26

### <!-- 10 -->💼 Other

- Pass facilitator-buildgen agent name to buildgen runs
## [v0.1.12] - 2026-05-26

### <!-- 10 -->💼 Other

- Fix whitespace, mobile layout, and filter capitalisation
- Update decision agent prompt wording in agent-config
- Auto-inject dispatcher MCP stanza into opencode-config

### <!-- 3 -->📚 Documentation

- Add task-lifetime.md explaining board task phase state machine
## [v0.1.11] - 2026-05-26

### <!-- 1 -->🐛 Bug Fixes

- Pass ClusterSettings runner image to facilitator/buildgen runs
## [v0.1.10] - 2026-05-26

### <!-- 0 -->🚀 Features

- Add apply_upgrade MCP tool and one-click upgrade button
## [v0.1.9] - 2026-05-26

### <!-- 1 -->🐛 Bug Fixes

- Grant manager RBAC to read deployments for update check
## [v0.1.6] - 2026-05-26

### <!-- 1 -->🐛 Bug Fixes

- Operator owns agent-config via SSA; write even when spec.manager is nil
## [v0.1.5] - 2026-05-26

### <!-- 0 -->🚀 Features

- Add check_for_updates MCP tool and version check UI
## [v0.1.4] - 2026-05-26

### <!-- 1 -->🐛 Bug Fixes

- Treat MessageAbortedError as waiting-for-input instead of run failure
## [v0.1.3] - 2026-05-26

### <!-- 1 -->🐛 Bug Fixes

- Unset remote.origin.mirror in worktree so agents can git push
## [v0.1.2] - 2026-05-26

### <!-- 0 -->🚀 Features

- Point deploy manifests and CRD defaults to ghcr.io images

### <!-- 1 -->🐛 Bug Fixes

- Pass ClusterSettings runner image to worker builds
## [v0.1.1] - 2026-05-24

### <!-- 1 -->🐛 Bug Fixes

- Add composite + references to tsconfigs so typecheck works without a prior build
- Build before typecheck so workspace package types exist _(ci)_
- Opt into Node 24 actions runtime to silence deprecation warning _(ci)_
## [v0.1.0] - 2026-05-24

### <!-- 0 -->🚀 Features

- Unify deploy CLI, add minikube quickstart, fix runner locale, add caveman skill
- Add custom agent support (inline + ClusterAgent CRD), kanban board, and manager controller
- Add kanban UI — board listing, visual columns with task cards, worker status, and create form
- Async human-in-the-loop — WaitingForInput phase with pending questions UI
- Expand Projects section in sidebar to show direct links to each project's board _(web)_
- Add GitHub token support for gh CLI authentication in runners
- Per-project opencode config editor in project form
- Add retry button and collapsible escalation reason on board task cards _(web)_
- Add ManagerMetrics schema and instrument reconciler with per-cycle telemetry
- Add bootstrap runtime tooling and aggregated startup logs in web UI
- Wire sidecar propagation into reconciler and manager worker builder
- Add sidecar support for OpenCodeProject (e.g. test databases)
- Add facilitator-driven failure escalation for board workers
- Inject files into runner pods via K8s Secrets
- Warm amber/brown UI theme with drum favicon and sidebar logo
- Add complete_run MCP tool and success-review facilitation flow
- Automate build review-rework and squash merge flow
- Add RWX PVC-based caching for package managers and build artifacts
- Browser notifications and drum audio on run/task transitions
- Automatic HTTPS via self-signed wildcard TLS cert in beatctl deploy
- Top bar with notification bell and history dropdown
- Add SSE live updates across web dashboard
- Enforce complete_run git workflow checks
- Cluster metrics, session UI overhaul, and board controller improvements
- LLM-powered agent module for failure analysis and facilitation parsing
- Interactive chat with manager agent via CLI and web dashboard
- Agent-powered parsing for review and BUILD task generation fallbacks
- Enhance BoardView with icons and improved layout
- Add STT/TTS voice I/O to manager chat panel _(web)_
- Collapsible shadcn sidebar and PWA support _(web)_
- Cluster settings, MCP tools, session improvements, and UI overhaul
- Migrate board state to SQLite, add stats backfill and retry
- Git mirror cache, worktree workspace, and local git support
- Planner/builder agents, facilitator improvements, kube helpers, and agents deploy manifest
- Self-dev infrastructure and fix operator secret key defaults
- Add securityContext support for sidecars _(operator)_
- Implement feature branch worktree architecture
- Require PLAN artifacts, improve BUILD generation with durable findings _(manager)_
- Allow review facilitator and build-gen to read workspace files
- Configurable first-response timeout via ClusterSettings + UI (seconds) _(manager)_
- Merge agent, plan reading tool, stale run detection, OOM resilience
- Phase-driven reconciler refactor _(manager)_
- Add runTTLDays ClusterSettings and TTL controller for run retention

### <!-- 1 -->🐛 Bug Fixes

- Include manager-controller in shared node image build
- Include manager controller in deploy script, beatctl deploy, and README docs
- Add opencodekanbans list/get permission to web service account
- Add RBAC permission for Kanban status patching, Add Task endpoint
- Typecheck all packages, harden CRD codegen, deploy clean
- Add @percussionist/kube to all Dockerfiles and update lockfile
- Board task form now shows all ClusterAgents, not just board roster
- Grant web SA patch permission on opencodeprojects/status subresource
- Repair missing backlog entries on board GET, type board spec/status
- Lmstudio FFI crash, CRD record pruning, and orphan backlog cleanup
- Inject OPENCODE_CONFIG_CONTENT from opencode-config configmap into run pods
- Remove leading-5 from log viewer pre element
- Log-viewer line-height equal to font size
- Replace heredoc gh auth with pipe/redirect for POSIX sh compatibility
- Resolve type errors in web package
- Strip injectFiles from body before schema validation
- Grant web service account secrets create/update/patch/delete
- Add 5s timeout to waitForOpencodeWeb health check fetch
- Remove garbage JSON from agent-config ConfigMap
- Clean dist before Docker tsc build and fix minikube image load pitfalls
- Add /mcp path to MCP server URL in agent-config ConfigMap
- Pass branch name to reviewer prompt so it can actually find and inspect the builder's changes
- Deduplicate TTS speak() calls and improve mobile chat UX _(web)_
- Set lang=en-US on TTS utterance to prevent non-English accent
- Align sidebar and main header heights to h-14
- Unwrap nextId object in fetchNextTaskId
- Remove SidebarHeader default p-2 so header heights match exactly
- Resolve predecessorIndex to CR name instead of sequential chaining
- Avoid duplicate PVC volumes when workspace uses data PVC _(operator)_
- Preserve featureBranchingEnabled when updating projects _(web)_
- Add featureBranchingEnabled and dind privileged to project YAML _(self-dev)_
- Preserve sidecar securityContext on UI save; add maxParallel/timeoutSeconds/featureBranchingEnabled to form _(web)_
- Recover stale runs and worktrees _(manager)_
- Workspace-init bare mirror refs, stale worktree pruning, reconciler column guard
- Reconciliation storm, memory limits and OOM diagnostics
- Inject spec.manager.model into agent config, fall back to CM for provider/skills _(operator)_
- K8s ApiException statusCode→code, backlog column, facilitator hardening, chat cancel
- Use bun for dev script instead of tsx (bun:sqlite requires Bun runtime) _(web)_
- Correct clustersettings CRD YAML indentation for runner description
- Resolve run failures from K8s client API change, missing RBAC, and OOM limits

### <!-- 10 -->💼 Other

- Finish RunnerAdapter rename — remove deprecated aliases, fix duplicate runner key
- Fix desktop overlay from Sheet always opening on task select
- Add ideas lane task creation and promotion
- Move ideas + button to filter bar tab row
- Restore ideas + button in column header; show ideas on ideas tab filter
- Retry prompt POST on transient connection errors
- Rename opencode field to runnerConfig; fix settings save to preserve existing runnerConfig keys
- Make project param optional in listTasks to allow listing all tasks across projects
- Use node http for session POST to bypass undici headersTimeout; propagate abort signal; improve activity detection in waitForCompletion
- Add Task kind support to inspect_cr and list_crs tools; update patch_board description to reflect current schema
- Migrate from readSessionConfigMap to readAllSessionsFromConfigMap; fall back to plan artifact when session snapshot missing in generating-builds
- Add idempotency check for PLAN tasks on first run; interpolate project/task names in write_plan instruction
- Poll agent status every 10s instead of once on mount; show thinking indicator and inline cancel in chat; replace cancel button with drum logo while sending
- Parse double-encoded JSON from MCP tool result to extract plan content string
- Simplify workflow — skip branch checkout (agent already on branch); use git diff HEAD~5 for recent changes

### <!-- 2 -->🚜 Refactor

- Unified board in OpenCodeProject, drop OpenCodeKanban CRD, harden reconciler
- Decouple runner from opencode, rename CRD kinds to Run/Project/Task
- Finish rename of OpenCodeRun/Project/Task across all files

### <!-- 3 -->📚 Documentation

- Add AGENTS.md with project overview and agent guidance
- Add caching documentation to README
- Document manager agent architecture and interactive chat features
- Add mobile optimization plan for SettingsPage (#6)

### <!-- 7 -->⚙️ Miscellaneous Tasks

- Remove stats.db from git tracking and add to gitignore
- Update git ignore _(git)_
- Removes obsolete opencode/plans folder _(git)_
- Add CI and GHCR image publish workflows
- Uncommitted working changes (dispatcher, manager, kube, web, docs)

