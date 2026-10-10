"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { MonitorActionStatus, MonitorActivity, MonitorData, MonitorStatus } from "@/lib/monitor-types";

const titles: Record<MonitorActivity, string> = { visit: "Visit", like: "Like", comment: "Comment" };
const statusText: Record<MonitorStatus, string> = {
  done: "Done today", running: "Running now", waiting: "Waiting for today's run", attention: "Needs a look", unknown: "No data yet"
};
const actionText: Record<MonitorActionStatus, string> = {
  done: "Done", running: "Running", pending: "Pending", attention: "Check", unknown: "—"
};

function formatDay(value: string) {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${value}T12:00:00+08:00`));
}
function formatShortDay(value: string) {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${value}T12:00:00+08:00`));
}
function formatTime(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function Bar({ label, current, total }: { label: string; current: number | null; total: 30 | 90 }) {
  const pct = current === null ? 0 : Math.min(100, Math.round((current / total) * 100));
  return (
    <div className="monitor-bar">
      <div className="monitor-bar-head">
        <span>{label}</span>
        <span className="monitor-bar-value">{current === null ? "—" : current} / {total}</span>
      </div>
      <div className="monitor-track" role="img" aria-label={`${label}: ${current === null ? "no data yet" : `${current} of ${total} days`}`}>
        <div className="monitor-fill" style={{ width: `${pct}%` }} data-complete={current !== null && current >= total ? "true" : undefined} />
      </div>
    </div>
  );
}

export function Monitor({ data }: { data: MonitorData }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(id);
  }, [router]);

  async function signOut() {
    try {
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch { /* Navigate to the login screen regardless; it re-checks the session. */ }
    window.location.replace("/login");
  }

  return (
    <main className="monitor">
      <header className="monitor-top">
        <h1>Daily activity monitor</h1>
        <button type="button" className="monitor-signout" onClick={signOut}>Sign out</button>
      </header>

      <section className={`monitor-status is-${data.todayStatus}`}>
        <div>
          <span className="monitor-eyebrow">{formatDay(data.today)}</span>
          <strong>{statusText[data.todayStatus]}</strong>
        </div>
        <span className="monitor-status-dot" aria-hidden="true" />
      </section>

      <div className="monitor-grid">
        {(["visit", "like", "comment"] as MonitorActivity[]).map((key) => (
          <article className="monitor-card" key={key}>
            <header className="monitor-card-head">
              <h2>{titles[key]}</h2>
              <span className={`monitor-badge is-${data.actions[key]}`}>{actionText[data.actions[key]]}</span>
            </header>
            <Bar label="30-day streak" current={data.progress[key].day30} total={30} />
            <Bar label="90-day streak" current={data.progress[key].day90} total={90} />
          </article>
        ))}
      </div>

      {data.progress.observedAt && <p className="monitor-observed">Streaks observed {formatTime(data.progress.observedAt)}</p>}

      <section className="monitor-recent">
        <h2>Recent days</h2>
        {data.recent.length ? (
          <ol className="monitor-days">
            {data.recent.map((day) => (
              <li key={day.date} className={`is-${day.status}`}>
                <span className="monitor-day-date">{formatShortDay(day.date)}</span>
                <span className="monitor-day-dot" aria-hidden="true" />
                <span className="monitor-day-status">{statusText[day.status]}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="monitor-empty">No runs recorded yet. A daily run appears here after <code>npm run aws:daily</code>.</p>
        )}
      </section>

      <footer className="monitor-foot">
        <span>{data.source === "unavailable" ? "No local data yet" : `Checked ${formatTime(data.checkedAt)}`}</span>
        <span>Next run {formatTime(data.nextScheduledAt)} · Asia/Manila</span>
      </footer>
    </main>
  );
}
