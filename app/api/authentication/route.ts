import { handle, json, protectMutation } from "@/lib/http";
import { reportAuthentication } from "@/lib/repository";
import { requireCurrentRun } from "@/lib/current-run";
import { notifyRun } from "@/lib/notifications";
import { HttpError, readBody, runId } from "@/lib/validation";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const body = await readBody(request);
    const id = runId(body.runId);
    if (body.status !== "confirmed" && body.status !== "auth_required") throw new HttpError(400, "Choose confirmed or auth_required.");
    await requireCurrentRun(id);
    await reportAuthentication(id, body.status);
    if (body.status === "auth_required") {
      try { await notifyRun(id, "auth_required"); } catch { console.error(JSON.stringify({ event: "notification_storage_failed", run_id: id })); }
    }
    return json({ ok: true });
  });
}
