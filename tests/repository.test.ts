import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DailyRun, PrepareRunResult } from "../lib/types";

// Execute the shipped migration and RPCs in real embedded PostgreSQL, not mocks.
// A single embedded connection verifies atomic state transitions/idempotency;
// production concurrency also depends on PostgreSQL's row locks.
describe("persistent daily workflow", () => {
  let db: PGlite;
  let localDate: string;
  let scheduledAt: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
    `);
    const migration = await readFile(new URL("../supabase/migrations/001_initial.sql", import.meta.url), "utf8");
    await db.exec(migration);
    const dates = await db.query<{ local_date: string }>("select ((now() at time zone 'Asia/Manila')::date)::text as local_date");
    localDate = dates.rows[0].local_date;
    scheduledAt = `${localDate}T01:00:00Z`;
  }, 30_000);

  beforeEach(async () => {
    await db.exec(`
      reset role;
      truncate public.notification_deliveries, public.execution_logs, public.post_activities,
        public.daily_runs, public.queued_posts;
      update public.app_config set enabled = true, max_attempts = 2, notifications_enabled = false;
      set role service_role;
    `);
  });

  afterAll(async () => { await db?.close(); });

  async function queue(slug = "example-post"): Promise<{ id: string; url: string }> {
    const result = await db.query<{ id: string; url: string }>(
      "insert into public.queued_posts (title, url) values ($1, $2) returning id, url",
      [slug, `https://builder.aws.com/content/${slug.replaceAll("-", "")}`],
    );
    return result.rows[0];
  }

  async function prepare(retry = false): Promise<PrepareRunResult> {
    const result = await db.query<{ result: PrepareRunResult }>(
      "select public.prepare_daily_run($1::date, $2::timestamptz, $3) as result",
      [localDate, scheduledAt, retry],
    );
    return result.rows[0].result;
  }

  async function report(runId: string, type: string, status: string, message = "Manual test outcome"): Promise<void> {
    await db.query("select public.report_activity($1::uuid, $2, $3, $4)", [runId, type, status, message]);
  }

  async function run(runId: string): Promise<DailyRun> {
    return (await db.query<DailyRun>("select * from public.daily_runs where id = $1::uuid", [runId])).rows[0];
  }

  async function claim(runId: string, kind = "review"): Promise<DailyRun | null> {
    return (await db.query<{ result: DailyRun | null }>(
      "select public.claim_notification($1::uuid, $2) as result", [runId, kind],
    )).rows[0].result;
  }

  it("one daily record and one post reservation survive duplicate invocations", async () => {
    const candidate = await queue();
    await queue("second-post");
    const results = await Promise.all([prepare(), prepare(), prepare()]);
    expect(results.map((value) => value.outcome)).toEqual(["created", "existing", "existing"]);
    expect(new Set(results.map((value) => value.run?.id)).size).toBe(1);
    expect(results[0].run?.post_id).toBe(candidate.id);
    expect(results[0].run?.attempt_count).toBe(1);
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.post_activities")).rows[0].count).toBe(3);
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.queued_posts where state = 'reserved'")).rows[0].count).toBe(1);
  });

  it("no-post retry is explicit and never exceeds the configured daily budget", async () => {
    expect((await prepare()).run?.status).toBe("no_post");
    expect((await prepare()).run?.attempt_count).toBe(1);
    expect((await prepare(true)).run?.attempt_count).toBe(2);
    const denied = await prepare(true);
    expect(denied.outcome).toBe("retry_limit");
    expect(denied.run?.attempt_count).toBe(2);
  });

  it("an explicit retry can reserve a newly queued post without losing the visit report", async () => {
    const first = (await prepare()).run!;
    await report(first.id, "visit", "user_reported");
    const candidate = await queue();
    expect((await prepare()).run?.post_id).toBeNull();
    const retried = await prepare(true);
    expect(retried.run?.post_id).toBe(candidate.id);
    const visit = (await db.query<{ status: string }>("select status from public.post_activities where run_id = $1 and activity_type = 'visit'", [first.id])).rows[0];
    expect(visit.status).toBe("user_reported");
  });

  it("paused automation writes no daily run", async () => {
    await db.exec("update public.app_config set enabled = false");
    expect(await prepare()).toEqual({ outcome: "disabled", run: null });
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.daily_runs")).rows[0].count).toBe(0);
  });

  it("completed reports are idempotent and cannot be downgraded or replayed", async () => {
    await queue();
    const daily = (await prepare()).run!;
    await report(daily.id, "like", "user_reported");
    const before = (await db.query<{ count: number }>("select count(*)::int as count from public.execution_logs")).rows[0].count;
    await report(daily.id, "like", "user_reported");
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.execution_logs")).rows[0].count).toBe(before);
    await expect(report(daily.id, "like", "failed")).rejects.toThrow(/replayed|downgraded/);
    await expect(db.query("select public.replace_post($1)", [daily.id])).rejects.toThrow(/replacement is blocked/);
  });

  it("uncertain engagement blocks any replay and replacement", async () => {
    await queue();
    await queue("next-post");
    const daily = (await prepare()).run!;
    await report(daily.id, "comment", "uncertain");
    await expect(report(daily.id, "comment", "user_reported")).rejects.toThrow(/uncertain/);
    await expect(db.query("select public.replace_post($1)", [daily.id])).rejects.toThrow(/replacement is blocked/);
    expect((await prepare(true)).outcome).toBe("existing");
  });

  it("replacement consumes the old post and preserves previous attempts in the audit log", async () => {
    const firstPost = await queue("first-post");
    const nextPost = await queue("second-post");
    const daily = (await prepare()).run!;
    await report(daily.id, "visit", "user_reported");
    await report(daily.id, "like", "failed", "No action occurred; manual check failed.");
    await db.query("select public.replace_post($1)", [daily.id]);
    expect((await run(daily.id)).post_id).toBe(nextPost.id);
    expect((await db.query<{ state: string }>("select state from public.queued_posts where id = $1", [firstPost.id])).rows[0].state).toBe("used");
    const snapshots = await db.query<{ message: string }>("select message from public.execution_logs where event = 'replaced_activity_snapshot'");
    expect(snapshots.rows.some((row) => row.message.includes('"status": "failed"'))).toBe(true);
    const activities = await db.query<{ activity_type: string; status: string }>("select activity_type, status from public.post_activities where run_id = $1", [daily.id]);
    expect(activities.rows.find((row) => row.activity_type === "visit")?.status).toBe("user_reported");
    expect(activities.rows.find((row) => row.activity_type === "like")?.status).toBe("pending");
  });

  it("failed replacement leaves the current candidate reserved", async () => {
    const post = await queue();
    const daily = (await prepare()).run!;
    await expect(db.query("select public.replace_post($1)", [daily.id])).rejects.toThrow(/No unused replacement/);
    expect((await run(daily.id)).post_id).toBe(post.id);
    expect((await db.query<{ state: string }>("select state from public.queued_posts where id = $1", [post.id])).rows[0].state).toBe("reserved");
  });

  it("completion is self-reported only when all three activities are reported", async () => {
    await queue();
    const daily = (await prepare()).run!;
    await report(daily.id, "visit", "user_reported");
    await report(daily.id, "like", "user_reported");
    expect((await run(daily.id)).status).toBe("pending_review");
    await report(daily.id, "comment", "user_reported");
    expect((await run(daily.id)).status).toBe("complete");
    expect((await run(daily.id)).completed_at).not.toBeNull();
  });

  it("database uniqueness rejects repeated URLs and a second successful engagement on a URL", async () => {
    const post = await queue();
    await expect(queue()).rejects.toThrow(/unique/);
    const daily = (await prepare()).run!;
    await report(daily.id, "like", "user_reported");
    const old = (await db.query<{ id: string }>(`
      insert into public.daily_runs (local_date, scheduled_at, status)
      select d, (d::text || 'T01:00:00Z')::timestamptz, 'pending_review'
      from (select ((now() at time zone 'Asia/Manila')::date - 1) as d) t returning id
    `)).rows[0];
    await expect(db.query(
      "insert into public.post_activities (run_id, post_url, activity_type, status) values ($1, $2, 'like', 'user_reported')",
      [old.id, post.url],
    )).rejects.toThrow(/unique/);
  });

  it("new reports and claims cannot be attached to yesterday's run", async () => {
    await queue();
    const daily = (await prepare()).run!;
    await db.query(`
      update public.daily_runs set local_date = local_date - 1,
        scheduled_at = scheduled_at - interval '1 day' where id = $1
    `, [daily.id]);
    await expect(report(daily.id, "visit", "user_reported")).rejects.toThrow(/Historic/);
    await expect(db.query("select public.report_authentication($1, 'confirmed')", [daily.id])).rejects.toThrow(/Historic/);
    expect(await claim(daily.id)).toBeNull();
  });

  it("authentication issues are recorded without reading an AWS session", async () => {
    await queue();
    const daily = (await prepare()).run!;
    await db.query("select public.report_authentication($1, 'auth_required')", [daily.id]);
    expect((await run(daily.id)).status).toBe("auth_required");
    await db.query("select public.report_authentication($1, 'confirmed')", [daily.id]);
    expect((await run(daily.id)).status).toBe("pending_review");
  });

  it("activity reports and candidate replacement preserve an unresolved authentication issue", async () => {
    await queue("first-post");
    await queue("next-post");
    const daily = (await prepare()).run!;
    await db.query("select public.report_authentication($1, 'auth_required')", [daily.id]);
    const problem = (await run(daily.id)).error_message;
    await report(daily.id, "visit", "user_reported");
    expect((await run(daily.id)).status).toBe("auth_required");
    expect((await run(daily.id)).error_message).toBe(problem);
    await db.query("select public.replace_post($1)", [daily.id]);
    expect((await run(daily.id)).status).toBe("auth_required");
    expect((await run(daily.id)).error_message).toBe(problem);
    await db.query("select public.report_authentication($1, 'confirmed')", [daily.id]);
    expect((await run(daily.id)).status).toBe("pending_review");
  });

  it("an already-liked candidate can be replaced while keeping the previous report in the audit log", async () => {
    const oldPost = await queue("old-post");
    const newPost = await queue("new-post");
    const daily = (await prepare()).run!;
    await report(daily.id, "like", "already_done");
    await db.query("select public.replace_post($1)", [daily.id]);
    expect((await run(daily.id)).post_id).toBe(newPost.id);
    expect((await db.query<{ state: string }>("select state from public.queued_posts where id = $1", [oldPost.id])).rows[0].state).toBe("used");
    const audit = await db.query<{ message: string }>("select message from public.execution_logs where event = 'replaced_activity_snapshot'");
    expect(audit.rows.some((row) => row.message.includes('"status": "already_done"'))).toBe(true);
  });

  it("notification claims are durable and independent per event, with no uncertain resend", async () => {
    await db.exec("update public.app_config set notifications_enabled = true");
    await queue();
    const daily = (await prepare()).run!;
    expect((await claim(daily.id))?.notification_status).toBe("sending");
    expect(await claim(daily.id)).toBeNull();
    await db.query("select public.finish_notification($1, 'uncertain', 'Connection closed after send', 'review')", [daily.id]);
    expect(await claim(daily.id)).toBeNull();
    expect((await run(daily.id)).notification_status).toBe("uncertain");
    expect(await claim(daily.id, "auth_required")).not.toBeNull();
    await db.query("select public.finish_notification($1, 'failed', 'Endpoint refused the alert', 'auth_required')", [daily.id]);
    expect(await claim(daily.id, "auth_required")).toBeNull();
    expect((await run(daily.id)).notification_status).toBe("uncertain");
    expect(await claim(daily.id, "activity_failed")).not.toBeNull();
  });

  it("notifications stay off until explicitly enabled", async () => {
    const daily = (await prepare()).run!;
    expect(daily.notification_status).toBe("disabled");
    expect(await claim(daily.id)).toBeNull();
    await db.exec("update public.app_config set notifications_enabled = true");
    expect((await claim(daily.id))?.notification_status).toBe("sending");
  });

  it("anonymous and signed-in browser roles have no read or function access", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`);
      await expect(db.query("select * from public.app_config")).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.prepare_daily_run($1::date, $2::timestamptz, false)", [localDate, scheduledAt])).rejects.toThrow(/permission denied/);
    }
    await db.exec("reset role; set role service_role");
    expect((await prepare()).outcome).toBe("created");
  });

  it("invalid schedule and historical preparation are rejected", async () => {
    await expect(db.query("select public.prepare_daily_run($1::date, $2::timestamptz, false)", [localDate, `${localDate}T09:00:00Z`])).rejects.toThrow(/configured schedule/);
    await expect(db.query("select public.prepare_daily_run('2000-01-01', '2000-01-01T01:00:00Z', false)")).rejects.toThrow(/configured schedule/);
  });
});
