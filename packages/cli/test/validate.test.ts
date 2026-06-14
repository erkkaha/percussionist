import { describe, expect, it } from 'bun:test';
import type { ClusterAgent, Project } from '@percussionist/api';
import { AuditIssueCode, auditAgentCapabilities } from '../src/validate.js';

function makeAgent(name: string, capabilities: unknown[]): ClusterAgent {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterAgent',
    metadata: { name },
    spec: {
      content: `# ${name}`,
      capabilities: capabilities as ClusterAgent['spec']['capabilities'],
    },
  } as ClusterAgent;
}

function makeProject(name: string, namespace: string, agentNames: string[]): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name, namespace },
    spec: {
      agents: agentNames.map((agentName) => ({ name: agentName })),
    },
  } as Project;
}

describe('auditAgentCapabilities', () => {
  it('reports invalid enum capability values', () => {
    const report = auditAgentCapabilities(
      [makeAgent('planner', ['task.plan.execute', 'task.bad.value'])],
      [makeProject('demo', 'ns', ['planner'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.AgentCapabilityInvalidEnum &&
          finding.agentName === 'planner' &&
          finding.capability === 'task.bad.value',
      ),
    ).toBeTrue();
  });

  it('reports missing ClusterAgent references in a project roster', () => {
    const report = auditAgentCapabilities(
      [makeAgent('planner', ['task.plan.execute'])],
      [makeProject('demo', 'ns', ['planner', 'builder'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.ProjectRosterMissingAgent &&
          finding.projectName === 'demo' &&
          finding.agentName === 'builder',
      ),
    ).toBeTrue();
  });

  it('reports missing plan/build capability coverage in a roster', () => {
    const report = auditAgentCapabilities(
      [makeAgent('reviewer', ['task.review.evaluate'])],
      [makeProject('demo', 'ns', ['reviewer'])],
    );

    expect(
      report.findings.some(
        (finding) => finding.code === AuditIssueCode.ProjectRosterMissingPlanCoverage,
      ),
    ).toBeTrue();
    expect(
      report.findings.some(
        (finding) => finding.code === AuditIssueCode.ProjectRosterMissingBuildCoverage,
      ),
    ).toBeTrue();
  });

  it('reports role/name convention mismatch warnings', () => {
    const report = auditAgentCapabilities(
      [makeAgent('builder', ['task.review.evaluate'])],
      [makeProject('demo', 'ns', ['builder'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.AgentConventionCapabilityMismatch &&
          finding.agentName === 'builder' &&
          finding.capability === 'task.build.execute' &&
          finding.severity === 'warning',
      ),
    ).toBeTrue();
  });

  it('reports orphaned ClusterAgents', () => {
    const report = auditAgentCapabilities(
      [
        makeAgent('planner', ['task.plan.execute']),
        makeAgent('builder', ['task.build.execute']),
        makeAgent('orphan', ['task.review.evaluate']),
      ],
      [makeProject('demo', 'ns', ['planner', 'builder'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.AgentOrphaned &&
          finding.agentName === 'orphan' &&
          finding.severity === 'warning',
      ),
    ).toBeTrue();
  });

  it('reports capability formatting issues (whitespace/casing/duplicates/non-strings)', () => {
    const report = auditAgentCapabilities(
      [
        makeAgent('builder', [
          ' task.build.execute ',
          'TASK.BUILD.EXECUTE',
          'task.build.execute',
          123,
        ]),
      ],
      [makeProject('demo', 'ns', ['builder'])],
    );

    const formattingFindings = report.findings.filter(
      (finding) => finding.code === AuditIssueCode.AgentCapabilityFormatting,
    );

    expect(formattingFindings.some((finding) => finding.detail === 'whitespace')).toBeTrue();
    expect(formattingFindings.some((finding) => finding.detail === 'casing')).toBeTrue();
    expect(formattingFindings.some((finding) => finding.detail === 'duplicate')).toBeTrue();
    expect(formattingFindings.some((finding) => finding.detail === 'non-string')).toBeTrue();
  });
});
