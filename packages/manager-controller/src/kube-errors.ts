type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return typeof value === "object" && value !== null ? (value as AnyRecord) : undefined;
}

function parseCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function getErrorStatusCode(err: unknown): number | undefined {
  const root = asRecord(err);
  if (!root) return undefined;

  const direct = parseCode(root.statusCode) ?? parseCode(root.code);
  if (direct !== undefined) return direct;

  const response = asRecord(root.response);
  const responseCode = response
    ? parseCode(response.statusCode) ?? parseCode(response.code) ?? parseCode(response.status)
    : undefined;
  if (responseCode !== undefined) return responseCode;

  const body = asRecord(root.body);
  const bodyCode = body ? parseCode(body.code) : undefined;
  if (bodyCode !== undefined) return bodyCode;

  const details = asRecord(root.details);
  const detailsCode = details ? parseCode(details.code) : undefined;
  if (detailsCode !== undefined) return detailsCode;

  const cause = asRecord(root.cause);
  const causeCode = cause ? getErrorStatusCode(cause) : undefined;
  if (causeCode !== undefined) return causeCode;

  return undefined;
}

export function isKubeNotFoundError(err: unknown): boolean {
  if (getErrorStatusCode(err) === 404) return true;

  const root = asRecord(err);
  if (!root) return false;

  const reason = root.reason;
  if (typeof reason === "string" && reason.toLowerCase() === "notfound") return true;

  const body = asRecord(root.body);
  const bodyReason = body?.reason;
  if (typeof bodyReason === "string" && bodyReason.toLowerCase() === "notfound") return true;

  return false;
}
