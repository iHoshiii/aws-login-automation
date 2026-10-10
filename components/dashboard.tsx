"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Activity, DashboardData, DailyRun } from "@/lib/types";
import type { AutomationHistory } from "@/lib/automation-types";

type ActivityType = "visit" | "like" | "comment";
type ActivityStatus = Activity["status"];

const statusLabels: Record<string, string> = {
  running: "Running", expired: "Execution expired", started: "Attempt started", verified: "Verified on AWS",
  pending_review: "Ready for review", no_post: "No eligible post", failed: "Failed",
  auth_required: "AWS reconnect needed", complete: "Review recorded", pending: "Pending",
  user_reported: "User reported", already_done: "Already done", skipped: "Skipped",
  uncertain: "Needs inspection", available: "Available", reserved: "Reserved", used: "Used",
  sending: "Sending", sent: "Sent", disabled: "Off",
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${value}T12:00:00+08:00`));
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{statusLabels[value] ?? value.replaceAll("_", " ")}</span>;
}

function ActivityRow({ activity, type, run, busy, save }: {
  activity: Activity | undefined; type: ActivityType; run: DailyRun; busy: boolean;
  save: (type: ActivityType, status: ActivityStatus, message: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<ActivityStatus>(activity?.status ?? "pending");
  const [message, setMessage] = useState(activity?.message ?? "");
  const locked = activity?.status === "user_reported" || activity?.status === "already_done" || activity?.status === "uncertain";
  const titles = { visit: "Visit Builder Center", like: "Like the post", comment: "Comment on the post" };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status !== "pending") await save(type, status, message);
  }
  return (
    <form className="activity-row" onSubmit={submit}>
      <div className={`activity-symbol activity-symbol-${type}`} aria-hidden="true">{type === "visit" ? "↗" : type === "like" ? "♡" : "≡"}</div>
      <div className="activity-body">
        <div className="activity-heading"><h3>{titles[type]}</h3><Status value={activity?.status ?? "pending"} /></div>
        <p className="small muted">Record your own observation after checking the result on AWS.</p>
        <div className="activity-fields">
          <div className="field outcome-field">
            <label htmlFor={`${run.id}-${type}-status`}>Outcome</label>
            <select id={`${run.id}-${type}-status`} value={status} onChange={(event) => setStatus(event.target.value as ActivityStatus)} disabled={busy || locked}>
              <option value="pending" disabled>Select an outcome</option>
              <option value="user_reported">I completed this on AWS</option>
              <option value="already_done">Already done on AWS</option>
              <option value="skipped">Skipped</option>
              <option value="uncertain">I'm unsure it succeeded</option>
              <option value="failed">It failed</option>
            </select>
          </div>
          <div className="field note-field"><label htmlFor={`${run.id}-${type}-note`}>Note <span className="muted">(optional)</span></label><input id={`${run.id}-${type}-note`} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Add context" maxLength={300} disabled={busy || locked} /></div>
          <button type="submit" className="button secondary activity-save" disabled={busy || locked || status === "pending"}>Save</button>
        </div>
        {activity?.attempted_at && <p className="activity-timestamp">Last recorded {formatDateTime(activity.attempted_at)} · Philippine time</p>}
        {locked && <p className="activity-timestamp">This report is locked. Check uncertain outcomes directly on AWS.</p>}
      </div>
    </form>
  );
}

export function Dashboard({ data, automation, sessionConfigured, nextScheduledAt, today, checkedAt }: {
  data: DashboardData; automation: AutomationHistory | null; sessionConfigured: boolean;
  nextScheduledAt: string; today: string; checkedAt: string;
}) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [postTitle, setPostTitle] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [enabled, setEnabled] = useState(data.config.enabled);
  const [autoMode, setAutoMode] = useState(data.config.auto_mode ?? true);
  const [notifications, setNotifications] = useState(data.config.notifications_enabled);
  const [maxAttempts, setMaxAttempts] = useState(data.config.max_attempts);
  const busy = pendingKey !== null || refreshing;
  const automaticEnabled = data.config.auto_mode ?? true;
  const runs = useMemo(() => [...(automation?.runs ?? [])].sort((a, b) => b.local_date.localeCompare(a.local_date)), [automation]);
  const run = runs.find((item) => item.local_date === today);
  const actions = automation?.actions.filter((item) => item.run_id === run?.id) ?? [];
  const verifiedCount = actions.filter((item) => item.phase === "verified").length;
  const manualRuns = useMemo(() => [...data.runs].sort((a, b) => b.local_date.localeCompare(a.local_date)), [data.runs]);
  const manualRun = manualRuns.find((item) => item.local_date === today);
  const manualActivities = data.activities.filter((item) => item.run_id === manualRun?.id);
  const manualCandidateLocked = manualActivities.some((item) => (item.activity_type === "like" || item.activity_type === "comment") && (item.status === "user_reported" || item.status === "uncertain"));
  const availablePosts = data.posts.filter((item) => item.state === "available").length;
  const preparationAvailable = new Date(checkedAt).getTime() >= new Date(`${today}T09:00:00+08:00`).getTime();
  const scheduleOverdue = !(automaticEnabled ? run : manualRun) && data.config.enabled && new Date(checkedAt).getTime() >= new Date(`${today}T10:00:00+08:00`).getTime();
  const leaseExpired = run?.status === "running" && Date.parse(run.lease_until) <= Date.parse(checkedAt);
  const retryAllowed = run && (["failed", "auth_required", "no_post"].includes(run.status) || leaseExpired) && run.attempts < data.config.max_attempts && !actions.some((item) => item.activity_type === "like" || item.activity_type === "comment" || item.phase === "started" || item.phase === "uncertain");
  const canRun = !busy && data.config.enabled && automaticEnabled && Boolean(automation) && sessionConfigured && preparationAvailable;

  async function mutate(path: string, body: object, key: string, success: string) {
    if (busy) return false;
    setPendingKey(key); setError(null); setNotice(null);
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The request could not be completed. Check the recorded run before trying again.");
      setNotice(success);
      startTransition(() => router.refresh());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect. Refresh to check the recorded result.");
      startTransition(() => router.refresh());
      return false;
    } finally { setPendingKey(null); }
  }

  async function addPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate("/api/posts", { url: postUrl, title: postTitle }, "post", "Post added to the optional queue.")) { setPostTitle(""); setPostUrl(""); }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate("/api/config", { enabled, auto_mode: autoMode, max_attempts: maxAttempts, notifications_enabled: notifications }, "config", "Schedule settings saved.");
  }

  async function logout() {
    if (busy) return;
    setPendingKey("logout"); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
      window.location.replace("/login");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect."); setPendingKey(null); }
  }

  return (
    <div className="dashboard-shell">
      <a href="#main-content" className="skip-link">Skip to dashboard</a>
      <header className="topbar"><div className="topbar-inner">
        <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">d.</span><span>Daily Activity<span className="brand-caption">Builder Center</span></span></a>
        <nav aria-label="Main navigation"><a className="nav-link" href="https://builder.aws.com/" target="_blank" rel="noopener noreferrer">Open Builder Center ↗</a><button className="button quiet" onClick={logout} disabled={busy}>Sign out</button></nav>
      </div></header>
      <main id="main-content" className="dashboard-main">
        <section className="page-heading"><div><span className="eyebrow">{formatDay(today)}</span><h1>Your daily AWS activity.</h1><p className="muted">Find an untouched post, like it, comment, and verify the result.</p></div><div className={`schedule-pill ${data.config.enabled ? "" : "paused"}`}><span className="schedule-dot" aria-hidden="true" />{data.config.enabled ? (automaticEnabled ? "Automation enabled" : "Manual mode enabled") : "Schedule paused"}</div></section>
        <div className="feedback-area" aria-live="polite" aria-atomic="true">
          {error && <p className="feedback error" role="alert">{error}</p>}
          {notice && <p className="feedback success">{notice}</p>}
          {busy && <p className="feedback saving">{pendingKey === "run" || pendingKey === "retry" ? "The worker is checking AWS. This can take a few minutes." : "Saving changes…"}</p>}
        </div>
        {!automation && <div className="overdue-note" role="alert"><strong>Automatic run storage needs setup.</strong><p>Apply <code>002_automation.sql</code> after the initial migration, then check Supabase connectivity and reload. Automatic history could not be loaded; automatic runs are unavailable from this page.</p></div>}
        {automaticEnabled && !sessionConfigured && <div className="overdue-note"><strong>Connect your AWS account before running.</strong><p>Run <code>npm run aws:connect</code> locally, sign in, and complete the on-screen calibration. Add the generated encrypted session and key to your environment, then restart or redeploy.</p></div>}
        {run?.status === "auth_required" && <div className="overdue-note"><strong>Your AWS session needs reconnecting.</strong><p>Run <code>npm run aws:connect</code> again and replace the AWS session environment values. Complete sign-in challenges yourself, then retry only if the run allows it.</p></div>}
        {scheduleOverdue && <div className="overdue-note"><strong>Today's scheduled run has not arrived.</strong><p>The 9:00–10:00 AM scheduling window has passed. Check Vercel cron logs, or start today's run below.</p></div>}

        <section className="stats-grid" aria-label="Daily overview">
          <article className="stat-card"><span className="stat-label">Next scheduled run</span><strong>{data.config.enabled ? formatDateTime(nextScheduledAt) : "Paused"}</strong><span className="stat-detail">9:00 AM · Asia/Manila</span></article>
          <article className="stat-card"><span className="stat-label">Today's automatic run</span><strong>{run ? (run.status === "verified" ? "Verified" : statusLabels[leaseExpired ? "expired" : run.status]) : "Not started"}</strong><span className="stat-detail">{run ? `${verifiedCount} of 3 actions verified` : "AWS feed discovery selects a candidate"}</span></article>
          <article className="stat-card"><span className="stat-label">AWS connection</span><strong>{run?.status === "auth_required" ? "Reconnect" : sessionConfigured ? "Configured" : "Setup needed"}</strong><span className="stat-detail">{sessionConfigured ? "Session validity is checked during execution" : "Capture your session locally first"}</span></article>
          <article className="stat-card"><span className="stat-label">Last automatic execution</span><strong>{runs[0] ? formatDateTime(runs[0].started_at) : "No runs yet"}</strong><span className="stat-detail">Dashboard times are Philippine time</span></article>
        </section>

        <div className="workspace-grid"><div className="primary-column">
          <section className="card review-card" aria-labelledby="review-title">
            <div className="card-heading"><div><span className="eyebrow">Automatic activity</span><h2 id="review-title">Today's run</h2></div>{run && <Status value={leaseExpired ? "expired" : run.status} />}</div>
            {!run ? <div className="empty-review"><span className="empty-symbol" aria-hidden="true">↗</span><h3>One eligible post. One daily run.</h3><p>The worker searches Builder Center and checks that your account has neither liked nor commented on the candidate. It records each attempt before acting, then checks the result on AWS.</p><button className="button primary" disabled={!canRun} onClick={() => mutate("/api/run", {}, "run", "Run request finished. Review the recorded result below.")}>{pendingKey === "run" ? "Running…" : "Run now"} →</button>{!preparationAvailable && <p className="small muted">Available after 9:00 AM Philippine time. Refresh this page when it is time.</p>}{!automaticEnabled && <p className="small muted">Automatic mode is off. Turn it on in settings or use the manual review below.</p>}</div> : <>
              {run.error_message && <p className="review-message">{run.error_message}</p>}
              {leaseExpired && <p className="review-message">The previous worker's lease expired. {retryAllowed ? "No engagement was claimed; you can explicitly retry preparation." : "Inspect AWS and the recorded actions before further engagement. Automatic replay remains blocked."}</p>}
              {run.post_url && <div className="candidate-card"><div><span className="eyebrow">Selected post</span><h3>{run.post_title || "Builder Center post"}</h3><p className="candidate-url">{run.post_url}</p></div><a className="button secondary" href={run.post_url} target="_blank" rel="noopener noreferrer">Inspect on AWS ↗</a></div>}
              <div className="automation-actions">
                {(["visit", "like", "comment"] as ActivityType[]).map((type) => {
                  const action = actions.find((item) => item.activity_type === type);
                  return <article className="automation-action" key={type}><div className="activity-heading"><h3>{type === "visit" ? "Authenticated visit" : type === "like" ? "Like" : "Comment"}</h3><Status value={action?.phase ?? "pending"} /></div><p className="small muted">{action?.message || (action ? "An action attempt has been recorded." : "No attempt recorded.")}</p>{action && <p className="activity-timestamp">{action.verified_at ? `Verified ${formatDateTime(action.verified_at)}` : `Attempt ${formatDateTime(action.attempted_at)}`}</p>}</article>;
                })}
              </div>
              <div className="automation-controls"><p className="small muted">Attempt {run.attempts} of {data.config.max_attempts}. Repeated scheduler calls keep the same daily record.</p>{retryAllowed && <button className="button secondary" disabled={!canRun} onClick={() => mutate("/api/run", { retry: true }, "retry", "Retry request finished. Review the recorded result below.")}>{pendingKey === "retry" ? "Retrying…" : "Retry before engagement"}</button>}{run.status === "running" && <button className="button secondary" disabled={busy} onClick={() => startTransition(() => router.refresh())}>Refresh status</button>}</div>
              {run.status === "uncertain" && <div className="manual-note"><span aria-hidden="true">i</span><p>An action or result could not be established. Inspect the selected post on AWS. This run cannot replay engagement automatically.</p></div>}
            </>}
            <p className="automation-caption">Verified means the worker observed the action result on AWS. Check badges and streaks in your AWS profile.</p>
          </section>

          <section className="card" aria-labelledby="runs-title"><div className="card-heading"><div><span className="eyebrow">Automatic history</span><h2 id="runs-title">Recent daily runs</h2></div><span className="small muted">Asia/Manila</span></div>
            {runs.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Local date</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Attempts</th></tr></thead><tbody>{runs.slice(0, 10).map((item) => <tr key={item.id}><td className="table-strong">{item.local_date}</td><td><Status value={item.status === "running" && Date.parse(item.lease_until) <= Date.parse(checkedAt) ? "expired" : item.status} /></td><td>{formatDateTime(item.started_at)}</td><td>{item.attempts}</td></tr>)}</tbody></table></div> : <p className="empty-line">Your first automatic run will appear here.</p>}
          </section>

          <details className="card manual-history" open={!automaticEnabled}><summary>Manual reviews and earlier records</summary>
            <p className="manual-description">These records contain your own reports. They are separate from the worker's verified observations. Choose manual mode in settings to prepare a manual review.</p>
            {!automaticEnabled && !manualRun && <div className="automation-controls"><button className="button secondary" disabled={busy || !data.config.enabled || !preparationAvailable} onClick={() => mutate("/api/run", {}, "manual", "Manual review preparation finished.")}>Prepare today's manual review</button></div>}
            {manualRun && <>
              <div className="card-heading"><h3>Today's manual review</h3><Status value={manualRun.status} /></div>
              {manualRun.post_url && <div className="candidate-card"><div><h3>{manualRun.post_title || "Builder Center post"}</h3><p className="candidate-url">{manualRun.post_url}</p></div><a className="button secondary" href={manualRun.post_url} target="_blank" rel="noopener noreferrer">Open post ↗</a></div>}
              {!automaticEnabled && !manualRun.post_url && <div className="automation-controls"><button className="button secondary" disabled={busy || !data.config.enabled || manualRun.attempt_count >= data.config.max_attempts} onClick={() => mutate("/api/run", { retry: true }, "manual-retry", "Manual preparation retried.")}>Retry manual preparation</button></div>}
              <div className="activity-list">{(["visit", "like", "comment"] as ActivityType[]).map((type) => {
                const activity = manualActivities.find((item) => item.activity_type === type);
                return <ActivityRow key={`${manualRun.id}-${manualRun.post_id}-${type}-${activity?.status}-${activity?.attempted_at}`} activity={activity} type={type} run={manualRun} busy={busy || automaticEnabled || (type !== "visit" && !manualRun.post_url)} save={(activityType, status, message) => mutate("/api/activity", { runId: manualRun.id, type: activityType, status, message }, activityType, "Manual report recorded.")} />;
              })}</div>
              {!automaticEnabled && <div className="review-tools">{manualRun.post_url && manualRun.status !== "complete" && <button className="button quiet" disabled={busy || !availablePosts || manualCandidateLocked} onClick={() => mutate("/api/replace-post", { runId: manualRun.id }, "replace", "A new manual candidate has been reserved.")}>Next queued candidate →</button>}<button className="button quiet" disabled={busy || manualRun.status === "complete"} onClick={() => mutate("/api/authentication", { runId: manualRun.id, status: manualRun.status === "auth_required" ? "confirmed" : "auth_required" }, "auth", "Manual sign-in report saved.")}>{manualRun.status === "auth_required" ? "I signed in to AWS" : "Report a sign-in issue"}</button></div>}
            </>}
            {manualRuns.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Local date</th><th scope="col">Manual status</th><th scope="col">Started</th></tr></thead><tbody>{manualRuns.slice(0, 10).map((item) => <tr key={item.id}><td>{item.local_date}</td><td><Status value={item.status} /></td><td>{formatDateTime(item.started_at)}</td></tr>)}</tbody></table></div> : <p className="empty-line">No manual reviews recorded.</p>}
          </details>
        </div><aside className="secondary-column">
          <section className="card settings-card" aria-labelledby="settings-title"><div className="card-heading"><div><span className="eyebrow">Controls</span><h2 id="settings-title">Schedule settings</h2></div></div><form onSubmit={saveSettings}>
            <label className="switch-row"><span><strong>Daily schedule</strong><span className="small muted">Pause or resume future daily runs</span></span><input type="checkbox" className="switch" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} /></label>
            <label className="switch-row"><span><strong>Automatic mode</strong><span className="small muted">Search, like, comment, and verify</span></span><input type="checkbox" className="switch" checked={autoMode} onChange={(event) => setAutoMode(event.target.checked)} disabled={busy || !automation} /></label>
            <div className="schedule-details"><div><span className="small muted">Scheduled time</span><strong>9:00 AM, daily</strong></div><div><span className="small muted">Timezone</span><strong>Asia/Manila</strong></div></div>
            <p className="small timing-note">Vercel Hobby schedules this between 9:00 and 10:00 AM. The cron runs at 01:00 UTC. Local development does not run the scheduler.</p>
            <div className="field attempts-field"><label htmlFor="max-attempts">Maximum attempts per day</label><input id="max-attempts" type="number" min={1} max={3} required value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} disabled={busy} /><p className="small muted">Automatic retries require an explicit request and stop once a like or comment attempt is recorded.</p></div>
            <label className="switch-row notification-switch"><span><strong>Notifications</strong><span className="small muted">Use your configured webhook</span></span><input type="checkbox" className="switch" checked={notifications} onChange={(event) => setNotifications(event.target.checked)} disabled={busy} /></label>
            <button type="submit" className="button secondary full-width" disabled={busy || !automation}>{pendingKey === "config" ? "Saving…" : "Save settings"}</button>
          </form></section>
          <section className="card queue-card" aria-labelledby="queue-title"><div className="card-heading"><div><span className="eyebrow">Optional candidates</span><h2 id="queue-title">Your post queue</h2></div><span className="count-badge">{availablePosts === 100 ? "100+" : availablePosts}</span></div>
            <p className="queue-description">The worker can discover posts from AWS. Add preferred candidates here; each still needs checks for prior likes and comments.</p>
            <form className="queue-form" onSubmit={addPost}><div className="field"><label htmlFor="post-title">Post title</label><input id="post-title" value={postTitle} onChange={(event) => setPostTitle(event.target.value)} placeholder="A post to consider" maxLength={200} required disabled={busy} /></div><div className="field"><label htmlFor="post-url">Builder Center content URL</label><input id="post-url" type="url" value={postUrl} onChange={(event) => setPostUrl(event.target.value)} placeholder="https://builder.aws.com/content/…" maxLength={1000} required disabled={busy} /><p className="small muted">Only builder.aws.com/content URLs are accepted.</p></div><button type="submit" className="button secondary full-width" disabled={busy}>{pendingKey === "post" ? "Adding…" : "Add to queue"} +</button></form>
            {data.posts.length ? <ul className="queue-list">{data.posts.map((post) => <li key={post.id}><div><a href={post.url} target="_blank" rel="noopener noreferrer">{post.title || "Builder Center post"}</a><span className="small muted">Added {formatDateTime(post.created_at)}</span></div><Status value={post.state} /></li>)}</ul> : <div className="queue-empty"><p>No posts queued.</p><span className="small muted">Automatic discovery does not require a queue.</span></div>}
          </section>
        </aside></div>
        <section className="card logs-card" aria-labelledby="logs-title"><div className="card-heading"><div><span className="eyebrow">Worker events</span><h2 id="logs-title">Execution log</h2></div><span className="small muted">Latest 15 entries</span></div>
          {automation?.logs.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Details</th></tr></thead><tbody>{automation.logs.slice(0, 15).map((log) => <tr key={log.id}><td className="log-time">{formatDateTime(log.created_at)}</td><td><code className="event-code">{log.event}</code></td><td className="log-message">{log.message}</td></tr>)}</tbody></table></div> : <p className="empty-line">Automatic execution events will appear here after a run.</p>}
        </section>
        <footer className="dashboard-footer"><span>Daily Activity · Private Builder Center automation</span><span>AWS action observations · Check rewards on AWS</span></footer>
      </main>
    </div>
  );
}
