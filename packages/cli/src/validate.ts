import { AgentCapabilitySchema, type ClusterAgent, type Project } from '@percussionist/api';
import { fatal, listAllProjects, listClusterAgents, loadKube } from './kube.js';

export const AuditIssueCode = {
  AgentCapabilityInvalidEnum: 'AGENT_CAPABILITY_INVALID_ENUM',
  AgentCapabilityFormatting: 'AGENT_CAPABILITY_FORMATTING',
  AgentConventionCapabilityMismatch: 'AGENT_CONVENTION_CAPABILITY_MISMATCH',
  ProjectRosterMissingAgent: 'PROJECT_ROSTER_MISSING_AGENT',
  ProjectRosterMissingPlanCoverage: 'PROJECT_ROSTER_MISSING_PLAN_COVERAGE',
  ProjectRosterMissingBuildCoverage: 'PROJECT_ROSTER_MISSING_BUILD_COVERAGE',
  FlowAgentMissing: 'FLOW_AGENT_MISSING',
  FlowAgentMissingCapability: 'FLOW_AGENT_MISSING_CAPABILITY',
  AgentOrphaned: 'AGENT_ORPHANED',
} as const;

export type AuditIssueCode = (typeof AuditIssueCode)[keyof typeof AuditIssueCode];

export interface AgentCapabilityAuditFinding {
  code: AuditIssueCode;
  severity: 'error' | 'warning';
  message: string;
  agentName?: string;
  projectName?: string;
  projectNamespace?: string;
  capability?: string;
  detail?: string;
}

export interface AgentCapabilityAuditReport {
  findings: AgentCapabilityAuditFinding[];
  errors: AgentCapabilityAuditFinding[];
  warnings: AgentCapabilityAuditFinding[];
}

const CANONICAL_ROLE_EXPECTATIONS: ReadonlyArray<{ token: string; capability: string }> = [
  { token: 'planner', capability: 'task.plan.execute' },
  { token: 'builder', capability: 'task.build.execute' },
  { token: 'reviewer', capability: 'task.review.evaluate' },
  { token: 'buildgen', capability: 'task.build.generate' },
  { token: 'integrator', capability: 'task.merge.execute' },
  { token: 'failure-analyst', capability: 'task.failure.analyze' },
  { token: 'failure_analyst', capability: 'task.failure.analyze' },
  { token: 'failureanalyst', capability: 'task.failure.analyze' },
];

const REQUIRED_PLAN_CAPABILITY = 'task.plan.execute';
const REQUIRED_BUILD_CAPABILITY = 'task.build.execute';

/**
 * Auxiliary agents the flow dispatches by name — buildgen, merge and AI-review
 * runs. These never appear in `spec.agents`, so the roster checks above cannot
 * see them: a project whose roster audits clean can still be structurally
 * unable to generate BUILD tasks or merge an approved one, because the agent the
 * flow names does not exist or lacks the capability that gates its completion
 * tool. When that happens the run does its work and then dies with
 * "session ended without completion signal", since the dispatcher withholds the
 * completion tool the prompt told the agent to call.
 *
 * `enabled` mirrors the flow settings that switch each stage off, so a project
 * is not faulted for an agent it will never dispatch. Defaults match the
 * `.default(...)` values on the flow schema in @percussionist/api.
 */
const FLOW_AGENT_ROLES: ReadonlyArray<{
  role: string;
  resolve: (project: Project) => string;
  enabled: (project: Project) => boolean;
  capabilities: readonly string[];
}> = [
  {
    role: 'build generation',
    resolve: (p) => p.spec.flow?.plan?.buildGenerationAgent ?? 'buildgen',
    enabled: (p) => (p.spec.flow?.plan?.buildGeneration ?? 'ai') === 'ai',
    capabilities: ['task.build.generate', 'run.complete.build'],
  },
  {
    role: 'merge',
    resolve: (p) => p.spec.flow?.merge?.agent ?? 'integrator',
    enabled: (p) =>
      (p.spec.flow?.merge?.mode ?? 'auto') !== 'disabled' &&
      (p.spec.flow?.build?.onApprove ?? 'merge') !== 'done',
    capabilities: ['task.merge.execute'],
  },
  {
    role: 'AI review',
    // `reviewPolicy` is the legacy spelling of `flow.review`; resolveFlow in the
    // manager folds it in, so the audit has to honour both.
    resolve: (p) =>
      p.spec.flow?.review?.agent ?? p.spec.reviewPolicy?.aiReviewerAgent ?? 'reviewer',
    enabled: (p) =>
      (p.spec.flow?.review?.aiReviewerEnabled ??
        p.spec.reviewPolicy?.aiReviewerEnabled ??
        false) === true,
    capabilities: ['task.review.evaluate', 'run.complete.review'],
  },
];

interface AgentAuditState {
  normalizedCapabilities: Set<string>;
}

export interface ValidateAgentsOpts {
  namespace?: string;
}

interface ValidateAgentsDeps {
  loadData?: () => Promise<{ clusterAgents: ClusterAgent[]; projects: Project[] }>;
  log?: (line: string) => void;
}

const ISSUE_SECTIONS: ReadonlyArray<{
  code: AuditIssueCode;
  title: string;
  description: string;
}> = [
  {
    code: AuditIssueCode.AgentCapabilityInvalidEnum,
    title: 'Invalid capability enum values',
    description: 'Capabilities that are not valid AgentCapability enum entries.',
  },
  {
    code: AuditIssueCode.AgentCapabilityFormatting,
    title: 'Capability formatting issues',
    description: 'Whitespace/casing/duplicate/non-string capability quality issues.',
  },
  {
    code: AuditIssueCode.ProjectRosterMissingAgent,
    title: 'Missing ClusterAgent references',
    description: 'Project rosters that reference ClusterAgents that do not exist.',
  },
  {
    code: AuditIssueCode.ProjectRosterMissingPlanCoverage,
    title: 'Missing PLAN capability coverage',
    description: 'Project rosters with no agent providing task.plan.execute.',
  },
  {
    code: AuditIssueCode.ProjectRosterMissingBuildCoverage,
    title: 'Missing BUILD capability coverage',
    description: 'Project rosters with no agent providing task.build.execute.',
  },
  {
    code: AuditIssueCode.FlowAgentMissing,
    title: 'Missing flow agents',
    description: 'Agents the flow dispatches by name (buildgen/merge/review) that do not exist.',
  },
  {
    code: AuditIssueCode.FlowAgentMissingCapability,
    title: 'Flow agents missing capabilities',
    description: 'Flow-dispatched agents lacking a capability that gates their completion tool.',
  },
  {
    code: AuditIssueCode.AgentConventionCapabilityMismatch,
    title: 'Name/role convention mismatches',
    description: 'Agents matching canonical role names but missing expected capabilities.',
  },
  {
    code: AuditIssueCode.AgentOrphaned,
    title: 'Orphaned ClusterAgents',
    description: 'ClusterAgents that are not referenced by any Project roster.',
  },
];

export async function runValidateAgents(
  _opts: ValidateAgentsOpts,
  deps: ValidateAgentsDeps = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const loadData =
    deps.loadData ??
    (async () => {
      const { custom } = loadKube();
      const [clusterAgents, projects] = await Promise.all([
        listClusterAgents(custom),
        listAllProjects(custom),
      ]);
      return { clusterAgents, projects };
    });

  try {
    const { clusterAgents, projects } = await loadData();
    const report = auditAgentCapabilities(clusterAgents, projects);

    const byCode = new Map<AuditIssueCode, AgentCapabilityAuditFinding[]>();
    for (const finding of report.findings) {
      const group = byCode.get(finding.code) ?? [];
      group.push(finding);
      byCode.set(finding.code, group);
    }

    log('Agent capability audit report');
    log('');
    log('Summary');
    log(`  ClusterAgents scanned: ${clusterAgents.length}`);
    log(`  Projects scanned: ${projects.length}`);
    log(`  Total findings: ${report.findings.length}`);
    log(`  Errors: ${report.errors.length}`);
    log(`  Warnings: ${report.warnings.length}`);
    log('');
    log('Category totals');

    for (const section of ISSUE_SECTIONS) {
      const count = byCode.get(section.code)?.length ?? 0;
      log(`  ${section.title}: ${count}`);
    }

    if (report.findings.length === 0) {
      log('');
      log('No issues found.');
      process.exitCode = 0;
      return;
    }

    for (const section of ISSUE_SECTIONS) {
      const entries = byCode.get(section.code);
      if (!entries || entries.length === 0) continue;
      log('');
      log(`${section.title} (${entries.length})`);
      log(`  ${section.description}`);
      for (const finding of entries) {
        const prefix = finding.severity === 'error' ? 'error' : 'warn';
        log(`  - [${prefix}] ${finding.message}`);
      }
    }

    process.exitCode = report.errors.length > 0 ? 1 : 0;
  } catch (e) {
    fatal('validate agents failed', e);
  }
}

export function auditAgentCapabilities(
  clusterAgents: ClusterAgent[],
  projects: Project[],
): AgentCapabilityAuditReport {
  const findings: AgentCapabilityAuditFinding[] = [];
  const knownCapabilities = new Set<string>(AgentCapabilitySchema.options);

  const sortedAgents = [...clusterAgents].sort((a, b) =>
    (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''),
  );

  const agentStateByName = new Map<string, AgentAuditState>();
  for (const clusterAgent of sortedAgents) {
    const name = clusterAgent.metadata?.name ?? '';
    if (!name) continue;

    const normalizedCapabilities = new Set<string>();
    const seenCanonical = new Set<string>();
    const rawCapabilities = getRawCapabilities(clusterAgent);

    rawCapabilities.forEach((rawCapability, index) => {
      if (typeof rawCapability !== 'string') {
        findings.push({
          code: AuditIssueCode.AgentCapabilityFormatting,
          severity: 'error',
          message: `ClusterAgent "${name}" has a non-string capability entry at index ${index}.`,
          agentName: name,
          detail: 'non-string',
        });
        return;
      }

      const trimmed = rawCapability.trim();
      const canonical = trimmed.toLowerCase();

      if (trimmed !== rawCapability) {
        findings.push({
          code: AuditIssueCode.AgentCapabilityFormatting,
          severity: 'warning',
          message: `ClusterAgent "${name}" capability "${rawCapability}" has leading/trailing whitespace.`,
          agentName: name,
          capability: rawCapability,
          detail: 'whitespace',
        });
      }

      if (canonical !== trimmed) {
        findings.push({
          code: AuditIssueCode.AgentCapabilityFormatting,
          severity: 'warning',
          message: `ClusterAgent "${name}" capability "${rawCapability}" is not lowercase.`,
          agentName: name,
          capability: rawCapability,
          detail: 'casing',
        });
      }

      if (seenCanonical.has(canonical)) {
        findings.push({
          code: AuditIssueCode.AgentCapabilityFormatting,
          severity: 'warning',
          message: `ClusterAgent "${name}" capability "${rawCapability}" is duplicated.`,
          agentName: name,
          capability: rawCapability,
          detail: 'duplicate',
        });
      } else {
        seenCanonical.add(canonical);
      }

      if (knownCapabilities.has(canonical)) {
        normalizedCapabilities.add(canonical);
        return;
      }

      findings.push({
        code: AuditIssueCode.AgentCapabilityInvalidEnum,
        severity: 'error',
        message: `ClusterAgent "${name}" capability "${rawCapability}" is not a valid AgentCapability enum value.`,
        agentName: name,
        capability: rawCapability,
      });
    });

    const expected = expectedCapabilityFromAgentName(name);
    if (expected && !normalizedCapabilities.has(expected.capability)) {
      findings.push({
        code: AuditIssueCode.AgentConventionCapabilityMismatch,
        severity: 'warning',
        message: `ClusterAgent "${name}" matches "${expected.token}" naming convention but is missing capability "${expected.capability}".`,
        agentName: name,
        capability: expected.capability,
      });
    }

    agentStateByName.set(name, {
      normalizedCapabilities,
    });
  }

  const referencedAgents = new Set<string>();
  const sortedProjects = [...projects].sort((a, b) => {
    const aKey = `${a.metadata?.namespace ?? ''}/${a.metadata?.name ?? ''}`;
    const bKey = `${b.metadata?.namespace ?? ''}/${b.metadata?.name ?? ''}`;
    return aKey.localeCompare(bKey);
  });

  for (const project of sortedProjects) {
    const projectName = project.metadata?.name ?? '';
    const projectNamespace = project.metadata?.namespace ?? '';
    if (!projectName) continue;

    const roster = project.spec.agents ?? [];
    const rosterCapabilities = new Set<string>();

    for (const ref of roster) {
      const rosterAgentName = ref.name;
      const clusterAgent = agentStateByName.get(rosterAgentName);
      if (!clusterAgent) {
        findings.push({
          code: AuditIssueCode.ProjectRosterMissingAgent,
          severity: 'error',
          message: `Project "${projectNamespace}/${projectName}" references missing ClusterAgent "${rosterAgentName}".`,
          projectName,
          projectNamespace,
          agentName: rosterAgentName,
        });
        continue;
      }

      referencedAgents.add(rosterAgentName);
      for (const capability of clusterAgent.normalizedCapabilities) {
        rosterCapabilities.add(capability);
      }
    }

    if (!rosterCapabilities.has(REQUIRED_PLAN_CAPABILITY)) {
      findings.push({
        code: AuditIssueCode.ProjectRosterMissingPlanCoverage,
        severity: 'error',
        message: `Project "${projectNamespace}/${projectName}" roster has no agent with capability "${REQUIRED_PLAN_CAPABILITY}".`,
        projectName,
        projectNamespace,
        capability: REQUIRED_PLAN_CAPABILITY,
      });
    }

    if (!rosterCapabilities.has(REQUIRED_BUILD_CAPABILITY)) {
      findings.push({
        code: AuditIssueCode.ProjectRosterMissingBuildCoverage,
        severity: 'error',
        message: `Project "${projectNamespace}/${projectName}" roster has no agent with capability "${REQUIRED_BUILD_CAPABILITY}".`,
        projectName,
        projectNamespace,
        capability: REQUIRED_BUILD_CAPABILITY,
      });
    }

    for (const flowRole of FLOW_AGENT_ROLES) {
      if (!flowRole.enabled(project)) continue;
      const agentName = flowRole.resolve(project);

      // Flow agents are dispatched by name, so referencing one is what keeps it
      // from being reported as orphaned further down.
      referencedAgents.add(agentName);

      const state = agentStateByName.get(agentName);
      if (!state) {
        findings.push({
          code: AuditIssueCode.FlowAgentMissing,
          severity: 'error',
          message: `Project "${projectNamespace}/${projectName}" dispatches ${flowRole.role} runs to ClusterAgent "${agentName}", which does not exist.`,
          projectName,
          projectNamespace,
          agentName,
        });
        continue;
      }

      for (const capability of flowRole.capabilities) {
        if (state.normalizedCapabilities.has(capability)) continue;
        findings.push({
          code: AuditIssueCode.FlowAgentMissingCapability,
          severity: 'error',
          message: `Project "${projectNamespace}/${projectName}" ${flowRole.role} agent "${agentName}" is missing capability "${capability}".`,
          projectName,
          projectNamespace,
          agentName,
          capability,
        });
      }
    }
  }

  for (const agent of sortedAgents) {
    const name = agent.metadata?.name ?? '';
    if (!name) continue;
    if (referencedAgents.has(name)) continue;
    findings.push({
      code: AuditIssueCode.AgentOrphaned,
      severity: 'warning',
      message: `ClusterAgent "${name}" is orphaned (not referenced by any project roster).`,
      agentName: name,
    });
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  return { findings, errors, warnings };
}

function getRawCapabilities(clusterAgent: ClusterAgent): unknown[] {
  const spec = clusterAgent.spec as { capabilities?: unknown };
  if (!Array.isArray(spec.capabilities)) return [];
  return spec.capabilities;
}

function expectedCapabilityFromAgentName(
  agentName: string,
): { token: string; capability: string } | undefined {
  const lowerName = agentName.toLowerCase();
  return CANONICAL_ROLE_EXPECTATIONS.find((entry) => lowerName.includes(entry.token));
}
