import type { Page, Request } from "playwright-core";

const ORIGIN = "https://builder.aws.com";
const API_ORIGIN = "https://api.builder.aws.com";
const OBSERVED_HEADERS = ["builder-session-token", "x-csrf-token", "builder-id", "builder-profile-id"];

export class OwnArticleActivityError extends Error {
  constructor(public readonly code: "auth_required" | "state_unknown") {
    super(code === "auth_required"
      ? "The current AWS account could not be verified for the article activity read."
      : "The current account's persisted article like state could not be verified.");
    this.name = "OwnArticleActivityError";
  }
}

export interface OwnArticleActivityState {
  liked: boolean;
  commentsCount: number;
}

function contentId(raw: string): string | null {
  try {
    const url = new URL(raw);
    const match = /^\/content\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
    return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && match
      ? `/content/${match[1]}` : null;
  } catch { return null; }
}

function accountAlias(raw: string): string | null {
  try {
    const url = new URL(raw);
    const match = /^\/community\/@([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname);
    return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && match
      ? match[1] : null;
  } catch { return null; }
}

/** Observe the site's own API headers; never read credential storage or invent a signer. */
export function createOwnArticleActivity(page: Page) {
  let generation = 0;
  let headers: Record<string, string> | undefined;
  const collecting = new Set<Promise<void>>();
  const requestGenerations = new WeakMap<Request, number>();

  async function collect(request: Request, startedGeneration: number) {
    try {
      const url = new URL(request.url());
      if (url.origin !== API_ORIGIN || url.username || url.password) return;
      const response = await request.response();
      if (!response || response.status() < 200 || response.status() >= 300) return;
      const observed = request.headers();
      const selected: Record<string, string> = {};
      for (const name of OBSERVED_HEADERS) {
        const value = observed[name];
        if (value !== undefined) {
          if (!value || value.length > 16384 || /[\r\n]/.test(value)) return;
          selected[name] = value;
        }
      }
      if (!selected["builder-session-token"] || startedGeneration !== generation) return;
      headers = selected;
    } catch { /* A failed observation cannot establish authenticated activity. */ }
  }

  page.on("request", request => { requestGenerations.set(request, generation); });
  page.on("requestfinished", request => {
    const startedGeneration = requestGenerations.get(request);
    if (startedGeneration === undefined || startedGeneration !== generation) return;
    const task = collect(request, startedGeneration);
    collecting.add(task);
    void task.finally(() => collecting.delete(task));
  });

  return {
    begin() {
      generation++;
      headers = undefined;
      collecting.clear();
    },
    async read(articleUrl: string, expectedAccountProfileUrl: string, timeoutMs: number): Promise<boolean> {
      return (await this.readState(articleUrl, expectedAccountProfileUrl, timeoutMs)).liked;
    },
    async readState(articleUrl: string, expectedAccountProfileUrl: string, timeoutMs: number): Promise<OwnArticleActivityState> {
      const articleId = contentId(articleUrl);
      const expectedAlias = accountAlias(expectedAccountProfileUrl);
      if (!articleId || !expectedAlias || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        throw new OwnArticleActivityError("state_unknown");
      }
      const readGeneration = generation;
      const deadline = Date.now() + timeoutMs;
      while (collecting.size && Date.now() < deadline) {
        await page.waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      const observedHeaders = headers;
      let currentUrl: URL;
      try { currentUrl = new URL(page.url()); } catch { throw new OwnArticleActivityError("auth_required"); }
      if (!observedHeaders || currentUrl.origin !== ORIGIN || currentUrl.username || currentUrl.password || generation !== readGeneration) {
        throw new OwnArticleActivityError("auth_required");
      }
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new OwnArticleActivityError("state_unknown");
      let result: { code: "auth_required" | "state_unknown" } | OwnArticleActivityState;
      try {
        result = await page.evaluate(async input => {
          if (location.origin !== input.origin) return { code: "auth_required" as const };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), input.timeoutMs);
          let verifiedAccount = false;
          try {
            const profileResponse = await fetch(`${input.apiOrigin}/ums/profile/get`, {
              method: "POST", credentials: "include", cache: "no-store", redirect: "error",
              headers: { ...input.headers, "content-type": "application/json" },
              body: "{}", signal: controller.signal
            });
            if (profileResponse.status !== 200) return { code: "auth_required" as const };
            const profileText = await profileResponse.text();
            if (profileText.length > 262144) return { code: "auth_required" as const };
            const profile = JSON.parse(profileText)?.profile?.basicInfo;
            if (!profile || profile.alias !== input.expectedAlias ||
              typeof profile.userId !== "string" || !profile.userId || profile.userId.length > 1024 ||
              typeof profile.builderProfileId !== "string" || !profile.builderProfileId || profile.builderProfileId.length > 1024 ||
              (input.headers["builder-id"] !== undefined && input.headers["builder-id"] !== profile.userId) ||
              (input.headers["builder-profile-id"] !== undefined && input.headers["builder-profile-id"] !== profile.builderProfileId)) {
              return { code: "auth_required" as const };
            }
            verifiedAccount = true;
            const endpoint = new URL(`${input.apiOrigin}/cs/v2/articles`);
            endpoint.searchParams.set("articleId", input.articleId);
            const response = await fetch(endpoint, {
              method: "GET", credentials: "include", cache: "no-store", redirect: "error",
              headers: input.headers, signal: controller.signal
            });
            if (response.status === 401 || response.status === 403) return { code: "auth_required" as const };
            if (response.status !== 200) return { code: "state_unknown" as const };
            const text = await response.text();
            if (text.length > 1048576) return { code: "state_unknown" as const };
            const article = JSON.parse(text);
            if (article?.articleId !== input.articleId || typeof article?.isLiked !== "boolean" ||
              !Number.isSafeInteger(article?.commentsCount) || article.commentsCount < 0) {
              return { code: "state_unknown" as const };
            }
            // The public article endpoint also returns anonymous isLiked=false.
            // Confirm that the same owner session survived the article read.
            const finalProfileResponse = await fetch(`${input.apiOrigin}/ums/profile/get`, {
              method: "POST", credentials: "include", cache: "no-store", redirect: "error",
              headers: { ...input.headers, "content-type": "application/json" },
              body: "{}", signal: controller.signal
            });
            if (finalProfileResponse.status !== 200) return { code: "auth_required" as const };
            const finalProfileText = await finalProfileResponse.text();
            if (finalProfileText.length > 262144) return { code: "auth_required" as const };
            const finalProfile = JSON.parse(finalProfileText)?.profile?.basicInfo;
            if (!finalProfile || finalProfile.alias !== input.expectedAlias ||
              finalProfile.userId !== profile.userId || finalProfile.builderProfileId !== profile.builderProfileId) {
              return { code: "auth_required" as const };
            }
            return { liked: article.isLiked as boolean, commentsCount: article.commentsCount as number };
          } catch {
            return { code: verifiedAccount ? "state_unknown" as const : "auth_required" as const };
          } finally { clearTimeout(timer); }
        }, { origin: ORIGIN, apiOrigin: API_ORIGIN, articleId, expectedAlias, headers: observedHeaders, timeoutMs: remaining });
      } catch { throw new OwnArticleActivityError("state_unknown"); }
      if (generation !== readGeneration || Date.now() > deadline) throw new OwnArticleActivityError("state_unknown");
      if ("code" in result) throw new OwnArticleActivityError(result.code);
      return result;
    }
  };
}
