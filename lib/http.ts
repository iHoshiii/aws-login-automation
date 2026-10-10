import { requireDashboard, requireOrigin } from "./auth";
import { HttpError } from "./validation";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handle(operation: () => Promise<Response>): Promise<Response> {
  try { return await operation(); } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ event: "request_failed", message: "Server operation failed. Check database setup and availability." }));
    return json({ error: "The operation could not be saved. Check database setup and availability, then refresh before retrying." }, 503);
  }
}

export async function protectMutation(request: Request) {
  requireOrigin(request);
  await requireDashboard();
}
