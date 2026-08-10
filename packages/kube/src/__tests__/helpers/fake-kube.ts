// fake-kube.ts — recording fake for @percussionist/kube's lazy-singleton
// clients (core() / custom() / apps()).
//
// installFakeKube(script) installs method spies on the singleton instances
// for every method in the package's kube API surface, answers each call from
// a script table, and records every call as `{ method, args }` so tests can
// assert exact call sequences (e.g. "read, then create, then patch").
//
// The spy mechanism is a tiny self-contained defineProperty swap (see
// installMethodSpy) rather than bun:test's spyOn so the helper typechecks
// under any tsconfig and behaves identically to the operator package's copy
// of this file (packages/operator/src/test-helpers/fake-kube.ts).
//
// Failure injection: script `{ error }` with an Error carrying a `statusCode`
// (see kubeError / notFound / conflict / tooManyRequests / serverError below)
// rejects the call with that error. The package's helpers observe it via the
// statusCode/code fields — 404 triggers fallback paths, 409 triggers the
// retry/backoff loops, 429/5xx exercise transient-failure handling.
//
// Sequencing: a scripted method may be a single response (used for every
// call) or an array (each call consumes the next entry; the final entry
// repeats unless it is wrapped in `once`, in which case calls after it throw
// a "script exhausted" error so over-scripting is caught loudly).

import { apps, core, custom } from '../../index.js';

/** A single recorded call to an intercepted kube method. */
export interface KubeCall {
  /** Name of the intercepted method, e.g. "patchNamespacedConfigMap". */
  method: string;
  /** Arguments the caller passed — typically `[requestObject, options?]`. */
  args: unknown[];
}

/**
 * A scripted answer for one method call:
 * - `{ value }`  — resolve with the value (undefined when omitted)
 * - `{ error }`  — reject with the error (carry statusCode for 404/409/429/5xx)
 * - `{ once: X }`— use X for exactly one call, then exhaust (or advance in an array)
 */
export type ScriptedResponse = { value?: unknown } | { error?: Error } | { once: ScriptedResponse };

/** Method name → scripted response (or ordered sequence of them). */
export type FakeKubeScript = Record<string, ScriptedResponse | ScriptedResponse[]>;

/** Build an Error that kube helpers recognise as an HTTP failure via statusCode. */
export function kubeError(statusCode: number, message = `fake kube error ${statusCode}`): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** 404 — not found (drives the helpers' "create if missing" fallbacks). */
export function notFound(message = 'fake kube: not found'): Error {
  return kubeError(404, message);
}

/** 409 — conflict (drives the helpers' retry/backoff loops). */
export function conflict(message = 'fake kube: conflict'): Error {
  return kubeError(409, message);
}

/** 429 — rate limited. */
export function tooManyRequests(message = 'fake kube: too many requests'): Error {
  return kubeError(429, message);
}

/** 5xx — server error (transient failure). */
export function serverError(message = 'fake kube: internal server error'): Error {
  return kubeError(500, message);
}

// ---------------------------------------------------------------------------
// Method universe — every method the package calls on the three singletons.
// Kept in sync with packages/kube/src/index.ts. Methods named in a script are
// intercepted even if missing from this list (added to the universe on the
// fly); everything else in the universe is intercepted too so a code path
// that was not scripted fails loudly instead of hitting a real cluster.

const CORE_METHODS = [
  'readNamespacedPod',
  'createNamespacedPod',
  'deleteNamespacedPod',
  'readNamespacedPodLog',
  'listNamespacedPod',
  'listNamespacedEvent',
  'readNamespacedConfigMap',
  'createNamespacedConfigMap',
  'replaceNamespacedConfigMap',
  'patchNamespacedConfigMap',
  'readNamespacedService',
  'createNamespacedService',
  'deleteNamespacedService',
  'readNamespacedPersistentVolumeClaim',
  'createNamespacedPersistentVolumeClaim',
] as const;

const CUSTOM_METHODS = [
  'listNamespacedCustomObject',
  'getNamespacedCustomObject',
  'createNamespacedCustomObject',
  'deleteNamespacedCustomObject',
  'patchNamespacedCustomObjectStatus',
  'patchNamespacedCustomObject',
  'replaceNamespacedCustomObject',
  'listClusterCustomObject',
  'getClusterCustomObject',
  'createClusterCustomObject',
  'replaceClusterCustomObject',
  'deleteClusterCustomObject',
] as const;

const APPS_METHODS = ['readNamespacedDeployment'] as const;

/** Loose view of a method spy — avoids leaking `any` through the public surface. */
interface MethodSpy {
  mockImplementation(fn: (...args: unknown[]) => unknown): void;
  mockRestore(): void;
}

/**
 * Swap `target[method]` for a wrapper delegating to a configurable
 * implementation. Restore puts back the original descriptor (or removes the
 * own property when the method was inherited). Works for both class
 * prototypes and plain instances.
 */
function installMethodSpy(
  target: object,
  method: string,
  initial: (...args: unknown[]) => unknown,
): MethodSpy {
  const record = target as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(target, method);
  if (typeof record[method] !== 'function') {
    throw new Error(
      `FakeKube: "${method}" is not a function on the spy target — cannot install a spy`,
    );
  }
  let impl: (...args: unknown[]) => unknown = initial;
  const wrapper = (...args: unknown[]) => impl(...args);
  Object.defineProperty(target, method, {
    value: wrapper,
    writable: true,
    configurable: true,
  });
  return {
    mockImplementation(fn) {
      impl = fn;
    },
    mockRestore() {
      if (original) {
        Object.defineProperty(target, method, original);
      } else {
        delete record[method];
      }
    },
  };
}

/** Resolves the scripted response for one method over repeated calls. */
class ResponseSequence {
  private cursor = 0;
  private exhausted = false;

  constructor(
    private readonly method: string,
    private readonly scripted: ScriptedResponse | ScriptedResponse[] | undefined,
  ) {}

  /** Answer the next call as a settled promise. */
  next(): Promise<unknown> {
    const answer = this.peek();
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }

  private peek(): unknown | Error {
    if (this.exhausted) return this.exhaustedError();
    const entry = this.scripted;
    if (entry === undefined) return this.unscriptedError();

    if (Array.isArray(entry)) {
      if (entry.length === 0) return this.exhaustedError();
      const idx = Math.min(this.cursor, entry.length - 1);
      const element = entry[idx];
      if (element === undefined) return this.exhaustedError();
      const isLast = this.cursor >= entry.length - 1;
      if ('once' in element) {
        if (!isLast) this.cursor += 1;
        else this.exhausted = true;
        return this.resolveElement(element.once);
      }
      if (!isLast) this.cursor += 1;
      return this.resolveElement(element);
    }

    // Single response (repeats for every call, unless `once` exhausts it).
    if ('once' in entry) {
      this.exhausted = true;
      return this.resolveElement(entry.once);
    }
    return this.resolveElement(entry);
  }

  private resolveElement(el: ScriptedResponse): unknown | Error {
    // The union's members are intentionally loose ({ value? } | { error? } |
    // { once }); read them through a flat record so extraction does not
    // depend on TS's in-operator narrowing of optional properties.
    const flat = el as { value?: unknown; error?: Error; once?: ScriptedResponse };
    if (flat.error !== undefined) return flat.error;
    return flat.value;
  }

  private unscriptedError(): Error {
    return new Error(
      `FakeKube: no scripted response for method "${this.method}" — add it to the script ` +
        'passed to installFakeKube() so this test does not silently depend on a real cluster',
    );
  }

  private exhaustedError(): Error {
    return new Error(`FakeKube: script exhausted for method "${this.method}"`);
  }
}

export interface FakeKubeInstaller {
  /** Every intercepted call, in invocation order. */
  calls: KubeCall[];
  /** Remove all spies, restoring the real singleton implementations. */
  restore(): void;
}

/**
 * Install a recording fake over the kube package's singleton clients.
 *
 * Every method in the universe (plus any extra methods named in `script`) is
 * replaced with a spy that records `{ method, args }` and answers from the
 * script. Methods present in the universe but absent from the script reject
 * with a descriptive error so an unscripted code path fails loudly rather
 * than hitting a real cluster.
 */
export function installFakeKube(script: FakeKubeScript = {}): FakeKubeInstaller {
  const calls: KubeCall[] = [];
  const spies: MethodSpy[] = [];

  const universe = new Map<string, () => object>();
  for (const method of CORE_METHODS) universe.set(method, core);
  for (const method of CUSTOM_METHODS) universe.set(method, custom);
  for (const method of APPS_METHODS) universe.set(method, apps);
  // Script keys always get a spy, even if the universe above has not caught
  // up with a newly-added production method.
  for (const method of Object.keys(script)) {
    if (!universe.has(method)) universe.set(method, custom);
  }

  for (const [method, getTarget] of universe) {
    const target = getTarget();
    const sequence = new ResponseSequence(method, script[method]);
    const spy = installMethodSpy(target, method, (...args: unknown[]) => {
      calls.push({ method, args });
      return sequence.next();
    });
    spies.push(spy);
  }

  return {
    calls,
    restore() {
      for (const spy of spies) spy.mockRestore();
      spies.length = 0;
    },
  };
}
