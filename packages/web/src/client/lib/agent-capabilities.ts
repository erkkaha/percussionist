import type { AgentCapability } from './types';

export interface AgentCapabilityMetadata {
  value: AgentCapability;
  label: string;
  description: string;
}

export const AGENT_CAPABILITY_METADATA: Record<AgentCapability, AgentCapabilityMetadata> = {
  'task.plan.execute': {
    value: 'task.plan.execute',
    label: 'PLAN task execution',
    description: 'Can be assigned PLAN tasks.',
  },
  'task.build.execute': {
    value: 'task.build.execute',
    label: 'BUILD task execution',
    description: 'Can be assigned BUILD implementation tasks.',
  },
  'task.build.generate': {
    value: 'task.build.generate',
    label: 'BUILD task generation',
    description: 'Can generate BUILD tasks from approved PLAN tasks.',
  },
  'task.review.evaluate': {
    value: 'task.review.evaluate',
    label: 'REVIEW task evaluation',
    description: 'Can be assigned REVIEW tasks that evaluate BUILD results.',
  },
  'task.failure.analyze': {
    value: 'task.failure.analyze',
    label: 'Failure analysis',
    description: 'Can analyze failed tasks and propose recovery steps.',
  },
  'task.merge.execute': {
    value: 'task.merge.execute',
    label: 'Merge execution',
    description: 'Can be assigned merge tasks that integrate approved work.',
  },
  'run.complete.plan': {
    value: 'run.complete.plan',
    label: 'PLAN completion',
    description: 'Can call complete_plan during PLAN worker runs.',
  },
  'run.complete.build': {
    value: 'run.complete.build',
    label: 'BUILD completion',
    description:
      'Can call complete_run during BUILD, merge, build-generation, and failure-analysis runs.',
  },
  'run.complete.review': {
    value: 'run.complete.review',
    label: 'REVIEW completion',
    description: 'Can call complete_review during review facilitator runs.',
  },
};

export const AGENT_CAPABILITIES: AgentCapabilityMetadata[] =
  Object.values(AGENT_CAPABILITY_METADATA);
