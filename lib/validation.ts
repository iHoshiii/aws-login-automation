export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send a JSON request.");
  }
  // Bound actual bytes too; Content-Length alone is not trusted.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new HttpError(413, "Request is too large."); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, "Invalid JSON request."); }
}

export function stringValue(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

export function runId(value: unknown): string {
  const id = stringValue(value, "Run ID", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "Invalid run ID.");
  }
  return id;
}

export function postUrl(value: unknown): string {
  const text = stringValue(value, "Post URL", 1000);
  let url: URL;
  try { url = new URL(text); } catch { throw new HttpError(400, "Use a valid Builder Center post URL."); }
  if (url.protocol !== "https:" || url.hostname !== "builder.aws.com" || url.port ||
      url.username || url.password || !/^\/content\/[a-zA-Z0-9]+(?:\/[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname)) {
    throw new HttpError(400, "Use an HTTPS builder.aws.com/content/... post URL.");
  }
  // Slugs, tracking parameters and fragments must not create duplicate post IDs.
  return `https://builder.aws.com/content/${url.pathname.split("/")[2]}`;
}
