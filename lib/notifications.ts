import "server-only";
import { claimNotification, finishNotification } from "./repository";

export type NotificationKind = "review" | "auth_required" | "activity_failed";

export async function notifyRun(runId: string, kind: NotificationKind = "review"): Promise<void> {
  const run = await claimNotification(runId, kind);
  if (!run) return;
  const endpoint = process.env.NOTIFICATION_WEBHOOK_URL;
  let url: URL;
  try {
    url = new URL(endpoint ?? "");
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  } catch {
    await finishNotification(runId, "failed", "Notification webhook is missing or is not a valid HTTPS URL.", kind);
    return;
  }
  let status: "sent" | "failed" | "uncertain";
  let message: string;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.NOTIFICATION_WEBHOOK_SECRET ? { Authorization: `Bearer ${process.env.NOTIFICATION_WEBHOOK_SECRET}` } : {})
      },
      body: JSON.stringify({
        event: kind, run_id: run.id, local_date: run.local_date, status: run.status,
        message: kind === "auth_required" ? "Sign in to AWS in your browser and resume manual review." :
          kind === "activity_failed" ? "A manual activity was reported failed. Review the dashboard." :
          run.status === "no_post" ? "No queued Builder Center post is available. Add a post and retry preparation." :
          "Your Builder Center daily review is ready. Actions require manual completion.",
        dashboard_url: process.env.APP_URL ?? null
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
    status = response.ok ? "sent" : "failed";
    message = response.ok ? "Webhook returned a successful HTTP response; recipient reading is unverified." : `Webhook returned HTTP ${response.status}. No automatic retry.`;
    await response.body?.cancel();
  } catch {
    status = "uncertain";
    message = "Webhook delivery could not be confirmed. It may have arrived; do not automatically repeat it.";
  }
  await finishNotification(runId, status, message, kind);
}
