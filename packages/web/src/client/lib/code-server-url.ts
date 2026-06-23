/**
 * Derive the IDE URL for a project from window.location.
 * Assumes the web UI is served at app.{baseHost} and the IDE at
 * ide-{project}.{baseHost}.
 * Returns undefined when the host doesn't match (e.g. port-forward,
 * custom domain) — caller should hide links in that case.
 */
export function deriveIdeUrl(projectName: string): string | undefined {
  const host = window.location.host;
  const PREFIX = 'app.';
  if (!host.startsWith(PREFIX)) return undefined;
  const base = host.slice(PREFIX.length);
  return `${window.location.protocol}//ide-${projectName}.${base}`;
}
