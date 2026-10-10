import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutomationRun, ClaimAutomationRunResult } from "../lib/automation-types";
import { redactAutomationMessage } from "../lib/automation-repository";

const URL_A = "https://builder.aws.com/content/automaticpost1";
const URL_B = "https://builder.aws.com/content/automaticpost2";
const PROFILE = "https://builder.aws.com/community/@owner";
const OTHER_TOKEN = "11111111-1111-4111-8111-111111111111";

// Exercise the shipped PostgreSQL functions and constraints, not mocked writes.
describe("automatic execution persistence", () => {
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
    for (const filename of ["001_initial.sql", "002_automation.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${filename}`, import.meta.url), "utf8"));
    }
    localDate = (await db.query<{ date: string }>("select ((now() at time zone 'Asia/Manila')::date)::text as date")).rows[0].date;
    scheduledAt = `${localDate}T01:00:00Z`;
  }, 30_000);

  beforeEach(async () => {
    await db.exec(`
      reset role;
      truncate public.automation_notification_deliveries, public.automation_logs,
        public.automation_actions, public.automation_runs, public.notification_deliveries,
        public.execution_logs, public.post_activities, public.daily_runs, public.queued_posts;
      update public.app_config set enabled = true, auto_mode = true,
        max_attempts = 2, notifications_enabled = false;
      set role service_role;
    `);
  });

  afterAll(async () => { await db?.close(); });

  async function claim(retry = false, profile: string | null = PROFILE): Promise<ClaimAutomationRunResult> {
    return (await db.query<{ result: ClaimAutomationRunResult }>(
      "select public.claim_automation_run($1::date, $2::timestamptz, $3, $4) as result",
      [localDate, scheduledAt, retry, profile],
    )).rows[0].result;
  }

  async function assign(value: ClaimAutomationRunResult, url = URL_A): Promise<boolean> {
    return (await db.query<{ result: boolean }>(
      "select public.assign_automation_post($1::uuid, $2::uuid, $3, 'A post title') as result",
      [value.run!.id, value.token, url],
    )).rows[0].result;
  }

  async function begin(value: ClaimAutomationRunResult, type: string): Promise<boolean> {
    return (await db.query<{ result: boolean }>(
      "select public.begin_automation_action($1::uuid, $2::uuid, $3) as result",
      [value.run!.id, value.token, type],
    )).rows[0].result;
  }

  async function finishAction(value: ClaimAutomationRunResult, type: string, phase = "verified"): Promise<void> {
    await db.query("select public.finish_automation_action($1::uuid, $2::uuid, $3, $4, 'Observed test outcome')",
      [value.run!.id, value.token, type, phase]);
  }

  async function ready(value: ClaimAutomationRunResult, type: string): Promise<boolean> {
    return (await db.query<{ result: boolean }>(
      "select public.assert_automation_action_ready($1::uuid, $2::uuid, $3) as result",
      [value.run!.id, value.token, type],
    )).rows[0].result;
  }

  async function finishRun(value: ClaimAutomationRunResult, status: string): Promise<void> {
    await db.query("select public.finish_automation_run($1::uuid, $2::uuid, $3, 'Test completion')",
      [value.run!.id, value.token, status]);
  }

  async function getRun(value: ClaimAutomationRunResult): Promise<AutomationRun> {
    return (await db.query<AutomationRun>("select * from public.automation_runs where id = $1::uuid", [value.run!.id])).rows[0];
  }

  async function expire(value: ClaimAutomationRunResult): Promise<void> {
    await db.query("update public.automation_runs set lease_until = now() - interval '1 second' where id = $1", [value.run!.id]);
  }

  async function visit(value: ClaimAutomationRunResult): Promise<void> {
    expect(await assign(value)).toBe(true);
    expect(await begin(value, "visit")).toBe(true);
    await finishAction(value, "visit");
  }

  async function notification(value: ClaimAutomationRunResult, kind = "result"): Promise<AutomationRun | null> {
    return (await db.query<{ result: AutomationRun | null }>(
      "select public.claim_automation_notification($1::uuid, $2) as result", [value.run!.id, kind],
    )).rows[0].result;
  }

  it("duplicate requests share one running record and only the winner receives a lease token", async () => {
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.map((result) => result.outcome)).toEqual(["claimed", "existing", "existing"]);
    expect(new Set(results.map((result) => result.run!.id)).size).toBe(1);
    expect(results[0].token).toMatch(/^[0-9a-f-]{36}$/);
    expect(results[1].token).toBeNull();
    expect(results[0].run).not.toHaveProperty("lease_token");
    expect(new Date(results[0].run!.lease_until).getTime() - new Date(results[0].run!.started_at).getTime()).toBe(240_000);
  });

  it("pause and manual mode each prevent new claims without creating records", async () => {
    await db.exec("update public.app_config set enabled = false");
    expect(await claim()).toEqual({ outcome: "disabled", run: null, token: null });
    await db.exec("update public.app_config set enabled = true, auto_mode = false");
    expect((await claim()).outcome).toBe("disabled");
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.automation_runs")).rows[0].count).toBe(0);
  });

  it("an expired lease without action claims can be explicitly reclaimed only within the daily limit", async () => {
    const first = await claim();
    await expire(first);
    const second = await claim(true);
    expect(second.outcome).toBe("claimed");
    expect(second.run!.attempts).toBe(2);
    expect(second.token).not.toBe(first.token);
    await expire(second);
    const exhausted = await claim();
    expect(exhausted.outcome).toBe("retry_limit");
    expect(exhausted.run!.status).toBe("failed");
    expect(exhausted.run!.finished_at).not.toBeNull();
    expect(exhausted.run!.error_message).toContain("retry limit is exhausted");
    expect((await getRun(second)).status).toBe("failed");
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.automation_actions")).rows[0].count).toBe(0);
    expect((await claim()).run!.status).toBe("failed");
  });

  it("ordinary scheduler duplicates never renew a safe expired worker or increment attempts", async () => {
    const first = await claim();
    await expire(first);
    for (let invocation = 0; invocation < 3; invocation++) {
      const duplicate = await claim();
      expect(duplicate.outcome).toBe("existing");
      expect(duplicate.token).toBeNull();
      expect(duplicate.run!.status).toBe("running");
      expect(duplicate.run!.attempts).toBe(1);
      expect(new Date(duplicate.run!.lease_until).getTime()).toBe(new Date((await getRun(first)).lease_until).getTime());
    }
    const requested = await claim(true);
    expect(requested.outcome).toBe("claimed");
    expect(requested.run!.attempts).toBe(2);
    expect(requested.token).not.toBe(first.token);
  });

  it("a worker crash after a durable activity claim becomes uncertain without replay", async () => {
    const first = await claim();
    await assign(first);
    expect(await begin(first, "visit")).toBe(true);
    await expire(first);
    const later = await claim(true);
    expect(later.outcome).toBe("existing");
    expect(later.run!.status).toBe("uncertain");
    expect(later.token).toBeNull();
    expect((await db.query<{ phase: string }>("select phase from public.automation_actions where run_id = $1", [first.run!.id])).rows[0].phase).toBe("uncertain");
    expect(await begin(first, "visit")).toBe(false);
  });

  it("a verified engagement remains locked when its worker subsequently expires", async () => {
    const first = await claim();
    await visit(first);
    await begin(first, "like");
    await finishAction(first, "like");
    await expire(first);
    expect((await claim(true)).run!.status).toBe("uncertain");
    expect((await getRun(first)).attempts).toBe(1);
  });

  it("no-post and authentication retries require an explicit request and share the configured budget", async () => {
    const first = await claim();
    await finishRun(first, "no_post");
    expect((await claim()).outcome).toBe("existing");
    const second = await claim(true);
    expect(second.outcome).toBe("claimed");
    await finishRun(second, "auth_required");
    expect((await claim()).outcome).toBe("existing");
    expect((await claim(true)).outcome).toBe("retry_limit");
  });

  it("a failed preparation with only a verified visit can be retried on the same candidate", async () => {
    const first = await claim();
    await visit(first);
    await finishRun(first, "auth_required");
    const second = await claim(true);
    expect(second.outcome).toBe("claimed");
    expect(await assign(second)).toBe(true);
    expect(await assign(second, URL_B)).toBe(false);
    expect(await begin(second, "visit")).toBe(false);
    expect(await begin(second, "like")).toBe(true);
  });

  it("an authentication retry can assign its first owner and retry a known failed visit", async () => {
    const first = await claim(false, null);
    await assign(first);
    await begin(first, "visit");
    await finishAction(first, "visit", "failed");
    await finishRun(first, "auth_required");
    const second = await claim(true, PROFILE);
    expect(second.outcome).toBe("claimed");
    expect(second.run!.account_profile_url).toBe(PROFILE);
    expect(await assign(second, URL_B)).toBe(true);
    expect(await begin(second, "visit")).toBe(true);
    expect((await db.query<{ message: string }>("select message from public.automation_logs where event = 'retry_visit_snapshot'")).rows[0].message).toContain('"phase": "failed"');
  });

  it("every engagement claim blocks run retry even when its final result was failed", async () => {
    const first = await claim();
    await visit(first);
    await begin(first, "like");
    await finishAction(first, "like", "failed");
    await finishRun(first, "failed");
    expect((await claim(true)).outcome).toBe("existing");
    expect(await begin(first, "like")).toBe(false);
  });

  it("reclaimed workers reject all stale token writes", async () => {
    const first = await claim();
    await expire(first);
    const second = await claim(true);
    expect(await assign(first)).toBe(false);
    expect(await begin(first, "visit")).toBe(false);
    await expect(finishRun(first, "failed")).rejects.toThrow(/lease is stale/);
    await expect(db.query("select public.append_automation_log($1::uuid, $2::uuid, 'late', 'Stale worker')", [first.run!.id, first.token])).rejects.toThrow(/lease is stale/);
    expect(await assign(second)).toBe(true);
  });

  it("the worker cannot start any new external action after pause or lease expiry", async () => {
    const first = await claim();
    await visit(first);
    await db.exec("update public.app_config set enabled = false");
    expect(await begin(first, "like")).toBe(false);
    await db.exec("update public.app_config set enabled = true, auto_mode = false");
    expect(await begin(first, "like")).toBe(false);
    await db.exec("update public.app_config set auto_mode = true");
    await expire(first);
    expect(await begin(first, "like")).toBe(false);
  });

  it("the final submission check requires the exact live, started action and respects a later pause", async () => {
    const first = await claim();
    expect(await ready(first, "like")).toBe(false);
    await visit(first);
    expect(await ready(first, "visit")).toBe(false);
    expect(await begin(first, "like")).toBe(true);
    expect(await ready(first, "like")).toBe(true);
    expect(await ready(first, "comment")).toBe(false);
    await db.exec("update public.app_config set enabled = false");
    expect(await ready(first, "like")).toBe(false);
    await db.exec("update public.app_config set enabled = true, auto_mode = false");
    expect(await ready(first, "like")).toBe(false);
    await db.exec("update public.app_config set auto_mode = true");
    await finishAction(first, "like");
    expect(await ready(first, "like")).toBe(false);
  });

  it("the final submission check rejects expired and replaced leases without changing activity state", async () => {
    const first = await claim();
    await visit(first);
    await begin(first, "like");
    expect(await ready({ ...first, token: OTHER_TOKEN }, "like")).toBe(false);
    await expire(first);
    expect(await ready(first, "like")).toBe(false);
    expect((await db.query<{ phase: string }>("select phase from public.automation_actions where run_id = $1 and activity_type = 'like'", [first.run!.id])).rows[0].phase).toBe("started");
    await claim();
    expect(await ready(first, "like")).toBe(false);
  });

  it("activity claims are single-use, ordered, and never replace an assigned candidate", async () => {
    const first = await claim();
    expect(await begin(first, "visit")).toBe(false);
    await assign(first);
    expect(await begin(first, "like")).toBe(false);
    expect(await begin(first, "comment")).toBe(false);
    expect(await begin(first, "visit")).toBe(true);
    expect(await begin(first, "visit")).toBe(false);
    expect(await begin(first, "like")).toBe(false);
    await finishAction(first, "visit");
    expect(await assign(first, URL_B)).toBe(false);
    expect(await begin(first, "comment")).toBe(false);
    expect(await begin(first, "like")).toBe(true);
    await finishAction(first, "like");
    expect(await begin(first, "like")).toBe(false);
    expect(await begin(first, "comment")).toBe(true);
  });

  it("settled activity results cannot be downgraded or silently replayed", async () => {
    const first = await claim();
    await visit(first);
    await finishAction(first, "visit");
    await expect(finishAction(first, "visit", "failed")).rejects.toThrow(/settled activity/);
    await expect(db.query("select public.finish_automation_action($1::uuid, $2::uuid, 'visit', 'verified', '')", [first.run!.id, OTHER_TOKEN])).rejects.toThrow(/lease is stale/);
  });

  it("a verified run requires all three independently verified activities", async () => {
    const first = await claim();
    await expect(finishRun(first, "verified")).rejects.toThrow(/three activities/);
    await visit(first);
    await begin(first, "like");
    await finishAction(first, "like");
    await expect(finishRun(first, "verified")).rejects.toThrow(/three activities/);
    await begin(first, "comment");
    await finishAction(first, "comment");
    await finishRun(first, "verified");
    expect((await getRun(first)).status).toBe("verified");
    expect((await getRun(first)).finished_at).not.toBeNull();
    expect((await claim(true)).outcome).toBe("existing");
    await expect(finishRun(first, "failed")).rejects.toThrow(/lease is stale/);
  });

  it("started or uncertain actions cannot be described as a known failed run", async () => {
    const first = await claim();
    await assign(first);
    await begin(first, "visit");
    await expect(finishRun(first, "failed")).rejects.toThrow(/unresolved activity/);
    await finishRun(first, "uncertain");
    expect((await db.query<{ phase: string }>("select phase from public.automation_actions where run_id = $1", [first.run!.id])).rows[0].phase).toBe("uncertain");
  });

  it("an expired current worker may only close its outstanding action and run as uncertain", async () => {
    const first = await claim();
    await assign(first);
    await begin(first, "visit");
    await expire(first);
    await expect(finishAction(first, "visit")).rejects.toThrow(/lease is stale/);
    await finishAction(first, "visit", "uncertain");
    await finishRun(first, "uncertain");
    expect((await getRun(first)).status).toBe("uncertain");
  });

  it("assigned candidates cannot be reported as no-post", async () => {
    const first = await claim();
    await assign(first);
    await expect(finishRun(first, "no_post")).rejects.toThrow(/assigned post/);
  });

  it("manual reserved and consumed candidates are excluded from automatic selection", async () => {
    const first = await claim();
    await db.query("insert into public.queued_posts (title, url, state) values ('Reserved', $1, 'reserved'), ('Used', $2, 'used')", [URL_A, URL_B]);
    expect(await assign(first, URL_A)).toBe(false);
    expect(await assign(first, URL_B)).toBe(false);
  });

  it("prior reported manual engagement is excluded even if the queue record is available", async () => {
    const first = await claim();
    const manual = (await db.query<{ id: string }>(
      "insert into public.daily_runs (local_date, scheduled_at, status) values ($1::date, $2::timestamptz, 'pending_review') returning id",
      [localDate, scheduledAt],
    )).rows[0];
    await db.query("insert into public.post_activities (run_id, post_url, activity_type, status) values ($1, $2, 'like', 'already_done')", [manual.id, URL_A]);
    expect(await assign(first)).toBe(false);
  });

  it("an automatic engagement claim consumes an available manual candidate while permitting its own comment", async () => {
    const first = await claim();
    await db.query("insert into public.queued_posts (title, url) values ('Available', $1)", [URL_A]);
    await visit(first);
    expect(await begin(first, "like")).toBe(true);
    expect((await db.query<{ state: string }>("select state from public.queued_posts where url = $1", [URL_A])).rows[0].state).toBe("used");
    await finishAction(first, "like");
    expect(await begin(first, "comment")).toBe(true);
    const manual = (await db.query<{ result: { run: { post_url: string | null } } }>(
      "select public.prepare_daily_run($1::date, $2::timestamptz, false) as result", [localDate, scheduledAt],
    )).rows[0].result;
    expect(manual.run.post_url).toBeNull();
  });

  it("historical successful and uncertain automatic engagements block candidate reuse", async () => {
    const old = (await db.query<{ id: string }>(`
      insert into public.automation_runs (local_date, scheduled_at, status, post_url, account_profile_url)
      select d, (d::text || 'T01:00:00Z')::timestamptz, 'verified', $1, $2
      from (select ((now() at time zone 'Asia/Manila')::date - 1) as d) t returning id
    `, [URL_A, PROFILE])).rows[0];
    await db.query("insert into public.automation_actions (run_id, post_url, activity_type, phase, verified_at) values ($1, $2, 'like', 'verified', now())", [old.id, URL_A]);
    const current = await claim();
    expect(await assign(current)).toBe(false);
    await db.query("update public.automation_runs set post_url = $1, status = 'uncertain' where id = $2", [URL_B, old.id]);
    expect(await assign(current, URL_B)).toBe(false);
  });

  it("the database forbids a second successful like on the same URL", async () => {
    const first = await claim();
    await visit(first);
    await begin(first, "like");
    await finishAction(first, "like");
    const other = (await db.query<{ id: string }>(`
      insert into public.automation_runs (local_date, scheduled_at)
      select d, (d::text || 'T01:00:00Z')::timestamptz
      from (select ((now() at time zone 'Asia/Manila')::date - 1) as d) t returning id
    `)).rows[0];
    await expect(db.query("insert into public.automation_actions (run_id, post_url, activity_type, phase, verified_at) values ($1, $2, 'like', 'verified', now())", [other.id, URL_A])).rejects.toThrow(/unique/);
  });

  it("a retry cannot silently switch the authenticated owner", async () => {
    const first = await claim();
    await finishRun(first, "auth_required");
    await expect(claim(true, "https://builder.aws.com/community/@different")).rejects.toThrow(/same account/);
  });

  it("historical claims, invalid schedule, unsupported actions, and malformed URLs are rejected", async () => {
    await expect(db.query("select public.claim_automation_run('2000-01-01', '2000-01-01T01:00:00Z', false, null)")).rejects.toThrow(/configured schedule/);
    await expect(db.query("select public.claim_automation_run($1::date, $2::timestamptz, false, null)", [localDate, `${localDate}T09:00:00Z`])).rejects.toThrow(/configured schedule/);
    const first = await claim();
    await expect(begin(first, "vote")).rejects.toThrow(/Invalid automatic activity/);
    await expect(assign(first, "https://example.com/content/post")).rejects.toThrow(/Invalid automatic post/);
  });

  it("notifications are opt-in, claimed once, and never resent after uncertain delivery", async () => {
    const first = await claim();
    expect(await notification(first)).toBeNull();
    await db.exec("update public.app_config set notifications_enabled = true");
    expect(await notification(first)).toBeNull();
    await finishRun(first, "auth_required");
    expect(await notification(first, "auth_required")).not.toHaveProperty("lease_token");
    expect(await notification(first, "auth_required")).toBeNull();
    await db.query("select public.finish_automation_notification($1::uuid, 'auth_required', 'uncertain', 'Connection closed after send')", [first.run!.id]);
    expect(await notification(first, "auth_required")).toBeNull();
    expect(await notification(first, "failure")).not.toBeNull();
    await db.query("select public.finish_automation_notification($1::uuid, 'failure', 'sent', '')", [first.run!.id]);
    await expect(db.query("select public.finish_automation_notification($1::uuid, 'failure', 'failed', '')", [first.run!.id])).rejects.toThrow(/already settled/);
  });

  it("anonymous and signed-in browser roles cannot read data or call worker functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`);
      for (const table of ["automation_runs", "automation_actions", "automation_logs", "automation_notification_deliveries"]) {
        await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(db.query("select public.claim_automation_run($1::date, $2::timestamptz, false, null)", [localDate, scheduledAt])).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.begin_automation_action($1::uuid, $2::uuid, 'visit')", [OTHER_TOKEN, OTHER_TOKEN])).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.assert_automation_action_ready($1::uuid, $2::uuid, 'like')", [OTHER_TOKEN, OTHER_TOKEN])).rejects.toThrow(/permission denied/);
    }
  });
});

describe("automatic diagnostic privacy", () => {
  it("redacts headers, JWTs, Supabase keys and serialized cookie values", () => {
    expect(redactAutomationMessage('Authorization: Bearer top-secret; Cookie: session=secret')).not.toContain("top-secret");
    expect(redactAutomationMessage('Cookie: session=top-secret; csrf=another-secret')).not.toContain("another-secret");
    expect(redactAutomationMessage('{"name":"session","value":"very secret cookie"}')).not.toContain("very secret cookie");
    expect(redactAutomationMessage("password='secret password' token=secret sb_secret_anyvalue eyJabc.def.ghi")).not.toContain("secret password");
    expect(redactAutomationMessage("sb_secret_anyvalue eyJabc.def.ghi")).toBe("[redacted] [redacted]");
    expect(redactAutomationMessage("x".repeat(400))).toHaveLength(300);
  });
});
