import { handle, json, protectMutation } from "@/lib/http";
import { reportActivity } from "@/lib/repository";
import { requireCurrentRun } from "@/lib/current-run";
import { notifyRun } from "@/lib/notifications";
import { HttpError, readBody, runId } from "@/lib/validation";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const body = await readBody(request);
    const id = runId(body.runId);
    if (!(["visit", "like", "comment"] as unknown[]).includes(body.type) ||
        !(["user_reported", "already_done", "skipped", "failed", "uncertain"] as unknown[]).includes(body.status)) {
      throw new HttpError(400, "Choose a valid activity and outcome.");
    }
    if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 500)) throw new HttpError(400, "Notes must be at most 500 characters.");
    await requireCurrentRun(id);
    await reportActivity({ runId: id, type: body.type as "visit" | "like" | "comment", status: body.status as "user_reported" | "already_done" | "skipped" | "failed" | "uncertain", message: (body.message as string | undefined)?.trim() ?? "" });
    if (body.status === "failed") {
      try { await notifyRun(id, "activity_failed"); } catch { console.error(JSON.stringify({ event: "notification_storage_failed", run_id: id })); }
    }
    return json({ ok: true });
  });
}
