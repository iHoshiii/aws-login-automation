import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeLocalDaily, localDailyDate, readLocalDailyRun, seedLocalDailyRun, type ExecuteLocalDailyOptions, type LocalDailyRun } from "@/lib/aws/local-daily";
import { AwsSiteError, type AwsCandidate, type AwsSiteDriver } from "@/lib/aws/site";
import type { AwsStreakSummary } from "@/lib/aws/streaks";

const candidate = { url: "https://builder.aws.com/content/FixtureArticle", title: "Secure workloads with IAM roles" };
const profile = "https://builder.aws.com/community/@fixture-owner";
const comment = "IAM roles avoid embedding long-lived credentials in the workload.";
const started = new Date("2026-10-10T01:05:00Z");
const activity: AwsStreakSummary = {
  observedAt: started.toISOString(), visit: { current: 7, total: 30 }, like: { current: 7, total: 30 },
  comment: { current: 7, total: 30 }, visit90: { current: 7, total: 90 },
  like90: { current: 13, total: 90 }, comment90: { current: 21, total: 90 }
};
const directories: string[] = [];

afterEach(async () => {
  const expectedRoot = resolve(tmpdir());
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(`${expectedRoot}\\aws-local-daily-`) && !resolve(directory).startsWith(`${expectedRoot}/aws-local-daily-`)) {
      throw new Error("Unexpected temporary test directory.");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(overrides: Partial<ExecuteLocalDailyOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aws-local-daily-"));
  directories.push(directory);
  const actions: string[] = [];
  let guard: () => Promise<void> = async () => { throw new Error("Guard was not installed."); };
  const driver: AwsSiteDriver = {
    checkAuthentication: vi.fn(async () => true as const),
    discoverCandidates: vi.fn(async () => [candidate]),
    inspectCandidate: vi.fn(async () => ({ liked: false, commented: false, commentsComplete: true, excerpt: "IAM roles grant temporary credentials to workloads." })),
    likeAndVerify: vi.fn(async () => {
      const persisted = await readLocalDailyRun(directory, "2026-10-10");
      expect(persisted?.actions.like).toBe("started");
      expect(persisted?.comment).toBe(comment);
      await guard();
      actions.push("like");
      return "verified" as const;
    }),
    commentAndVerify: vi.fn(async () => {
      const persisted = await readLocalDailyRun(directory, "2026-10-10");
      expect(persisted?.actions).toEqual({ like: "verified", comment: "started" });
      await guard();
      actions.push("comment");
      return "verified" as const;
    })
  };
  const options: ExecuteLocalDailyOptions = {
    directory, now: () => started, sessionProfileUrl: profile,
    createDriver: vi.fn(async beforeSubmit => { guard = beforeSubmit; return driver; }),
    composeComment: vi.fn(() => comment), verifyActivity: vi.fn(async () => activity), ...overrides
  };
  return { directory, actions, driver, options, getGuard: () => guard };
}

describe("durable local daily execution", () => {
  it("journals both action claims before submitting and saves separate observed streaks", async () => {
    const setup = await fixture();
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.status).toBe("verified");
    expect(setup.actions).toEqual(["like", "comment"]);
    expect(result.run?.activity).toEqual(activity);
    expect(setup.driver.discoverCandidates).toHaveBeenCalledWith(24);
    expect(await readLocalDailyRun(setup.directory, "2026-10-10")).toEqual(result.run);
  });

  it("keeps duplicate and concurrent date claims from launching a second browser", async () => {
    const setup = await fixture();
    const results = await Promise.all([executeLocalDaily(setup.options), executeLocalDaily(setup.options)]);
    expect(results.map(result => result.outcome).sort()).toEqual(["executed", "existing"]);
    expect(setup.options.createDriver).toHaveBeenCalledTimes(1);
    expect(setup.actions).toEqual(["like", "comment"]);
    expect((await executeLocalDaily(setup.options)).outcome).toBe("existing");
    expect(setup.options.createDriver).toHaveBeenCalledTimes(1);
  });

  it("protects a seeded already completed live run from any engagement", async () => {
    const setup = await fixture();
    const seed: LocalDailyRun = {
      version: 1, date: "2026-10-10", status: "verified", startedAt: started.toISOString(),
      accountProfileUrl: profile, post: candidate, comment, actions: { like: "verified", comment: "verified" }, activity
    };
    await seedLocalDailyRun(setup.directory, seed);
    const result = await executeLocalDaily(setup.options);
    expect(result).toEqual({ outcome: "existing", run: seed });
    expect(setup.options.createDriver).not.toHaveBeenCalled();
    expect(setup.actions).toEqual([]);
  });

  it("leaves an older four-observation journal unchanged and never repeats its engagement", async () => {
    const setup = await fixture();
    const legacy: LocalDailyRun = {
      version: 1, date: "2026-10-10", status: "verified", startedAt: started.toISOString(),
      accountProfileUrl: profile, post: candidate, comment, actions: { like: "verified", comment: "verified" },
      activity: {
        observedAt: activity.observedAt, visit: activity.visit, like: activity.like,
        comment: activity.comment, visit90: activity.visit90
      }
    };
    await seedLocalDailyRun(setup.directory, legacy);
    const before = await readFile(join(setup.directory, "2026-10-10.json"), "utf8");
    const result = await executeLocalDaily(setup.options);
    expect(result).toEqual({ outcome: "existing", run: legacy });
    expect(result.run?.activity).not.toHaveProperty("like90");
    expect(result.run?.activity).not.toHaveProperty("comment90");
    expect(await readFile(join(setup.directory, "2026-10-10.json"), "utf8")).toBe(before);
    expect(setup.options.createDriver).not.toHaveBeenCalled();
    expect(setup.options.verifyActivity).not.toHaveBeenCalled();
    expect(setup.actions).toEqual([]);
  });

  it("keeps missing or invalid new 90-day observations unknown after verified engagement", async () => {
    const missing = await fixture({ verifyActivity: async () => ({ ...activity, like90: undefined }) as unknown as AwsStreakSummary });
    const missingResult = await executeLocalDaily(missing.options);
    expect(missingResult.run?.status).toBe("verified");
    expect(missingResult.run?.activity).toBeUndefined();
    expect(missingResult.run?.activityError).toContain("could not be observed");
    const invalid = await fixture({ verifyActivity: async () => ({ ...activity, comment90: { current: 91, total: 90 } }) });
    const invalidResult = await executeLocalDaily(invalid.options);
    expect(invalidResult.run?.status).toBe("verified");
    expect(invalidResult.run?.activity).toBeUndefined();
    expect(invalidResult.run?.activityError).toContain("could not be observed");
  });

  it("records expired authentication without claiming engagement", async () => {
    const setup = await fixture();
    vi.mocked(setup.driver.checkAuthentication).mockRejectedValue(new AwsSiteError("auth_required", "secret browser detail"));
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.status).toBe("auth_required");
    expect(result.run?.actions).toEqual({ like: "not_started", comment: "not_started" });
    expect(JSON.stringify(result)).not.toContain("secret browser detail");
    expect(setup.actions).toEqual([]);
  });

  it("skips existing engagement, incomplete history, and irrelevant content before selecting a post", async () => {
    const setup = await fixture();
    const candidates: AwsCandidate[] = ["Liked", "Commented", "Incomplete", "Irrelevant", "Eligible"].map(title => ({ title, url: `https://builder.aws.com/content/${title}` }));
    vi.mocked(setup.driver.discoverCandidates).mockResolvedValue(candidates);
    vi.mocked(setup.driver.inspectCandidate).mockImplementation(async value => ({
      liked: value.title === "Liked", commented: value.title === "Commented", commentsComplete: value.title !== "Incomplete", excerpt: value.title
    }));
    setup.options.composeComment = vi.fn(value => {
      if (value.title === "Irrelevant") throw new AwsSiteError("state_unknown", "No relevant technical content.");
      return comment;
    });
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.post?.title).toBe("Eligible");
    expect(setup.options.composeComment).toHaveBeenCalledTimes(2);
    expect(setup.actions).toEqual(["like", "comment"]);
  });

  it("blocks all engagement when comment composition is invalid", async () => {
    const setup = await fixture({ composeComment: () => "" });
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.status).toBe("failed");
    expect(setup.actions).toEqual([]);
    expect(setup.driver.likeAndVerify).not.toHaveBeenCalled();
  });

  it("records no post and keeps the same date protected", async () => {
    const setup = await fixture();
    vi.mocked(setup.driver.inspectCandidate).mockResolvedValue({ liked: true, commented: false, commentsComplete: true, excerpt: "" });
    expect((await executeLocalDaily(setup.options)).run?.status).toBe("no_post");
    expect((await executeLocalDaily(setup.options)).outcome).toBe("existing");
    expect(setup.driver.likeAndVerify).not.toHaveBeenCalled();
  });

  it("keeps a lost action result uncertain and never replays it", async () => {
    const setup = await fixture();
    vi.mocked(setup.driver.likeAndVerify).mockImplementation(async () => {
      await setup.getGuard()();
      setup.actions.push("like");
      throw new Error("Response lost after AWS accepted the request.");
    });
    const first = await executeLocalDaily(setup.options);
    expect(first.run?.status).toBe("uncertain");
    expect(first.run?.actions).toEqual({ like: "started", comment: "not_started" });
    expect((await executeLocalDaily(setup.options)).outcome).toBe("existing");
    expect(setup.actions).toEqual(["like"]);
    expect(setup.driver.commentAndVerify).not.toHaveBeenCalled();
  });

  it("excludes a prior date's uncertain article even when fresh reads would call it eligible", async () => {
    const setup = await fixture();
    await seedLocalDailyRun(setup.directory, {
      version: 1, date: "2026-10-09", status: "uncertain", startedAt: "2026-10-09T01:05:00Z",
      post: candidate, actions: { like: "started", comment: "not_started" }
    });
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.status).toBe("no_post");
    expect(setup.driver.inspectCandidate).not.toHaveBeenCalled();
    expect(setup.actions).toEqual([]);
  });

  it("checks the durable action claim again at the final submission boundary", async () => {
    const setup = await fixture();
    vi.mocked(setup.driver.likeAndVerify).mockImplementation(async () => {
      const persisted = await readLocalDailyRun(setup.directory, "2026-10-10");
      await writeFile(join(setup.directory, "2026-10-10.json"), JSON.stringify({ ...persisted, status: "failed" }));
      await setup.getGuard()();
      setup.actions.push("like");
      return "verified";
    });
    expect((await executeLocalDaily(setup.options)).run?.status).toBe("uncertain");
    expect(setup.actions).toEqual([]);
  });

  it("blocks a submission that crosses the Singapore date boundary", async () => {
    let clock = new Date("2026-10-10T15:59:30Z");
    const setup = await fixture({ now: () => clock, deadline: clock.getTime() + 5 * 60_000 });
    vi.mocked(setup.driver.likeAndVerify).mockImplementation(async () => {
      clock = new Date("2026-10-10T16:00:00Z");
      await setup.getGuard()();
      setup.actions.push("like");
      return "verified";
    });
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.date).toBe("2026-10-10");
    expect(result.run?.status).toBe("uncertain");
    expect(setup.actions).toEqual([]);
    expect(localDailyDate(clock)).toBe("2026-10-11");
  });

  it("blocks execution before 09:00 and engagement after its deadline", async () => {
    const early = await fixture({ now: () => new Date("2026-10-10T00:59:59Z") });
    expect(await executeLocalDaily(early.options)).toEqual({ outcome: "too_early", run: null });
    expect(early.options.createDriver).not.toHaveBeenCalled();
    const expired = await fixture({ deadline: started.getTime() });
    expect((await executeLocalDaily(expired.options)).run?.status).toBe("failed");
    expect(expired.options.createDriver).not.toHaveBeenCalled();
  });

  it("preserves verified engagement when the profile activity read fails", async () => {
    const setup = await fixture({ verifyActivity: async () => { throw new Error("Private HTTP failure details."); } });
    const result = await executeLocalDaily(setup.options);
    expect(result.run?.status).toBe("verified");
    expect(result.run?.activity).toBeUndefined();
    expect(result.run?.activityError).toContain("could not be observed");
    expect(JSON.stringify(result)).not.toContain("Private HTTP failure details");
  });

  it("never reopens a claimed date whose journal is unreadable", async () => {
    const setup = await fixture();
    await writeFile(join(setup.directory, "2026-10-10.claim"), "interrupted claim");
    await writeFile(join(setup.directory, "2026-10-10.json"), "partial invalid JSON");
    expect(await executeLocalDaily(setup.options)).toEqual({ outcome: "existing", run: null });
    expect(setup.options.createDriver).not.toHaveBeenCalled();
    expect(await readFile(join(setup.directory, "2026-10-10.claim"), "utf8")).toBe("interrupted claim");
  });
});
