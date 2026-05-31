// config.ts — operator runtime configuration from environment variables.

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";
// The namespace where the operator itself is deployed and where shared
// ConfigMaps (e.g. opencode-config) live.  Defaults to "percussionist" and
// should NOT be changed when patching PERCUSSIONIST_NAMESPACE for tests.
const SELF_NAMESPACE = process.env.PERCUSSIONIST_SELF_NAMESPACE ?? "percussionist";
const RUNNER_IMAGE_DEFAULT =
  process.env.RUNNER_IMAGE_DEFAULT ?? "percussionist/runner:dev";
const DISPATCHER_IMAGE =
  process.env.DISPATCHER_IMAGE ?? "percussionist/dispatcher:dev";
const DISPATCHER_SERVICE_ACCOUNT =
  process.env.DISPATCHER_SERVICE_ACCOUNT ?? "percussionist-dispatcher";
const WEB_STATS_URL =
  process.env.WEB_STATS_URL ??
  `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;

// Ingress — disabled when BASE_URL is unset.
const _rawBaseURL = process.env.PERCUSSIONIST_INGRESS_BASE_URL ?? "";
const _legacyDomain = process.env.PERCUSSIONIST_INGRESS_BASE_DOMAIN ?? "";
const INGRESS_BASE_URL: string = _rawBaseURL
  ? _rawBaseURL.replace(/\/$/, "")
  : _legacyDomain
    ? `http://${_legacyDomain}`
    : "";

const INGRESS_CLASS = process.env.PERCUSSIONIST_INGRESS_CLASS ?? "";
let INGRESS_ANNOTATIONS: Record<string, string> = {};
try {
  INGRESS_ANNOTATIONS = JSON.parse(
    process.env.PERCUSSIONIST_INGRESS_ANNOTATIONS ?? "{}",
  );
} catch {
  // ignore malformed value
}
const EXPOSE_WEB_DEFAULT =
  process.env.PERCUSSIONIST_EXPOSE_WEB_DEFAULT !== "false";

// Memory / embedding service defaults.
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ??
  `http://ollama.${NAMESPACE}.svc.cluster.local:11434`;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";

export {
  NAMESPACE,
  SELF_NAMESPACE,
  RUNNER_IMAGE_DEFAULT,
  DISPATCHER_IMAGE,
  DISPATCHER_SERVICE_ACCOUNT,
  WEB_STATS_URL,
  INGRESS_BASE_URL,
  INGRESS_CLASS,
  INGRESS_ANNOTATIONS,
  EXPOSE_WEB_DEFAULT,
  OLLAMA_BASE_URL,
  EMBEDDING_MODEL,
};
