export type MonitorStatus = "done" | "running" | "waiting" | "attention" | "unknown";
export type MonitorActionStatus = "done" | "running" | "pending" | "attention" | "unknown";
export type MonitorActivity = "visit" | "like" | "comment";

export interface MonitorData {
  today: string;
  checkedAt: string;
  nextScheduledAt: string;
  source: "local" | "cloud" | "unavailable";
  todayStatus: MonitorStatus;
  actions: Record<MonitorActivity, MonitorActionStatus>;
  progress: {
    observedAt: string | null;
    visit: { day30: number | null; day90: number | null };
    like: { day30: number | null; day90: number | null };
    comment: { day30: number | null; day90: number | null };
  };
  recent: Array<{ date: string; status: MonitorStatus }>;
}
