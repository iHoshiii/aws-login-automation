import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AutomationAction,
  AutomationActionPhase,
  AutomationHistory,
  AutomationLog,
  AutomationNotificationKind,
  AutomationRun,
  AutomationRunStatus,
  ClaimAutomationRunResult,
} from "./automation-types";
import type { ActivityType } from "./types";
import { postUrl } from "./validation";

let database: SupabaseClient | undefined;

function client(): SupabaseClient {
  if (database) return database;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Configure Supabase before running automatic activity.");
  if (new URL(url).protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS.");
  database = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return database;
}

function checked<T>(result: { data: unknown; error: unknown }): T {
  if (result.error || result.data === null) {
    throw new Error("Automatic activity storage failed. Check Supabase and apply both database migrations.");
  }
  return result.data as T;
}

/** Persist only bounded, redacted diagnostics; provider errors never escape. */
export function redactAutomationMessage(input: string | undefined, max = 300): string {
  return (input ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/["']?\b(cookie|authorization)["']?\s*[:=]\s*[^\r\n]+/gi, "$1=[redacted]")
    .replace(/["']?\b(password|token|secret|api[_-]?key|value)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, max);
}

function identifier(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid automatic run or worker identifier.");
  }
}

function lease(runId: string, token: string): { p_run_id: string; p_token: string } {
  identifier(runId);
  identifier(token);
  return { p_run_id: runId, p_token: token };
}

function activity(type: ActivityType): void {
  if (!["visit", "like", "comment"].includes(type)) throw new Error("Invalid automatic activity type.");
}

function notification(kind: AutomationNotificationKind): void {
  if (!["result", "auth_required", "failure"].includes(kind)) throw new Error("Invalid automatic notification kind.");
}

async function write(name: string, parameters: Record<string, unknown>): Promise<void> {
  const result = await client().rpc(name, parameters);
  if (result.error) throw new Error("Could not save automatic activity. A stale or settled worker cannot repeat an action.");
}

export async function claimAutomationRun(input: {
  localDate: string;
  scheduledAt: string;
  retry: boolean;
  accountProfileUrl: string | null;
}): Promise<ClaimAutomationRunResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) || !Number.isFinite(Date.parse(input.scheduledAt)) || typeof input.retry !== "boolean") {
    throw new Error("Invalid automatic execution date or retry flag.");
  }
  if (input.accountProfileUrl !== null) {
    const profile = new URL(input.accountProfileUrl);
    if (profile.protocol !== "https:" || profile.hostname !== "builder.aws.com" || profile.port || profile.username || profile.password || profile.search || profile.hash) {
      throw new Error("Use a Builder Center HTTPS account profile URL.");
    }
  }
  return checked<ClaimAutomationRunResult>(await client().rpc("claim_automation_run", {
    p_local_date: input.localDate,
    p_scheduled_at: input.scheduledAt,
    p_retry: input.retry,
    p_account_profile_url: input.accountProfileUrl,
  }));
}

export async function assignAutomationPost(runId: string, token: string, post: { url: string; title: string }): Promise<boolean> {
  const title = redactAutomationMessage(post.title);
  if (!title) throw new Error("The selected post needs a title.");
  return checked<boolean>(await client().rpc("assign_automation_post", {
    ...lease(runId, token), p_url: postUrl(post.url), p_title: title,
  }));
}

export async function beginAutomationAction(runId: string, token: string, type: ActivityType): Promise<boolean> {
  activity(type);
  return checked<boolean>(await client().rpc("begin_automation_action", { ...lease(runId, token), p_activity_type: type }));
}

/** Recheck pause and the current claim immediately before a browser submission. */
export async function assertAutomationActionReady(runId: string, token: string, type: ActivityType): Promise<boolean> {
  activity(type);
  return checked<boolean>(await client().rpc("assert_automation_action_ready", { ...lease(runId, token), p_activity_type: type }));
}

export async function finishAutomationAction(runId: string, token: string, type: ActivityType, status: Exclude<AutomationActionPhase, "started">, message = ""): Promise<void> {
  activity(type);
  if (!["verified", "failed", "uncertain", "skipped"].includes(status)) throw new Error("Invalid automatic activity result.");
  await write("finish_automation_action", {
    ...lease(runId, token), p_activity_type: type, p_phase: status, p_message: redactAutomationMessage(message),
  });
}

export async function finishAutomationRun(runId: string, token: string, status: Exclude<AutomationRunStatus, "running">, message = ""): Promise<void> {
  if (!["verified", "no_post", "auth_required", "failed", "uncertain"].includes(status)) throw new Error("Invalid automatic run result.");
  await write("finish_automation_run", { ...lease(runId, token), p_status: status, p_message: redactAutomationMessage(message) });
}

export async function appendAutomationLog(runId: string, token: string, event: string, message: string): Promise<void> {
  const safeEvent = redactAutomationMessage(event, 80);
  if (!safeEvent) throw new Error("An automatic log needs an event name.");
  await write("append_automation_log", {
    ...lease(runId, token), p_event: safeEvent, p_message: redactAutomationMessage(message, 2000),
  });
}

export async function getAutomationHistory(): Promise<AutomationHistory> {
  const db = client();
  // Never serialize worker tokens into the browser or notification payloads.
  const results = await Promise.all([
    db.from("automation_runs").select("id,local_date,scheduled_at,started_at,finished_at,status,post_url,post_title,account_profile_url,error_message,attempts,lease_until")
      .order("local_date", { ascending: false }).limit(30),
    db.from("automation_logs").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const runs = checked<AutomationRun[]>(results[0]);
  const logs = checked<AutomationLog[]>(results[1]);
  const actions = runs.length
    ? checked<AutomationAction[]>(await db.from("automation_actions").select("*").in("run_id", runs.map((run) => run.id)))
    : [];
  return { runs, actions, logs };
}

export async function claimAutomationNotification(runId: string, kind: AutomationNotificationKind): Promise<AutomationRun | null> {
  identifier(runId);
  notification(kind);
  const result = await client().rpc("claim_automation_notification", { p_run_id: runId, p_kind: kind });
  if (result.error) throw new Error("Could not claim the automatic activity notification.");
  return result.data as AutomationRun | null;
}

export async function finishAutomationNotification(runId: string, kind: AutomationNotificationKind, status: "sent" | "failed" | "uncertain", message = ""): Promise<void> {
  identifier(runId);
  notification(kind);
  if (!["sent", "failed", "uncertain"].includes(status)) throw new Error("Invalid automatic notification result.");
  await write("finish_automation_notification", {
    p_run_id: runId, p_kind: kind, p_status: status, p_message: redactAutomationMessage(message),
  });
}
