import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "@/lib/types";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(), assign: vi.fn(), begin: vi.fn(), ready: vi.fn(), finishAction: vi.fn(), finishRun: vi.fn(), log: vi.fn(), notify: vi.fn(),
  beforeSubmit: undefined as undefined | (() => Promise<void>),
  session: vi.fn(), launch: vi.fn(), close: vi.fn(), auth: vi.fn(), discover: vi.fn(), inspect: vi.fn(), like: vi.fn(), comment: vi.fn()
}));
vi.mock("@/lib/automation-repository", () => ({ claimAutomationRun: mocks.claim, assertAutomationActionReady: mocks.ready, assignAutomationPost: mocks.assign, beginAutomationAction: mocks.begin, finishAutomationAction: mocks.finishAction, finishAutomationRun: mocks.finishRun, appendAutomationLog: mocks.log }));
vi.mock("@/lib/automation-notifications", () => ({ notifyAutomation: mocks.notify }));
vi.mock("@/lib/aws/session", () => ({ loadSessionFromEnvironment: mocks.session }));
vi.mock("@/lib/aws/browser", () => ({ launchAwsBrowser: mocks.launch }));
vi.mock("@/lib/aws/site", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/aws/site")>();
  return { ...actual, createAwsSiteDriver: (_page: unknown, _profile: unknown, options: { beforeSubmit?: () => Promise<void> }) => {
    mocks.beforeSubmit = options.beforeSubmit;
    return { checkAuthentication: mocks.auth, discoverCandidates: mocks.discover, inspectCandidate: mocks.inspect, likeAndVerify: mocks.like, commentAndVerify: mocks.comment };
  } };
});
import { executeAutomaticRun } from "@/lib/automatic-workflow";
import { AwsSiteError } from "@/lib/aws/site";

const run = { id: "11111111-1111-4111-8111-111111111111", local_date: "2026-10-09", scheduled_at: "2026-10-09T01:00:00Z", started_at: "2026-10-09T01:00:00Z", finished_at: null, status: "running", post_url: null, post_title: null, account_profile_url: "https://builder.aws.com/community/@test", error_message: null, attempts: 1, lease_until: "2026-10-09T01:04:00Z" };
const candidate = { url: "https://builder.aws.com/content/Post123/test-post", title: "Test post" };
const data: DashboardData = { config: { id: 1, enabled: true, auto_mode: true, max_attempts: 2, notifications_enabled: false }, posts: [], runs: [], activities: [], logs: [] };
const input = { localDate: "2026-10-09", scheduledAt: "2026-10-09T01:00:00Z", retry: false, data };

describe("automatic worker with durable action claims", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:00:00Z"));
    vi.stubEnv("AWS_COMMENT_TEXT", "nice");
    mocks.claim.mockResolvedValue({ outcome: "claimed", run, token: "22222222-2222-4222-8222-222222222222" });
    mocks.session.mockReturnValue({ profile: { accountProfileUrl: run.account_profile_url } });
    mocks.launch.mockResolvedValue({ browser: { close: mocks.close }, context: { newPage: vi.fn().mockResolvedValue({}) } });
    mocks.assign.mockResolvedValue(true);
    mocks.begin.mockResolvedValue(true);
    mocks.ready.mockResolvedValue(true);
    mocks.auth.mockResolvedValue(true);
    mocks.discover.mockResolvedValue([candidate]);
    mocks.inspect.mockResolvedValue({ liked: false, commented: false, commentsComplete: true, excerpt: "Post" });
    mocks.like.mockImplementation(async () => { await mocks.beforeSubmit?.(); return "verified"; });
    mocks.comment.mockImplementation(async () => { await mocks.beforeSubmit?.(); return "verified"; });
    mocks.finishAction.mockResolvedValue(undefined);
    mocks.finishRun.mockResolvedValue(undefined);
    mocks.notify.mockResolvedValue(undefined);
    mocks.log.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("commits each external claim before submission and verifies all three outcomes", async () => {
    const result = await executeAutomaticRun(input);
    expect(result.run?.status).toBe("verified");
    const beginLike = mocks.begin.mock.invocationCallOrder[1];
    const beginComment = mocks.begin.mock.invocationCallOrder[2];
    expect(beginLike).toBeLessThan(mocks.like.mock.invocationCallOrder[0]);
    expect(beginComment).toBeLessThan(mocks.comment.mock.invocationCallOrder[0]);
    expect(mocks.comment).toHaveBeenCalledWith(candidate, "nice");
    expect(mocks.ready.mock.calls.map(call => call[2])).toEqual(["like", "comment"]);
    expect(mocks.finishAction.mock.calls.map(call => [call[2], call[3]])).toEqual([["visit", "verified"], ["like", "verified"], ["comment", "verified"]]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("does nothing on a duplicate daily claim", async () => {
    mocks.claim.mockResolvedValue({ outcome: "existing", run, token: null });
    expect((await executeAutomaticRun(input)).outcome).toBe("existing");
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.like).not.toHaveBeenCalled();
  });
  it("persists a missing session as auth_required without opening a browser", async () => {
    mocks.session.mockImplementation(() => { throw new Error("missing secret"); });
    expect((await executeAutomaticRun(input)).run?.status).toBe("auth_required");
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ accountProfileUrl: null }));
  });
  it("stops on expired authentication before engagement", async () => {
    mocks.auth.mockRejectedValue(new AwsSiteError("auth_required", "expired"));
    expect((await executeAutomaticRun(input)).run?.status).toBe("auth_required");
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.like).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });
  it.each([
    { liked: true, commented: false, commentsComplete: true },
    { liked: false, commented: true, commentsComplete: true },
    { liked: false, commented: false, commentsComplete: false }
  ])("skips a candidate that is ineligible or incompletely inspected: %j", async observed => {
    mocks.inspect.mockResolvedValue(observed);
    expect((await executeAutomaticRun(input)).run?.status).toBe("no_post");
    expect(mocks.like).not.toHaveBeenCalled();
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it("does not repeat a comment with an uncertain outcome", async () => {
    mocks.comment.mockRejectedValue(new AwsSiteError("action_uncertain", "response lost"));
    expect((await executeAutomaticRun(input)).run?.status).toBe("uncertain");
    expect(mocks.comment).toHaveBeenCalledTimes(1);
    expect(mocks.finishAction).toHaveBeenLastCalledWith(run.id, expect.any(String), "comment", "uncertain", expect.any(String));
  });
  it("preserves uncertainty when saving a successful like loses its database response", async () => {
    mocks.finishAction.mockImplementation(async (_id, _token, type, phase) => {
      if (type === "like" && phase === "verified") throw new Error("network");
    });
    expect((await executeAutomaticRun(input)).run?.status).toBe("uncertain");
    expect(mocks.like).toHaveBeenCalledTimes(1);
    expect(mocks.comment).not.toHaveBeenCalled();
  });
  it("stops on changed recorded controls", async () => {
    mocks.auth.mockRejectedValue(new AwsSiteError("selector_unverified", "changed"));
    expect((await executeAutomaticRun(input)).run?.status).toBe("failed");
    expect(mocks.like).not.toHaveBeenCalled();
  });
  it("does not click when the database denies a paused action", async () => {
    mocks.begin.mockImplementation(async (_id, _token, type) => type === "visit");
    expect((await executeAutomaticRun(input)).run?.status).toBe("failed");
    expect(mocks.like).not.toHaveBeenCalled();
  });
  it("records a race without duplicating an already-existing action", async () => {
    mocks.like.mockResolvedValue("already_done");
    expect((await executeAutomaticRun(input)).run?.status).toBe("failed");
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.finishAction).toHaveBeenLastCalledWith(run.id, expect.any(String), "like", "skipped", expect.any(String));
  });
  it("stops when a pause or lease change is observed immediately before submission", async () => {
    mocks.ready.mockResolvedValue(false);
    expect((await executeAutomaticRun(input)).run?.status).toBe("uncertain");
    expect(mocks.ready).toHaveBeenCalledWith(run.id, expect.any(String), "like");
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.finishAction).not.toHaveBeenCalledWith(run.id, expect.any(String), "like", "verified", expect.any(String));
  });
  it("checks the execution budget again after browser preparation and before submission", async () => {
    mocks.like.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-09T01:02:01Z"));
      await mocks.beforeSubmit?.();
      return "verified";
    });
    expect((await executeAutomaticRun(input)).run?.status).toBe("uncertain");
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.comment).not.toHaveBeenCalled();
  });
});
