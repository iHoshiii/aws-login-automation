import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { manilaDate, nextScheduledTime } from "./time";
import type { MonitorActionStatus, MonitorData, MonitorStatus } from "./monitor-types";

/** Local daily journals written by `npm run aws:daily`; the only source read on dev. */
const JOURNAL_DIRECTORY = ".local/aws-daily";
/** Optional complete-streak snapshot (all six badges) written by the daily check. */
const OBSERVATION_CACHE = ".local/activity.json";
const RECENT_LIMIT = 14;

type DailyStatus = "running" | "verified" | "auth_required" | "no_post" | "failed" | "uncertain";
type ActionState = "not_started" | "started" | "verified";
interface Journal {
  date: string;
  status: DailyStatus;
  actions: { like: ActionState; comment: ActionState };
  activity: ActivitySummary | null;
}
interface ActivitySummary {
  observedAt: string;
  visit: number; like: number; comment: number;
  visit90: number; like90: number | null; comment90: number | null;
}

function count(value: unknown, total: 30 | 90): number | null {
  if (!value || typeof value !== "object") return null;
  const { current, total: observed } = value as { current?: unknown; total?: unknown };
  return observed === total && Number.isInteger(current) && (current as number) >= 0 && (current as number) <= total ? (current as number) : null;
}

function parseActivity(value: unknown): ActivitySummary | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const visit = count(entry.visit, 30), like = count(entry.like, 30), comment = count(entry.comment, 30), visit90 = count(entry.visit90, 90);
  if (typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt)) || visit === null || like === null || comment === null || visit90 === null) return null;
  return { observedAt: entry.observedAt, visit, like, comment, visit90, like90: count(entry.like90, 90), comment90: count(entry.comment90, 90) };
}

async function readJournal(directory: string, date: string): Promise<Journal | null> {
  try {
    const path = join(directory, `${date}.json`);
    if ((await stat(path)).size > 128_000) return null;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const run = value as Record<string, unknown>;
    const actions = run.actions as { like?: unknown; comment?: unknown } | undefined;
    const states: ActionState[] = ["not_started", "started", "verified"];
    const statuses: DailyStatus[] = ["running", "verified", "auth_required", "no_post", "failed", "uncertain"];
    if (run.version !== 1 || run.date !== date || !statuses.includes(run.status as DailyStatus) ||
        !actions || !states.includes(actions.like as ActionState) || !states.includes(actions.comment as ActionState)) return null;
    return {
      date, status: run.status as DailyStatus,
      actions: { like: actions.like as ActionState, comment: actions.comment as ActionState },
      activity: parseActivity(run.activity)
    };
  } catch { return null; }
}

function overallStatus(run: Journal | null): MonitorStatus {
  if (!run) return "waiting";
  if (run.status === "verified") return "done";
  if (run.status === "running") return "running";
  if (run.status === "no_post") return "waiting";
  return "attention";
}

function engagementStatus(state: ActionState, run: Journal): MonitorActionStatus {
  if (state === "verified") return "done";
  if (state === "started") return run.status === "running" ? "running" : "attention";
  return run.status === "running" ? "running" : "pending";
}

function visitStatus(run: Journal | null): MonitorActionStatus {
  if (!run) return "pending";
  if (run.status === "verified" || run.status === "no_post") return "done";
  if (run.status === "running") return "running";
  return "attention";
}

/** The complete six-streak snapshot written by `npm run aws:daily -- --check`; preferred over partial journals. */
async function readObservationCache(path: string): Promise<ActivitySummary | null> {
  try {
    if ((await stat(path)).size > 128_000) return null;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || (value as Record<string, unknown>).version !== 1) return null;
    return parseActivity((value as Record<string, unknown>).activity);
  } catch { return null; }
}

function newerActivity(a: ActivitySummary | null, b: ActivitySummary | null): ActivitySummary | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a.observedAt) >= Date.parse(b.observedAt) ? a : b;
}

/** Always resolves; an unreadable workspace yields an "unavailable" monitor rather than throwing. */
export async function buildMonitorData(now: Date): Promise<MonitorData> {
  const base = { today: manilaDate(now), checkedAt: now.toISOString(), nextScheduledAt: nextScheduledTime(now).toISOString() };
  const unavailable: MonitorData = {
    ...base, source: "unavailable", todayStatus: "unknown",
    actions: { visit: "unknown", like: "unknown", comment: "unknown" },
    progress: { observedAt: null, visit: { day30: null, day90: null }, like: { day30: null, day90: null }, comment: { day30: null, day90: null } },
    recent: []
  };

  const cwd = process.cwd();
  const cached = await readObservationCache(resolve(cwd, OBSERVATION_CACHE));

  const runs: Journal[] = [];
  try {
    const directory = resolve(cwd, JOURNAL_DIRECTORY);
    const dates = (await readdir(directory))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => name.slice(0, -5))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, RECENT_LIMIT);
    for (const date of dates) {
      const run = await readJournal(directory, date);
      if (run) runs.push(run);
    }
  } catch { /* No journals yet; a cached observation may still provide progress. */ }

  const observed = newerActivity(cached, runs.find(run => run.activity)?.activity ?? null);
  if (!runs.length && !observed) return unavailable;

  const today = runs.find(run => run.date === base.today) ?? null;
  return {
    ...base,
    source: "local",
    todayStatus: overallStatus(today),
    actions: {
      visit: visitStatus(today),
      like: today ? engagementStatus(today.actions.like, today) : "pending",
      comment: today ? engagementStatus(today.actions.comment, today) : "pending"
    },
    progress: {
      observedAt: observed?.observedAt ?? null,
      visit: { day30: observed?.visit ?? null, day90: observed?.visit90 ?? null },
      like: { day30: observed?.like ?? null, day90: observed?.like90 ?? null },
      comment: { day30: observed?.comment ?? null, day90: observed?.comment90 ?? null }
    },
    recent: runs.map(run => ({ date: run.date, status: overallStatus(run) }))
  };
}
