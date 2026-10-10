import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { postUrl } from "./validation";
import type {
  Activity,
  ActivityStatus,
  ActivityType,
  Config,
  DashboardData,
  DailyRun,
  Log,
  NotificationKind,
  Post,
  PrepareRunResult,
} from "./types";

let database: SupabaseClient | undefined;

function client(): SupabaseClient {
  if (database) return database;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY before using persistent storage.");
  }
  if (new URL(url).protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS.");
  }
  database = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return database;
}

function checked<T>(result: { data: unknown; error: unknown }): T {
  if (result.error || result.data === null) {
    // Never return the provider error, request headers, connection strings, or key.
    throw new Error("Database operation failed. Check Supabase availability and the database migration.");
  }
  return result.data as T;
}

function safeMessage(input: string | undefined): string {
  return (input ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(password|token|secret|cookie|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 300);
}

function validRunId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid daily run identifier.");
  }
}

export async function getDashboardData(): Promise<DashboardData> {
  const db = client();
  const results = await Promise.all([
    db.from("app_config").select("*").eq("id", 1).single(),
    db.from("queued_posts").select("*").order("state", { ascending: true }).order("created_at", { ascending: false }).limit(100),
    db.from("daily_runs").select("*").order("local_date", { ascending: false }).limit(30),
    db.from("execution_logs").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const config = checked<Config>(results[0]);
  const posts = checked<Post[]>(results[1]);
  const runs = checked<DailyRun[]>(results[2]);
  const logs = checked<Log[]>(results[3]);
  const activities = runs.length
    ? checked<Activity[]>(await db.from("post_activities").select("*").in("run_id", runs.map((run) => run.id)))
    : [];
  return { config, posts, runs, activities, logs };
}

export async function prepareDailyRun(input: {
  localDate: string;
  scheduledAt: string;
  retry: boolean;
}): Promise<PrepareRunResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) || !Number.isFinite(Date.parse(input.scheduledAt))) {
    throw new Error("Invalid scheduled date or timestamp.");
  }
  return checked<PrepareRunResult>(await client().rpc("prepare_daily_run", {
    p_local_date: input.localDate,
    p_scheduled_at: input.scheduledAt,
    p_retry: input.retry,
  }));
}

export async function addPost(input: { url: string; title: string }): Promise<Post> {
  const url = postUrl(input.url);
  const title = safeMessage(input.title);
  if (!title) throw new Error("Enter a post title.");
  return checked<Post>(await client().from("queued_posts").insert({ url, title }).select("*").single());
}

export async function updateConfig(input: {
  enabled: boolean;
  max_attempts: number;
  notifications_enabled: boolean;
  auto_mode?: boolean;
}): Promise<Config> {
  if (typeof input.enabled !== "boolean" || typeof input.notifications_enabled !== "boolean" || !Number.isInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > 3) {
    throw new Error("Retry limit must be an integer from 1 to 3.");
  }
  if (input.auto_mode !== undefined && typeof input.auto_mode !== "boolean") throw new Error("Automatic mode must be a boolean.");
  return checked<Config>(await client().from("app_config").update(input).eq("id", 1).select("*").single());
}

export async function reportActivity(input: {
  runId: string;
  type: ActivityType;
  status: ActivityStatus;
  message?: string;
}): Promise<void> {
  validRunId(input.runId);
  if (!["visit", "like", "comment"].includes(input.type) || !["user_reported", "already_done", "skipped", "failed", "uncertain"].includes(input.status)) {
    throw new Error("Choose a valid manual activity outcome.");
  }
  const result = await client().rpc("report_activity", {
    p_run_id: input.runId,
    p_activity_type: input.type,
    p_status: input.status,
    p_message: safeMessage(input.message),
  });
  if (result.error) throw new Error("This activity could not be changed. Completed or uncertain activities cannot be replayed.");
}

export async function reportAuthentication(runId: string, status: "auth_required" | "confirmed"): Promise<void> {
  validRunId(runId);
  if (!["auth_required", "confirmed"].includes(status)) throw new Error("Invalid authentication report.");
  const result = await client().rpc("report_authentication", { p_run_id: runId, p_status: status });
  if (result.error) throw new Error("The authentication report could not be saved for today's run.");
}

export async function replacePost(runId: string): Promise<void> {
  validRunId(runId);
  const result = await client().rpc("replace_post", { p_run_id: runId });
  if (result.error) throw new Error("Cannot replace this post. Queue another post and resolve any completed or uncertain engagement first.");
}

export async function claimNotification(runId: string, kind: NotificationKind = "review"): Promise<DailyRun | null> {
  validRunId(runId);
  const result = await client().rpc("claim_notification", { p_run_id: runId, p_kind: kind });
  if (result.error) throw new Error("Could not claim the daily notification.");
  return result.data as DailyRun | null;
}

export async function finishNotification(runId: string, status: "sent" | "failed" | "uncertain", message: string, kind: NotificationKind = "review"): Promise<void> {
  validRunId(runId);
  if (!["sent", "failed", "uncertain"].includes(status)) throw new Error("Invalid notification outcome.");
  const result = await client().rpc("finish_notification", {
    p_run_id: runId,
    p_status: status,
    p_message: safeMessage(message),
    p_kind: kind,
  });
  if (result.error) throw new Error("Could not save the notification result. Do not resend automatically.");
}
