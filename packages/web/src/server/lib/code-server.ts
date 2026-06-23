import { DEFAULT_CLUSTER_SETTINGS_NAME, type Project } from '@percussionist/api';
import { getClusterSettings } from '../kube.js';

/**
 * Fetch the code-server URL template from ClusterSettings/default.
 * Returns undefined when not configured or on error.
 */
export async function fetchCodeServerUrlTemplate(): Promise<string | undefined> {
  try {
    const cs = await getClusterSettings(DEFAULT_CLUSTER_SETTINGS_NAME);
    return cs.spec?.codeServerUrlTemplate;
  } catch {
    return undefined;
  }
}

/**
 * Compute the code-server URL for a project from a template string.
 * Template may contain {project} which is replaced with the project name.
 * Returns undefined when code-server is not enabled or no template is given.
 */
export function codeServerUrlFor(
  project: Pick<Project, 'metadata' | 'spec'>,
  template: string | undefined,
): string | undefined {
  if (!project.spec.codeServer?.enabled || !template) return undefined;
  return template.replace('{project}', project.metadata.name ?? '');
}
