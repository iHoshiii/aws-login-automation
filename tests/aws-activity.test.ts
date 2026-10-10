import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createOwnArticleActivity, OwnArticleActivityError } from "@/lib/aws/activity";

describe("fresh authenticated own article activity", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
  afterAll(async () => { await browser?.close(); });

  const articleUrl = "https://builder.aws.com/content/FixtureArticle1/fixture-title";
  const profileUrl = "https://builder.aws.com/community/@fixture-owner";
  const ownProfile = { profile: { basicInfo: { alias: "fixture-owner", userId: "fixture-user", builderProfileId: "fixture-profile" } } };
  const observedHeaders = {
    "builder-session-token": "fixture-observed-signer",
    "x-csrf-token": "fixture-observed-csrf",
    "builder-id": "fixture-user",
    "builder-profile-id": "fixture-profile",
    "x-fixture-private": "must-not-be-replayed"
  };

  async function setup(options: {
    profile?: unknown;
    profileStatus?: number;
    finalProfile?: unknown;
    finalProfileStatus?: number;
    article?: unknown;
    articleStatus?: number;
    observe?: boolean;
    observationOrigin?: string;
    observationHeaders?: Record<string, string>;
  } = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const reads: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
    await context.addCookies([{ name: "fixture-session", value: "fixture-cookie", domain: "api.builder.aws.com", path: "/", secure: true, sameSite: "None" }]);
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const cors = {
        "access-control-allow-origin": "https://builder.aws.com",
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "builder-session-token, x-csrf-token, builder-id, builder-profile-id, x-fixture-private, content-type"
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
      } else if (url.pathname === "/ums/profile/get") {
        const finalRead = reads.some(read => new URL(read.url).pathname === "/cs/v2/articles");
        reads.push({ method: request.method(), url: request.url(), headers: await request.allHeaders(), body: request.postData() });
        await route.fulfill({
          status: finalRead ? options.finalProfileStatus ?? options.profileStatus ?? 200 : options.profileStatus ?? 200,
          headers: cors, contentType: "application/json",
          body: JSON.stringify(finalRead ? options.finalProfile ?? options.profile ?? ownProfile : options.profile ?? ownProfile)
        });
      } else if (url.pathname === "/cs/v2/articles") {
        reads.push({ method: request.method(), url: request.url(), headers: await request.allHeaders(), body: request.postData() });
        await route.fulfill({ status: options.articleStatus ?? 200, headers: cors, contentType: "application/json", body: JSON.stringify(options.article ?? { articleId: "/content/FixtureArticle1", isLiked: false, commentsCount: 0 }) });
      } else if (url.pathname === "/ams/getEnabledFeatures") {
        await route.fulfill({ headers: cors, contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({ contentType: "text/html", body: '<main><button aria-label="Like this article, 0 likes" aria-pressed="false">Like</button></main>' });
      }
    });
    const activity = createOwnArticleActivity(page);
    activity.begin();
    await page.goto(articleUrl);
    if (options.observe !== false) {
      const origin = options.observationOrigin ?? "https://api.builder.aws.com";
      const finished = page.waitForEvent("requestfinished", { predicate: request => request.method() === "GET" && request.url() === `${origin}/ams/getEnabledFeatures` });
      await page.evaluate(async input => {
        const response = await fetch(`${input.origin}/ams/getEnabledFeatures`, { credentials: "include", headers: input.headers });
        await response.text();
      }, { origin, headers: options.observationHeaders ?? observedHeaders });
      await finished;
    }
    return { page, activity, reads };
  }

  it.each([false, true])("reads persisted isLiked=%s independently of the anonymous SSR toolbar", async isLiked => {
    const { page, activity, reads } = await setup({ article: { articleId: "/content/FixtureArticle1", isLiked, commentsCount: 0 } });
    expect(await page.locator("button").getAttribute("aria-pressed")).toBe("false");
    expect(await activity.read(articleUrl, profileUrl, 3000)).toBe(isLiked);
    expect(reads.map(read => read.method)).toEqual(["POST", "GET", "POST"]);
    expect(reads[0].body).toBe("{}");
    expect(new URL(reads[1].url).searchParams.get("articleId")).toBe("/content/FixtureArticle1");
    for (const read of reads) {
      expect(read.headers["builder-session-token"]).toBe("fixture-observed-signer");
      expect(read.headers["x-csrf-token"]).toBe("fixture-observed-csrf");
      expect(read.headers["x-fixture-private"]).toBeUndefined();
      expect(read.headers.cookie).toContain("fixture-session=fixture-cookie");
    }
  });

  it("returns the fresh server comment total along with the owner's persisted like", async () => {
    const { activity } = await setup({ article: { articleId: "/content/FixtureArticle1", isLiked: true, commentsCount: 12 } });
    expect(await activity.readState(articleUrl, profileUrl, 3000)).toEqual({ liked: true, commentsCount: 12 });
  });

  it("requires fresh own-profile alias evidence before reading article state", async () => {
    const { activity, reads } = await setup({ profile: { profile: { basicInfo: { ...ownProfile.profile.basicInfo, alias: "other-owner" } } } });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads.map(read => read.method)).toEqual(["POST"]);
  });

  it("rejects observed identifier headers that disagree with the fresh authenticated profile", async () => {
    const { activity, reads } = await setup({ observationHeaders: { ...observedHeaders, "builder-profile-id": "other-profile" } });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toHaveLength(1);
  });

  it("accepts cookie-authenticated profile evidence when the site omitted optional identity headers", async () => {
    const { activity } = await setup({ observationHeaders: { "builder-session-token": "fixture-observed-signer" } });
    expect(await activity.read(articleUrl, profileUrl, 3000)).toBe(false);
  });

  it.each([401, 403])("does not use an unauthorized profile read with status %s", async profileStatus => {
    const { activity, reads } = await setup({ profileStatus });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toHaveLength(1);
  });

  it.each([
    { articleId: "/content/DifferentArticle2", isLiked: false },
    { articleId: "/content/FixtureArticle1" },
    { articleId: "/content/FixtureArticle1", isLiked: "false" }
  ])("rejects unproven or wrong-article persisted activity: %j", async article => {
    const { activity } = await setup({ article });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "state_unknown" });
  });

  it.each([-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1, null])("rejects an invalid persisted comment count: %s", async commentsCount => {
    const { activity } = await setup({ article: { articleId: "/content/FixtureArticle1", isLiked: false, commentsCount } });
    await expect(activity.readState(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "state_unknown" });
  });

  it("reports loss of authentication during the article read", async () => {
    const { activity } = await setup({ articleStatus: 403 });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("rejects anonymous-shaped article success when the owner session expires during that read", async () => {
    const { activity, reads } = await setup({ finalProfileStatus: 403 });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads.map(read => read.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("rejects an account change during the article read even if the alias remains the same", async () => {
    const { activity } = await setup({ finalProfile: { profile: { basicInfo: { ...ownProfile.profile.basicInfo, userId: "other-user" } } } });
    await expect(activity.readState(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("fails closed without observed successful first-party API headers", async () => {
    const { activity, reads } = await setup({ observe: false });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toBeInstanceOf(OwnArticleActivityError);
    expect(reads).toEqual([]);
  });

  it("does not reuse signer headers observed on another origin", async () => {
    const { activity, reads } = await setup({ observationOrigin: "https://api.example.invalid" });
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toEqual([]);
  });

  it("clears previous-navigation header evidence on begin", async () => {
    const { activity, reads } = await setup();
    activity.begin();
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toEqual([]);
  });

  it("does not accept a previous navigation's API request that finishes after begin", async () => {
    const { page, activity, reads } = await setup({ observe: false });
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    await page.route("https://api.builder.aws.com/ams/getEnabledFeatures", async route => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: {
          "access-control-allow-origin": "https://builder.aws.com", "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET", "access-control-allow-headers": "builder-session-token"
        } });
        return;
      }
      signalStarted();
      await released;
      await route.fulfill({
        contentType: "application/json", body: "{}",
        headers: { "access-control-allow-origin": "https://builder.aws.com", "access-control-allow-credentials": "true" }
      });
    });
    const observing = page.evaluate(async headers => {
      const response = await fetch("https://api.builder.aws.com/ams/getEnabledFeatures", { credentials: "include", headers });
      await response.text();
    }, { "builder-session-token": "fixture-observed-signer" });
    await started;
    activity.begin();
    release();
    await observing;
    await page.waitForTimeout(25);
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toEqual([]);
  });

  it("does not fetch API activity from an unexpected document origin", async () => {
    const { page, activity, reads } = await setup();
    await page.goto("https://example.invalid/content/FixtureArticle1");
    await expect(activity.read(articleUrl, profileUrl, 3000)).rejects.toMatchObject({ code: "auth_required" });
    expect(reads).toEqual([]);
  });
});
