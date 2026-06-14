import type { Task } from '../../lib/types';

export function getParentRefPresentation(task: Task): { text?: string; tooltip?: string } {
  const text = task.displayRefs?.parentTask ?? task.spec.parentTaskRef;
  if (!text) return {};
  const canonical = task.displayRefs?.parentTaskCanonical ?? task.spec.parentTaskRef;
  if (canonical && canonical !== text) {
    return { text, tooltip: `Task ID: ${canonical}` };
  }
  return { text, tooltip: text };
}

export function getBlockedReasonPresentation(
  task: Task,
  col: string,
): { text?: string; tooltip?: string } {
  if (col !== 'blocked') return {};
  const text = task.status?.blockedReason;
  if (!text) return {};
  const canonical = task.displayRefs?.predecessorTaskCanonical;
  const display = task.displayRefs?.predecessorTask;
  if (canonical && display && canonical !== display) {
    return { text, tooltip: `${text}\nTask ID: ${canonical}` };
  }
  return { text, tooltip: text };
}

export function getChildRefPresentation(
  task: Task,
  childName: string,
  index: number,
): { text: string; tooltip: string } {
  const text = task.childProgress?.childDisplayRefs?.[index] ?? childName;
  return {
    text,
    tooltip: text !== childName ? `Task ID: ${childName}` : childName,
  };
}
