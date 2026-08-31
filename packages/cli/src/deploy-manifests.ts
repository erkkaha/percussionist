// deploy-manifests.ts — pure, unit-testable manifest patching for `beatctl deploy`.
//
// These functions replace the nip.io/nginx-specific string surgery that used to
// live in deploy.ts with platform-agnostic, name/value-pair regexes. Each
// substitution matches the env-name/value pair (never the value content), so a
// custom domain, Traefik, MicroK8s, or a plain `kubectl apply` all patch cleanly
// and idempotently.
//
// They are deliberately side-effect free except for an advisory console.warn on a
// drift (a requested name not present in the manifest) — the caller owns temp
// file creation and cleanup.

export interface OperatorManifestPatch {
  /** Replace PERCUSSIONIST_INGRESS_BASE_URL (scheme://host[:port]). */
  baseUrl?: string;
  /** Replace DEFAULT_STORAGE_CLASS. */
  storageClass?: string;
  /** Replace PERCUSSIONIST_INGRESS_CLASS. */
  ingressClass?: string;
  /**
   * Add (or replace) PERCUSSIONIST_INGRESS_TLS_SECRET. The operator uses this to
   * render a `spec.tls` block on per-project code-server Ingresses (minikube
   * per-Ingress TLS). Absent in checked-in manifests, so this inserts the entry.
   */
  tlsSecret?: string;
}

export interface WebManifestPatch {
  /** Replace the Ingress `host:` (e.g. `app.192.168.49.2.nip.io`). */
  host?: string;
  /** Replace `ingressClassName` (e.g. `traefik`). */
  ingressClass?: string;
  /** Replace the WEB_BASE_URL env — its origin must equal `host`. */
  webBaseUrl?: string;
  /** Add a `spec.tls` block referencing this secret name (minikube per-Ingress TLS). */
  tlsSecret?: string;
}

/** Match a `- name: <NAME>\n  value: <VALUE>` env pair; group 1 is the prefix. */
function envValueRe(name: string): RegExp {
  return new RegExp(`(- name: ${name}\n[ \\t]+value:[ \\t]+)[^\\n]*`);
}

/** Replace the `value:` of a named env entry. Returns yaml unchanged if absent. */
function replaceEnvValue(yaml: string, name: string, value: string): string {
  const re = envValueRe(name);
  if (!re.test(yaml)) {
    console.warn(
      `beatctl: warning: could not patch ${name} in manifest — apply it manually: ${value}`,
    );
    return yaml;
  }
  return yaml.replace(re, `$1${value}`);
}

/**
 * Add or replace the PERCUSSIONIST_INGRESS_TLS_SECRET env entry. Inserted after
 * the PERCUSSIONIST_INGRESS_CLASS block on first use, replaced in place on
 * subsequent passes (idempotent).
 */
function setTlsSecretEnv(yaml: string, secretName: string): string {
  const existing = envValueRe('PERCUSSIONIST_INGRESS_TLS_SECRET');
  if (existing.test(yaml)) {
    return yaml.replace(existing, `$1${secretName}`);
  }
  const anchor = /(- name: PERCUSSIONIST_INGRESS_CLASS\n[ \t]+value: [^\n]*)/;
  if (!anchor.test(yaml)) return yaml;
  const indent = '            ';
  return yaml.replace(
    anchor,
    `${indent}- name: PERCUSSIONIST_INGRESS_TLS_SECRET\n${indent}  value: ${secretName}\n$1`,
  );
}

/**
 * Patch the operator Deployment manifest. Every substitution is optional and
 * matches the env-name/value pair, so unknown or custom manifests degrade to an
 * unchanged field (with a warning) rather than corrupting yaml.
 */
export function patchedOperatorManifest(yaml: string, opts: OperatorManifestPatch): string {
  let out = yaml;
  if (opts.baseUrl !== undefined) {
    out = replaceEnvValue(out, 'PERCUSSIONIST_INGRESS_BASE_URL', opts.baseUrl);
  }
  if (opts.storageClass !== undefined) {
    out = replaceEnvValue(out, 'DEFAULT_STORAGE_CLASS', opts.storageClass);
  }
  if (opts.ingressClass !== undefined) {
    out = replaceEnvValue(out, 'PERCUSSIONIST_INGRESS_CLASS', opts.ingressClass);
  }
  if (opts.tlsSecret !== undefined) {
    out = setTlsSecretEnv(out, opts.tlsSecret);
  }
  return out;
}

/** Replace a top-level scalar field (`key: value`). Unchanged if absent. */
function replaceScalarField(yaml: string, key: string, value: string): string {
  const re = new RegExp(`^([ \\t]*${key}:[ \\t]+)[^\\n]*`, 'm');
  if (!re.test(yaml)) {
    console.warn(
      `beatctl: warning: could not patch ${key} in web manifest — apply it manually: ${value}`,
    );
    return yaml;
  }
  return yaml.replace(re, `$1${value}`);
}

/** Replace the Ingress `host:` list item. Unchanged if absent. */
function replaceHost(yaml: string, host: string): string {
  const re = /^[ \t]*- host:[ \t]+([^\n]*)/m;
  if (!re.test(yaml)) {
    console.warn(
      `beatctl: warning: could not patch Ingress host in web manifest — apply it manually: ${host}`,
    );
    return yaml;
  }
  return yaml.replace(re, `- host: ${host}`);
}

/** Strip a leading `tls:` mapping (and its nested children) under the Ingress spec. */
function stripWebTls(yaml: string): string {
  const lines = yaml.split('\n');
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (skip) {
      if (/^ {4,}\S/.test(line)) continue; // still inside the tls block
      skip = false; // dropped back to a sibling; process this line normally
    }
    if (/^ {2}tls:\s*$/.test(line)) {
      skip = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Insert a `spec.tls` block into the web Ingress, anchoring on the
 * `ingressClassName` line. Idempotent: any prior `tls:` block is stripped first.
 */
function setWebTls(yaml: string, host: string, secretName: string): string {
  const out = stripWebTls(yaml);
  const anchor = /^([ \t]*ingressClassName:[ \t]+[^\n]*)/m;
  if (!anchor.test(out)) return out;
  const block =
    '  tls:\n' + '    - hosts:\n' + `        - ${host}\n` + `      secretName: ${secretName}`;
  return out.replace(anchor, `$1\n${block}`);
}

/**
 * Patch the web Deployment + Ingress manifest. Host, ingressClassName,
 * WEB_BASE_URL, and an optional `spec.tls` block are each substituted
 * independently; fields not requested are left untouched.
 */
export function patchedWebManifest(yaml: string, opts: WebManifestPatch): string {
  let out = yaml;

  if (opts.ingressClass !== undefined) {
    out = replaceScalarField(out, 'ingressClassName', opts.ingressClass);
  }
  if (opts.webBaseUrl !== undefined) {
    out = replaceEnvValue(out, 'WEB_BASE_URL', opts.webBaseUrl);
  }

  // Resolve the host to use for the Ingress rule and the tls block.
  let host = opts.host;
  if (host === undefined) {
    const m = out.match(/^[ \t]*- host:[ \t]+([^\n]*)/m);
    host = m?.[1];
  }
  if (opts.host !== undefined) {
    out = replaceHost(out, opts.host);
  }

  if (opts.tlsSecret !== undefined && host) {
    out = setWebTls(out, host, opts.tlsSecret);
  }

  return out;
}
