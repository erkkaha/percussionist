// cleanup-job-name.ts — the deterministic name of the worktree cleanup Job
// spawned when a Run is deleted (ttl.ts). Lives in its own module because both
// ttl.ts and reconciler.ts need it and ttl.ts already imports from reconciler.

/** Name of the cleanup Job for `runName`: a DNS-1123 label, at most 63 chars. */
export function cleanupJobName(runName: string): string {
  return `cleanup-ttl-${runName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');
}
