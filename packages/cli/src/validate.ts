import { AgentCapabilitySchema, type ClusterAgent, type Project } from '@percussionist/api';

export const AuditIssueCode = {
  AgentCapabilityInvalidEnum: 'AGENT_CAPABILITY_INVALID_ENUM',
  AgentCapabilityFormatting: 'AGENT_CAPABILITY_FORMATTING',
  AgentConventionCapabilityMismatch: 'AGENT_CONVENTION_CAPABILITY_MISMATCH',
  ProjectRosterMissingAgent: 'PROJECT_ROSTER_MISSING_AGENT',
  ProjectRosterMissingPlanCoverage: 'PROJECT_ROSTER_MISSING_PLAN_COVERAGE',
  ProjectRosterMissingBuildCoverage: 'PROJECT_ROSTER_MISSING_BUILD_COVERAGE',
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

interface AgentAuditState {
  normalizedCapabilities: Set<string>;
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
