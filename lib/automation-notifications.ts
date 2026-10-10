import "server-only";
import { claimAutomationNotification, finishAutomationNotification } from "./automation-repository";
import type { AutomationNotificationKind } from "./automation-types";

export async function notifyAutomation(runId: string, kind: AutomationNotificationKind) {
  const run = await claimAutomationNotification(runId, kind);
  if (!run) return;
  let endpoint: URL;
  try {
    endpoint = new URL(process.env.NOTIFICATION_WEBHOOK_URL ?? "");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
  } catch {
    await finishAutomationNotification(runId, kind, "failed", "Configure an HTTPS notification webhook before enabling notifications.");
    return;
  }
  let status: "sent" | "failed" | "uncertain";
  let message: string;
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", ...(process.env.NOTIFICATION_WEBHOOK_SECRET ? { Authorization: `Bearer ${process.env.NOTIFICATION_WEBHOOK_SECRET}` } : {}) },
      body: JSON.stringify({ event: `automatic_${kind}`, run_id: run.id, local_date: run.local_date, status: run.status,
        message: run.status === "verified" ? "Visit, like and comment were observed on AWS. Reward and streak eligibility are unverified." :
          run.status === "auth_required" ? "Reconnect AWS using the local connection helper. No authentication challenges are bypassed." :
          run.status === "no_post" ? "No eligible candidate could be confirmed during bounded discovery." :
          "Automatic activity requires attention. Inspect the dashboard and AWS before retrying.",
        post_url: run.post_url, dashboard_url: process.env.APP_URL ?? null })
    });
    status = response.ok ? "sent" : "failed";
    message = response.ok ? "Webhook acknowledged delivery; recipient reading is unverified." : `Webhook returned HTTP ${response.status}. No automatic resend.`;
    await response.body?.cancel();
  } catch {
    status = "uncertain";
    message = "Webhook response was not confirmed. Delivery may have occurred; no automatic resend.";
  }
  await finishAutomationNotification(runId, kind, status, message);
}
