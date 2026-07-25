// lib/kube-errors.ts — normalize @kubernetes/client-node error shapes.
//
// Depending on the code path, the client surfaces an API error either as an
// object carrying `statusCode`/`code`, or as a plain Error whose message
// embeds the status like:
//
//   Error: HTTP-Code: 404
//   Message: Unknown API Status Code!
//   Body: "{"kind":"Status",...,"reason":"NotFound",...}"
//
// Routes that only checked `e.statusCode === 404` therefore misreported every
// "not found" as a 500 — e.g. GET /api/settings on a cluster with no
// ClusterSettings object, which broke the dashboard's login probe.

/** Extract the HTTP status from a Kubernetes client error, if determinable. */
export function kubeStatusCode(e: unknown): number | undefined {
  const anyE = e as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  const direct = anyE?.statusCode ?? anyE?.code ?? anyE?.response?.statusCode;
  if (typeof direct === 'number') return direct;

  const msg = e instanceof Error ? e.message : String(e ?? '');
  const m = /HTTP-Code:\s*(\d{3})/.exec(msg);
  if (m?.[1]) return Number(m[1]);
  if (/"reason"\s*:\s*"NotFound"|\bNotFound\b/.test(msg)) return 404;
  return undefined;
}

/** True when the error represents a Kubernetes 404 / NotFound. */
export function isKubeNotFound(e: unknown): boolean {
  return kubeStatusCode(e) === 404;
}
