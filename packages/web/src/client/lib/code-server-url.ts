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
