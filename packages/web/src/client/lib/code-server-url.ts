import { useQuery } from '@tanstack/react-query';
import { fetchSettings } from './api';

/**
 * Derive the IDE URL for a project from window.location.
 * Replaces the first subdomain label with ide-{project}.
 * Works for patterns like:
 *   app.{base}                → ide-{project}.{base}
 *   percussionist-web.{base}  → ide-{project}.{base}
 * Returns undefined when the host has no subdomain (e.g. port-forward,
 * localhost only) — caller should hide links in that case.
 */
export function deriveIdeUrl(projectName: string): string | undefined {
  const host = window.location.host;
  const dotIndex = host.indexOf('.');
  if (dotIndex === -1) return undefined;
  const base = host.slice(dotIndex + 1);
  return `${window.location.protocol}//ide-${projectName}.${base}`;
}

/**
 * Resolve a project's IDE URL. When the cluster operator has configured
 * ClusterSettings.spec.codeServerUrlTemplate (a URL with a `{project}`
 * placeholder, e.g. `https://ide-{project}.10.0.0.1.nip.io`), it is
 * authoritative — the dashboard's own origin often says nothing about where
 * the IDE ingresses are reachable (e.g. dashboard on a tailnet hostname,
 * IDEs on nip.io). Falls back to window.location derivation otherwise.
 */
export function ideUrl(projectName: string, template?: string): string | undefined {
  if (template) return template.replaceAll('{project}', projectName);
  return deriveIdeUrl(projectName);
}

/**
 * Cluster-wide IDE URL template from ClusterSettings, shared via the same
 * react-query cache key the settings page uses. `isLoading` lets callers
 * that act on the URL immediately (the iframe view) wait for the template
 * instead of flashing a fallback-derived URL.
 */
export function useIdeUrlTemplate(): { template: string | undefined; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });
  return { template: data?.spec?.codeServerUrlTemplate || undefined, isLoading };
}
