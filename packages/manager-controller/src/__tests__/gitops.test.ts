import { describe, expect, it } from 'bun:test';
import {
  type CustomObjectClient,
  detectFluxSource,
  type FluxSource,
  KUSTOMIZATION_NAMES,
  pinFluxSourceTag,
  requestReconcile,
} from '../agent/gitops.js';

interface PatchCall {
  args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
    body: unknown;
  };
  options?: unknown;
}

/**
 * Fake CustomObjectsApi. `get` returns whatever object is registered for a
 * plural/name pair; anything unregistered rejects, the way the real API does
 * for a missing resource or an absent CRD.
 */
function fakeClient(opts: {
  objects?: Record<string, unknown>;
  failPatchFor?: string[];
}): CustomObjectClient & { patches: PatchCall[] } {
  const objects = opts.objects ?? {};
  const patches: PatchCall[] = [];
  return {
    patches,
    getNamespacedCustomObject: async (args) => {
      const key = `${args.plural}/${args.name}`;
      if (!(key in objects)) throw new Error(`${key} not found`);
      return objects[key];
    },
    patchNamespacedCustomObject: async (args, options) => {
      if (opts.failPatchFor?.includes(args.name)) {
        throw new Error(`patch rejected for ${args.name}`);
      }
      patches.push({ args, options });
      return {};
    },
  };
}

const SOURCE: FluxSource = {
  namespace: 'flux-system',
  name: 'percussionist',
  tag: 'v0.2.12',
  url: 'oci://ghcr.io/erkkaha/percussionist/manifests',
  semverRange: null,
  suspended: false,
};

describe('detectFluxSource', () => {
  it('parses the pinned tag and url from the OCIRepository', async () => {
    const client = fakeClient({
      objects: {
        'ocirepositories/percussionist': {
          spec: {
            url: 'oci://ghcr.io/erkkaha/percussionist/manifests',
            ref: { tag: 'v0.2.12' },
          },
        },
      },
    });

    const source = await detectFluxSource(client);

    expect(source).toEqual({
      namespace: 'flux-system',
      name: 'percussionist',
      tag: 'v0.2.12',
      url: 'oci://ghcr.io/erkkaha/percussionist/manifests',
      semverRange: null,
      suspended: false,
    });
  });

  it('returns null when the source does not exist', async () => {
    expect(await detectFluxSource(fakeClient({}))).toBeNull();
  });

  it('reports a semver range and a suspended source', async () => {
    const client = fakeClient({
      objects: {
        'ocirepositories/percussionist': {
          spec: {
            url: 'oci://example.test/manifests',
            suspend: true,
            ref: { semver: '>=0.2.0' },
          },
        },
      },
    });

    const source = await detectFluxSource(client);

    expect(source?.suspended).toBe(true);
    expect(source?.semverRange).toBe('>=0.2.0');
    expect(source?.tag).toBeNull();
  });

  it('honours an explicit namespace and name', async () => {
    const client = fakeClient({
      objects: { 'ocirepositories/custom': { spec: { url: 'oci://x', ref: { tag: 'v1' } } } },
    });

    const source = await detectFluxSource(client, 'other-ns', 'custom');

    expect(source?.namespace).toBe('other-ns');
    expect(source?.name).toBe('custom');
  });
});

describe('pinFluxSourceTag', () => {
  it('sets the tag and clears any semver range in one merge patch', async () => {
    const client = fakeClient({});

    await pinFluxSourceTag(SOURCE, 'v0.3.0', client);

    expect(client.patches).toHaveLength(1);
    const [call] = client.patches;
    expect(call?.args.plural).toBe('ocirepositories');
    expect(call?.args.name).toBe('percussionist');
    expect(call?.args.namespace).toBe('flux-system');
    // semver must be nulled out: Flux treats tag and semver as mutually
    // exclusive, and a leftover range would re-resolve over the pin.
    expect(call?.args.body).toEqual({ spec: { ref: { tag: 'v0.3.0', semver: null } } });
  });

  it('propagates a patch failure rather than reporting success', async () => {
    const client = fakeClient({ failPatchFor: ['percussionist'] });

    await expect(pinFluxSourceTag(SOURCE, 'v0.3.0', client)).rejects.toThrow('patch rejected');
  });
});

describe('requestReconcile', () => {
  it('annotates the source before the kustomizations', async () => {
    const client = fakeClient({});

    const failed = await requestReconcile(SOURCE, '2026-08-07T12:00:00Z', client);

    expect(failed).toEqual([]);
    expect(client.patches.map((p) => `${p.args.plural}/${p.args.name}`)).toEqual([
      'ocirepositories/percussionist',
      ...KUSTOMIZATION_NAMES.map((n) => `kustomizations/${n}`),
    ]);
    for (const p of client.patches) {
      expect(p.args.body).toEqual({
        metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': '2026-08-07T12:00:00Z' } },
      });
    }
  });

  it('collects failures instead of throwing, so a pinned tag is not lost', async () => {
    const client = fakeClient({ failPatchFor: ['percussionist-crds'] });

    const failed = await requestReconcile(SOURCE, '2026-08-07T12:00:00Z', client);

    expect(failed).toEqual(['percussionist-crds']);
    // The remaining resources are still annotated.
    expect(client.patches.map((p) => p.args.name)).toEqual(['percussionist', 'percussionist']);
  });
});
