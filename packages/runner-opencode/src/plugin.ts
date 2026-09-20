// plugin.ts — the Percussionist host plugin for the embedded OpenCode 2 runtime.
//
// Run pods are headless: nothing can answer a permission prompt, so a
// permission that blocks would park the run until its timeout. In v1 this was
// handled by the operator's config; in v2 the plugin permission hook is the
// authoritative place. The pod plus the cluster network policy is the sandbox
// boundary, which is what makes blanket allow safe here — the same reasoning
// runner-claude applies with `bypassPermissions`.

import { Plugin } from '@opencode/plugin';

export type PermissionMode = 'allow' | 'ask';

export type PluginOptions = {
  permissionMode: PermissionMode;
  log: (msg: string) => void;
  /** Tool-name hook for diagnostics; defaults to a log line per call. */
  onToolCall?: (tool: string, sessionID: string) => void;
};

export function percussionistPlugin(opts: PluginOptions) {
  return Plugin.define({
    id: 'percussionist-runner',
    async setup(ctx) {
      if (opts.permissionMode === 'allow') {
        await ctx.permission.hook('evaluate', (ev) => {
          if (ev.effect !== 'allow') {
            opts.log(
              `permission: auto-allow ${ev.action} ${ev.resources.join(',')} (was ${ev.effect})`,
            );
            ev.effect = 'allow';
          }
        });
      }
      await ctx.tool.hook('execute.before', (h) => {
        opts.onToolCall?.(h.tool, String(h.sessionID));
      });
    },
  });
}
