import type { ActivityType } from "./types";

export type AutomationRunStatus = "running" | "verified" | "no_post" | "auth_required" | "failed" | "uncertain";
export type AutomationActionPhase = "started" | "verified" | "failed" | "uncertain" | "skipped";
export type AutomationNotificationKind = "result" | "auth_required" | "failure";

/** Contains activity evidence, never the AWS session or the internal lease token. */
export interface AutomationRun {
  id: string;
  local_date: string;
  scheduled_at: string;
  started_at: string;
  finished_at: string | null;
  status: AutomationRunStatus;
  post_url: string | null;
  post_title: string | null;
  account_profile_url: string | null;
  error_message: string | null;
  attempts: number;
  lease_until: string;
}

export interface AutomationAction {
  id: string;
  run_id: string;
  activity_type: ActivityType;
  phase: AutomationActionPhase;
  attempted_at: string;
  verified_at: string | null;
  post_url: string;
  message: string | null;
}

export interface AutomationLog {
  id: string;
  run_id: string;
  created_at: string;
  event: string;
  message: string;
}

export interface ClaimAutomationRunResult {
  outcome: "claimed" | "existing" | "disabled" | "retry_limit";
  run: AutomationRun | null;
  token: string | null;
}

export interface AutomationHistory {
  runs: AutomationRun[];
  actions: AutomationAction[];
  logs: AutomationLog[];
}
