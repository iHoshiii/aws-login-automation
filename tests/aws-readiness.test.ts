import { EventEmitter } from "node:events";
import type { Page, Request } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsPageReadiness } from "@/lib/aws/readiness";

function fixture() {
  const events = new EventEmitter();
  const mainFrame = {};
  const page = Object.assign(events, {
    mainFrame: () => mainFrame,
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
  });
  const readiness = createAwsPageReadiness(page as unknown as Page);
  return { events, readiness, mainFrame };
}

function request(url: string, method = "GET", status = 200): Request {
  return {
    url: () => url,
    method: () => method,
    response: async () => ({ status: () => status }),
    failure: () => ({ errorText: "net::ERR_ABORTED" })
  } as unknown as Request;
}

function cancel(events: EventEmitter, value: Request) {
  events.emit("request", value);
  events.emit("requestfailed", value);
}

describe("AWS application request readiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const articleUrl = "https://api.builder.aws.com/cs/v2/articles?articleId=%2Fcontent%2Ffixture-article";

  it("recovers a cancelled activity request only after its successful replacement finishes and settles", async () => {
    const { events, readiness } = fixture();
    readiness.begin();
    cancel(events, request(articleUrl));
    const replacement = request(articleUrl);
    events.emit("request", replacement);

    let settled = false;
    const waiting = readiness.wait(2000).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(700);
    expect(settled).toBe(false);

    events.emit("requestfinished", replacement);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(51);
    await waiting;
    expect(settled).toBe(true);
  });

  it("rejects a cancelled activity request without a completed replacement", async () => {
    const { events, readiness } = fixture();
    readiness.begin();
    cancel(events, request(articleUrl));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("does not recover from a replacement that finishes with an HTTP error", async () => {
    const { events, readiness } = fixture();
    readiness.begin();
    cancel(events, request(articleUrl));
    const replacement = request(articleUrl, "GET", 503);
    events.emit("request", replacement);
    events.emit("requestfinished", replacement);
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("requires a replacement for the same request URL and method", async () => {
    const { events, readiness } = fixture();
    readiness.begin();
    cancel(events, request(articleUrl));
    for (const replacement of [request(`${articleUrl}-other`), request(articleUrl, "POST")]) {
      events.emit("request", replacement);
      events.emit("requestfinished", replacement);
    }
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it.each([
    ["GET", "/cs/role"],
    ["GET", "/cs/v2/feed/articles"],
    ["GET", "/cs/v2/feed/polls"],
    ["GET", "/cs/v2/users/me/articles/bookmarks"],
    ["POST", "/ums/profiles/aliases"],
    ["POST", "/ums/batchDoesFollowUser"],
    ["POST", "/ums/doesFollowUser"]
  ])("permits the observed %s %s cancellation during account-only home hydration", async (method, path) => {
    const { events, readiness } = fixture();
    readiness.begin({ accountOnly: true });
    cancel(events, request(`https://api.builder.aws.com${path}`, method));
    const waiting = readiness.wait(650);
    await vi.advanceTimersByTimeAsync(550);
    await waiting;
  });

  it.each([
    [articleUrl, "GET"],
    ["https://api.builder.aws.com/cs/v2/feed/articles", "POST"],
    ["https://builder.aws.com/cs/v2/feed/articles", "GET"]
  ])("rejects an unrecognized account-only cancellation: %s %s", async (url, method) => {
    const { events, readiness } = fixture();
    readiness.begin({ accountOnly: true });
    cancel(events, request(url, method));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("keeps the same feed cancellation strict when loading candidate activity", async () => {
    const { events, readiness } = fixture();
    readiness.begin();
    cancel(events, request("https://api.builder.aws.com/cs/v2/feed/articles"));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("ignores previous-document cancellation after a committed main-frame navigation", async () => {
    const { events, readiness, mainFrame } = fixture();
    readiness.begin({ navigation: true });
    const previousDocument = request(articleUrl);
    events.emit("request", previousDocument);
    events.emit("framenavigated", mainFrame);
    events.emit("requestfailed", previousDocument);
    const currentDocument = request(`${articleUrl}Current`);
    events.emit("request", currentDocument);
    events.emit("requestfinished", currentDocument);
    const waiting = readiness.wait(650);
    await vi.advanceTimersByTimeAsync(550);
    await waiting;
  });

  it("does not clear unresolved requests when only a child frame navigates", async () => {
    const { events, readiness } = fixture();
    readiness.begin({ navigation: true });
    events.emit("request", request(articleUrl));
    events.emit("framenavigated", {});
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("still rejects new-document activity cancellation after its navigation commits", async () => {
    const { events, readiness, mainFrame } = fixture();
    readiness.begin({ navigation: true });
    events.emit("framenavigated", mainFrame);
    cancel(events, request(articleUrl));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it.each([
    ["GET", "/cs/v2/comments/public?articleId=%2Fcontent%2FFixtureArticle1"],
    ["POST", "/ums/profile/get"]
  ])("allows an observed %s %s cache cancellation only when a fresh article truth read is required", async (method, path) => {
    const { events, readiness } = fixture();
    readiness.begin({ articleTruthRead: true });
    cancel(events, request(`https://api.builder.aws.com${path}`, method));
    const waiting = readiness.wait(650);
    await vi.advanceTimersByTimeAsync(550);
    await waiting;
  });

  it("keeps unknown article cancellation strict with article truth reads enabled", async () => {
    const { events, readiness } = fixture();
    readiness.begin({ articleTruthRead: true });
    cancel(events, request(articleUrl));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("does not ignore a hanging cached comment request when article truth reads are enabled", async () => {
    const { events, readiness } = fixture();
    readiness.begin({ articleTruthRead: true });
    events.emit("request", request("https://api.builder.aws.com/cs/v2/comments/public"));
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });

  it("does not ignore an HTTP error from a cached comment request with article truth reads enabled", async () => {
    const { events, readiness } = fixture();
    readiness.begin({ articleTruthRead: true });
    const failed = request("https://api.builder.aws.com/cs/v2/comments/public", "GET", 503);
    events.emit("request", failed);
    events.emit("requestfinished", failed);
    const rejected = expect(readiness.wait(650)).rejects.toThrow("AWS application requests did not settle.");
    await vi.advanceTimersByTimeAsync(650);
    await rejected;
  });
});
