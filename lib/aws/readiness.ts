import type { Page, Request } from "playwright-core";

/** These observed background requests do not load account or article activity. */
function isBackgroundRequest(request: Request): boolean {
  const url = new URL(request.url());
  if (url.origin === "https://dataplane.rum.us-east-1.amazonaws.com") return true;
  return url.origin === "https://api.builder.aws.com" && (
    (request.method() === "GET" && url.pathname === "/sms/space/feed") ||
    (request.method() === "POST" && ["/sms/members/spaces/status", "/bo/notifications"].includes(url.pathname))
  );
}

// Home hydration cancels these optional initial queries. Candidate activity is
// inspected only after navigation to its article; Latest feed loads remain strict.
function optionalHomeCancellation(request: Request): boolean {
  const url = new URL(request.url());
  if (url.origin !== "https://api.builder.aws.com") return false;
  return (request.method() === "GET" && ["/cs/role", "/cs/v2/feed/articles", "/cs/v2/feed/polls", "/cs/v2/users/me/articles/bookmarks"].includes(url.pathname)) ||
    (request.method() === "POST" && ["/ums/profiles/aliases", "/ums/batchDoesFollowUser", "/ums/doesFollowUser"].includes(url.pathname));
}

function cachedArticleCancellation(request: Request): boolean {
  const url = new URL(request.url());
  if (url.origin !== "https://api.builder.aws.com") return false;
  return (request.method() === "GET" && ["/cs/role", "/cs/v2/comments/public", "/cs/v2/users/me/articles/bookmarks"].includes(url.pathname)) ||
    (request.method() === "POST" && ["/ums/profile/get", "/cs/content/view", "/ums/profiles/aliases", "/ums/batchDoesFollowUser", "/ums/doesFollowUser"].includes(url.pathname));
}

/** Install before navigation so the SSR toolbar cannot be mistaken for hydrated activity. */
export function createAwsPageReadiness(page: Page) {
  const pending = new Set<Request>();
  const failures = new Set<string>();
  let changedAt = Date.now();
  let accountOnly = false;
  let awaitingNavigation = false;
  let articleTruthRead = false;
  const key = (request: Request) => `${request.method()} ${request.url()}`;
  const applicationRequest = (request: Request) => ["https://builder.aws.com", "https://api.builder.aws.com"].includes(new URL(request.url()).origin);
  page.on("framenavigated", frame => {
    if (!awaitingNavigation || frame !== page.mainFrame()) return;
    // Requests started by the previous document can be cancelled during goto.
    // Keep readiness scoped to the new document, including reloads of the same URL.
    pending.clear();
    failures.clear();
    changedAt = Date.now();
    awaitingNavigation = false;
  });
  page.on("request", request => {
    if (isBackgroundRequest(request)) return;
    pending.add(request);
    changedAt = Date.now();
  });
  page.on("requestfinished", async request => {
    if (!pending.has(request)) return;
    const response = await request.response().catch(() => null);
    if (!pending.delete(request)) return;
    if (applicationRequest(request)) {
      if (!response || response.status() >= 400) failures.add(key(request));
      else failures.delete(key(request));
    }
    changedAt = Date.now();
  });
  page.on("requestfailed", request => {
    if (!pending.delete(request)) return;
    // Token refresh can cancel a request, but a successful replacement must
    // finish before account/activity state is trusted.
    const aborted = request.failure()?.errorText === "net::ERR_ABORTED";
    const optionalCancellation = (accountOnly && optionalHomeCancellation(request)) || (articleTruthRead && cachedArticleCancellation(request));
    if (!(aborted && optionalCancellation) && (applicationRequest(request) || !aborted)) failures.add(key(request));
    changedAt = Date.now();
  });
  return {
    begin(options: { accountOnly?: boolean; navigation?: boolean; articleTruthRead?: boolean } = {}) {
      pending.clear();
      accountOnly = options.accountOnly === true;
      awaitingNavigation = options.navigation === true;
      // Only enable when the caller performs fresh authenticated article and
      // profile reads, and compares the server comment count with complete DOM coverage.
      articleTruthRead = options.articleTruthRead === true;
      changedAt = Date.now();
      failures.clear();
    },
    async wait(timeoutMs: number, deadline?: number) {
      const end = Math.min(Date.now() + timeoutMs, deadline ?? Infinity);
      await page.waitForLoadState("load", { timeout: Math.max(1, end - Date.now()) });
      while (Date.now() < end) {
        if (!pending.size && !failures.size && Date.now() - changedAt >= 500) return;
        await page.waitForTimeout(Math.min(50, Math.max(1, end - Date.now())));
      }
      throw new Error("AWS application requests did not settle.");
    }
  };
}
