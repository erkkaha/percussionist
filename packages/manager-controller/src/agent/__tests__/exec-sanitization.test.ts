import { beforeEach, describe, expect, it, mock } from 'bun:test';

const realKube = await import('@percussionist/kube');

const state = {
  execCalls: [] as Array<{ project: string; command: string; image?: string }>,
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  execInWorkspace: async (
    project: string,
    command: string,
    _mountPath?: string,
    _timeoutMs?: number,
    _ns?: string,
    image?: string,
  ) => {
    state.execCalls.push({ project, command, image });
    return { podName: 'maint-pod', stdout: 'ok', exitCode: 0 };
  },
  getProject: async () => ({
    metadata: { name: 'proj', uid: 'uid', namespace: 'percussionist' },
    spec: { source: { local: true } },
  }),
}));

const { __test } = await import('../tools.js');

type McpResult = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
};

function execRequest(command: string, extraArgs: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: {
      name: 'exec_in_workspace',
      arguments: { project: 'proj', command, ...extraArgs },
    },
  };
}

// A realistic slice of the web dashboard's task-diff script: it legitimately
// uses $(), pipes and newlines, all of which the sanitizer rejects.
const DIFF_SCRIPT = [
  'FORK=$(git -C "$REPO" merge-base "$BASE_REF" "$HEAD_REF")',
  'git -C "$REPO" log --format=%s -1 "$SHA" | od -A n -t x1',
].join('\n');

describe('exec_in_workspace sanitization bypass', () => {
  beforeEach(() => {
    state.execCalls = [];
  });

  it('sanitizes commands from untrusted callers (default context)', async () => {
    const response = (await __test.handleMcp(execRequest('ls /data; rm -rf /'))) as McpResult;

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('shell metacharacter');
    expect(state.execCalls).toEqual([]);
  });

  it('rejects skipSanitization from untrusted callers instead of honoring it', async () => {
    const response = (await __test.handleMcp(
      execRequest(DIFF_SCRIPT, { skipSanitization: true }),
    )) as McpResult;

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('bearer token');
    expect(state.execCalls).toEqual([]);
  });

  it('honors skipSanitization for bearer-token-authenticated callers', async () => {
    const response = (await __test.handleMcp(execRequest(DIFF_SCRIPT, { skipSanitization: true }), {
      trustedBearer: true,
    })) as McpResult;

    expect(response.result?.isError).toBeFalsy();
    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]?.command).toBe(DIFF_SCRIPT);
  });

  it('still sanitizes trusted callers that do not request the bypass', async () => {
    const response = (await __test.handleMcp(execRequest('ls /data && whoami'), {
      trustedBearer: true,
    })) as McpResult;

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('shell metacharacter');
    expect(state.execCalls).toEqual([]);
  });

  it('allows plain maintenance commands from untrusted callers', async () => {
    const response = (await __test.handleMcp(
      execRequest("rm -rf '/data/worktrees/stale-run'"),
    )) as McpResult;

    expect(response.result?.isError).toBeFalsy();
    expect(state.execCalls).toHaveLength(1);
  });
});

describe('exec_in_workspace image override', () => {
  beforeEach(() => {
    state.execCalls = [];
  });

  // An agent that could name the image could run an arbitrary container with the
  // project's data PVC mounted, so the override is trusted-callers-only.
  it('rejects an image override from untrusted callers', async () => {
    const response = (await __test.handleMcp(
      execRequest('ls /data', { image: 'attacker/image:latest' }),
    )) as McpResult;

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('bearer token');
    expect(state.execCalls).toEqual([]);
  });

  it('passes a trusted caller’s image through to the exec pod', async () => {
    const response = (await __test.handleMcp(
      execRequest('ls /data', { image: 'alpine/git:v2.54.0' }),
      { trustedBearer: true },
    )) as McpResult;

    expect(response.result?.isError).toBeFalsy();
    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]?.image).toBe('alpine/git:v2.54.0');
  });

  it('leaves the image unset when the caller does not ask for one', async () => {
    const response = (await __test.handleMcp(execRequest('ls /data'))) as McpResult;

    expect(response.result?.isError).toBeFalsy();
    expect(state.execCalls[0]?.image).toBeUndefined();
  });
});
