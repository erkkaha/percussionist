import type { AgentCapability, Project, TaskType } from '@percussionist/api';
import { listClusterAgents } from '@percussionist/kube';

export interface CapabilityValidationSuccess {
  ok: true;
  requiredCapability: AgentCapability;
}

export interface CapabilityValidationFailure {
  ok: false;
  requiredCapability: AgentCapability;
  error: string;
}

export type CapabilityValidationResult = CapabilityValidationSuccess | CapabilityValidationFailure;

export function requiredCapabilityForTaskType(taskType: TaskType): AgentCapability {
  return taskType === 'PLAN' ? 'task.plan.execute' : 'task.build.execute';
}

export async function validateAgentTaskCapability(
  project: Project,
  taskType: TaskType,
  selectedAgent: string,
): Promise<CapabilityValidationResult> {
  const requiredCapability = requiredCapabilityForTaskType(taskType);
  const roster = (project.spec.agents ?? []).map((a) => a.name);

  if (!roster.includes(selectedAgent)) {
    return {
      ok: false,
      requiredCapability,
      error: `agent "${selectedAgent}" not in project roster: ${roster.join(', ') || '(empty)'}`,
    };
  }

  const agents = await listClusterAgents();
  const clusterAgent = agents.find((agent) => agent.metadata?.name === selectedAgent);
  if (!clusterAgent) {
    return {
      ok: false,
      requiredCapability,
      error: `cluster agent "${selectedAgent}" not found`,
    };
  }

  const capabilities = clusterAgent.spec.capabilities ?? [];
  if (!capabilities.includes(requiredCapability)) {
    return {
      ok: false,
      requiredCapability,
      error: `agent "${selectedAgent}" missing required capability "${requiredCapability}" for ${taskType} tasks`,
    };
  }

  return {
    ok: true,
    requiredCapability,
  };
}
