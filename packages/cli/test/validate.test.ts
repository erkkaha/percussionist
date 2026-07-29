import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ClusterAgent, Project } from '@percussionist/api';
import { AuditIssueCode, auditAgentCapabilities, runValidateAgents } from '../src/validate.js';

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

  // A roster of planner/builder/reviewer with no buildgen and no integrator
  // ClusterAgent in the cluster audits as zero errors, while every buildgen run
  // dies with "session ended without completion signal" and merge runs cannot
  // report an outcome — the flow dispatches those two by name, so nothing in the
  // roster checks can see them.
  it('reports a flow-dispatched agent that does not exist', () => {
    const report = auditAgentCapabilities(
      [makeAgent('planner', ['task.plan.execute']), makeAgent('builder', ['task.build.execute'])],
      [makeProject('demo', 'ns', ['planner', 'builder'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.FlowAgentMissing &&
          finding.agentName === 'buildgen' &&
          finding.severity === 'error',
      ),
    ).toBeTrue();
    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.FlowAgentMissing && finding.agentName === 'integrator',
      ),
    ).toBeTrue();
  });

  it('reports a flow agent that exists but lacks the capability gating its completion tool', () => {
    const project = makeProject('demo', 'ns', ['planner', 'builder']);
    // Merge runs fall back to the builder agent, which has no task.merge.execute
    // — so the dispatcher withholds complete_merge.
    (project.spec as { flow?: unknown }).flow = { merge: { agent: 'builder' } };

    const report = auditAgentCapabilities(
      [
        makeAgent('planner', ['task.plan.execute']),
        makeAgent('builder', ['task.build.execute', 'run.complete.build']),
        makeAgent('buildgen', ['task.build.generate', 'run.complete.build']),
      ],
      [project],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.FlowAgentMissingCapability &&
          finding.agentName === 'builder' &&
          finding.capability === 'task.merge.execute',
      ),
    ).toBeTrue();
  });

  it('does not fault a project for flow stages it has switched off', () => {
    const project = makeProject('demo', 'ns', ['planner', 'builder']);
    (project.spec as { flow?: unknown }).flow = {
      plan: { buildGeneration: 'manual' },
      merge: { mode: 'disabled' },
    };

    const report = auditAgentCapabilities(
      [makeAgent('planner', ['task.plan.execute']), makeAgent('builder', ['task.build.execute'])],
      [project],
    );

    expect(report.findings.some((f) => f.code === AuditIssueCode.FlowAgentMissing)).toBeFalse();
  });

  it('does not report a flow-dispatched agent as orphaned', () => {
    const report = auditAgentCapabilities(
      [
        makeAgent('planner', ['task.plan.execute']),
        makeAgent('builder', ['task.build.execute']),
        makeAgent('buildgen', ['task.build.generate', 'run.complete.build']),
      ],
      [makeProject('demo', 'ns', ['planner', 'builder'])],
    );

    expect(
      report.findings.some(
        (finding) =>
          finding.code === AuditIssueCode.AgentOrphaned && finding.agentName === 'buildgen',
      ),
    ).toBeFalse();
  });
});

describe('runValidateAgents', () => {
  let previousExitCode: number | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it('sets exitCode=0 on clean audit and prints summary/category headings', async () => {
    const lines: string[] = [];

    await runValidateAgents(
      {},
      {
        loadData: async () => ({
          clusterAgents: [
            makeAgent('planner', ['task.plan.execute']),
            makeAgent('builder', ['task.build.execute']),
            // A clean audit needs the agents the flow dispatches by name, not
            // just the roster: build generation and merge are on by default.
            makeAgent('buildgen', ['task.build.generate', 'run.complete.build']),
            makeAgent('integrator', ['task.merge.execute']),
          ],
          projects: [makeProject('demo', 'ns', ['planner', 'builder'])],
        }),
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(0);
    expect(lines).toContain('Summary');
    expect(lines).toContain('Category totals');
    expect(lines).toContain('  Invalid capability enum values: 0');
    expect(lines).toContain('  Missing ClusterAgent references: 0');
    expect(lines).toContain('  Missing PLAN capability coverage: 0');
    expect(lines).toContain('  Missing BUILD capability coverage: 0');
    expect(lines).toContain('  Missing flow agents: 0');
    expect(lines).toContain('  Flow agents missing capabilities: 0');
    expect(lines).toContain('No issues found.');
  });

  it('sets exitCode=1 when error findings exist', async () => {
    const lines: string[] = [];

    await runValidateAgents(
      {},
      {
        loadData: async () => ({
          clusterAgents: [makeAgent('planner', ['task.plan.execute'])],
          projects: [makeProject('demo', 'ns', ['planner'])],
        }),
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(lines).toContain('Summary');
    expect(lines).toContain('Category totals');
    expect(lines).toContain('  Missing BUILD capability coverage: 1');
    expect(
      lines.some((line) => line.startsWith('Missing BUILD capability coverage (1)')),
    ).toBeTrue();
  });
});
