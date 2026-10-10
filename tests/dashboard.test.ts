import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardData } from "@/lib/types";
import type { AutomationAction, AutomationHistory, AutomationRun } from "@/lib/automation-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { Dashboard } from "@/components/dashboard";

const data: DashboardData = {
  config: { id: 1, enabled: true, max_attempts: 2, notifications_enabled: false, auto_mode: true },
  posts: [], runs: [], activities: [], logs: [],
};
const emptyHistory: AutomationHistory = { runs: [], actions: [], logs: [] };
const run: AutomationRun = {
  id: "9a7c601b-7a90-44c9-9566-0b68f20e28b5", local_date: "2026-10-09",
  scheduled_at: "2026-10-09T01:00:00Z", started_at: "2026-10-09T01:01:00Z",
  finished_at: "2026-10-09T01:02:00Z", status: "failed", attempts: 1,
  post_url: "https://builder.aws.com/content/test-post", post_title: "Test post",
  account_profile_url: "https://builder.aws.com/community/@owner", error_message: "Browser setup failed.",
  lease_until: "2026-10-09T01:04:00Z",
};
function render(options: { automation?: AutomationHistory | null; sessionConfigured?: boolean; checkedAt?: string } = {}) {
  return renderToStaticMarkup(createElement(Dashboard, {
    data, automation: options.automation === undefined ? emptyHistory : options.automation,
    sessionConfigured: options.sessionConfigured ?? true, today: "2026-10-09",
    checkedAt: options.checkedAt ?? "2026-10-09T01:05:00Z", nextScheduledAt: "2026-10-10T01:00:00Z",
  }));
}

describe("automatic dashboard operator controls", () => {
  it("requires the automatic migration and an AWS session before offering execution", () => {
    const missingDatabase = render({ automation: null });
    expect(missingDatabase).toContain("Automatic run storage needs setup.");
    expect(missingDatabase).toContain("002_automation.sql");
    expect(missingDatabase).toMatch(/<button[^>]*disabled=""[^>]*>Run now/);
    const missingSession = render({ sessionConfigured: false });
    expect(missingSession).toContain("Connect your AWS account before running.");
    expect(missingSession).toMatch(/<button[^>]*disabled=""[^>]*>Run now/);
  });

  it("offers execution after 9 AM and keeps earlier requests disabled", () => {
    expect(render({ checkedAt: "2026-10-09T00:59:00Z" })).toMatch(/<button[^>]*disabled=""[^>]*>Run now/);
    expect(render()).toMatch(/<button class="button primary">Run now/);
  });

  it("allows retry only before any engagement claim", () => {
    expect(render({ automation: { ...emptyHistory, runs: [run] } })).toContain("Retry before engagement");
    const action: AutomationAction = {
      id: "action-id", run_id: run.id, activity_type: "like", phase: "failed",
      attempted_at: run.started_at, verified_at: null, post_url: run.post_url!, message: "Attempt could not be verified.",
    };
    expect(render({ automation: { ...emptyHistory, runs: [run], actions: [action] } })).not.toContain("Retry before engagement");
  });

  it("offers explicit recovery of an expired worker only before unresolved activity", () => {
    const expired = { ...run, status: "running" as const, finished_at: null };
    const safe = render({ automation: { ...emptyHistory, runs: [expired] } });
    expect(safe).toContain("Execution expired");
    expect(safe).toContain("Retry before engagement");
    const active = { ...expired, lease_until: "2026-10-09T01:10:00Z" };
    expect(render({ automation: { ...emptyHistory, runs: [active] } })).not.toContain("Retry before engagement");
    const unresolved: AutomationAction = {
      id: "visit-id", run_id: run.id, activity_type: "visit", phase: "started",
      attempted_at: run.started_at, verified_at: null, post_url: run.post_url!, message: null,
    };
    expect(render({ automation: { ...emptyHistory, runs: [expired], actions: [unresolved] } })).not.toContain("Retry before engagement");
  });

  it("keeps uncertain runs frozen and labels verified results as observations", () => {
    const uncertain = render({ automation: { ...emptyHistory, runs: [{ ...run, status: "uncertain" }] } });
    expect(uncertain).toContain("This run cannot replay engagement automatically.");
    expect(uncertain).not.toContain("Retry before engagement");
    const verified = render({ automation: { ...emptyHistory, runs: [{ ...run, status: "verified", error_message: null }] } });
    expect(verified).toContain("Verified means the worker observed the action result on AWS.");
    expect(verified).toContain("Check badges and streaks in your AWS profile.");
    expect(verified).not.toContain("<select");
  });
});
