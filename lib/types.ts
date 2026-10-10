export type RunStatus = "pending_review" | "no_post" | "failed" | "auth_required" | "complete";
export type NotificationStatus = "pending" | "sending" | "sent" | "failed" | "uncertain" | "disabled";
export type NotificationKind = "review" | "auth_required" | "activity_failed";
export type ActivityType = "visit" | "like" | "comment";
export type ActivityStatus = "pending" | "user_reported" | "already_done" | "skipped" | "failed" | "uncertain";

export interface Config {
  id: number;
  enabled: boolean;
  max_attempts: number;
  notifications_enabled: boolean;
  auto_mode?: boolean;
}

export interface Post {
  id: string;
  title: string;
  url: string;
  state: "available" | "reserved" | "used";
  created_at: string;
}

export interface DailyRun {
  id: string;
  local_date: string;
  scheduled_at: string;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  attempt_count: number;
  post_id: string | null;
  post_url: string | null;
  post_title: string | null;
  error_message: string | null;
  notification_status: NotificationStatus;
}

export interface Activity {
  id: string;
  run_id: string;
  post_url: string | null;
  activity_type: ActivityType;
  status: ActivityStatus;
  attempted_at: string | null;
  message: string | null;
}

export interface Log {
  id: string;
  run_id: string | null;
  created_at: string;
  event: string;
  message: string;
}

export interface DashboardData {
  config: Config;
  posts: Post[];
  runs: DailyRun[];
  activities: Activity[];
  logs: Log[];
}

export interface PrepareRunResult {
  outcome: "created" | "existing" | "disabled" | "retry_limit";
  run: DailyRun | null;
}
