import type { BrowserContext, Locator, Page } from "playwright-core";
import { createOwnArticleActivity, OwnArticleActivityError } from "./activity";

const ORIGIN = "https://builder.aws.com";

export interface AwsStreakProgress<Total extends 30 | 90 = 30 | 90> {
  current: number;
  total: Total;
}

export interface AwsStreakSummary {
  observedAt: string;
  visit: AwsStreakProgress<30>;
  like: AwsStreakProgress<30>;
  comment: AwsStreakProgress<30>;
  visit90: AwsStreakProgress<90>;
}

export class AwsStreakReadError extends Error {
  constructor(public readonly code: "auth_required" | "state_unknown" | "selector_unverified") {
    super(code === "auth_required"
      ? "The signed-in AWS account could not be verified before reading streaks. Reconnect your account."
      : "AWS streak progress could not be confirmed from the observed badge dialogs.");
    this.name = "AwsStreakReadError";
  }
}

function ownProfileDocument(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === ORIGIN && url.pathname.replace(/\/$/, "") === "/profile" &&
      (url.search === "" || url.search === "?tab=badges") && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function selfEditLink(raw: string): boolean {
  try {
    const url = new URL(raw, ORIGIN);
    return url.origin === ORIGIN && url.pathname.replace(/\/$/, "") === "/edit/profile" &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/** Read four owner-only badge dialogs; no engagement or profile edits are submitted. */
export async function readAwsStreaks(context: BrowserContext, expectedAccountProfileUrl: string,
  options: { timeoutMs?: number; deadline?: number } = {}): Promise<AwsStreakSummary> {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
    (options.deadline !== undefined && !Number.isFinite(options.deadline))) {
    throw new AwsStreakReadError("state_unknown");
  }
  const deadline = Math.min(Date.now() + timeoutMs, options.deadline ?? Infinity);
  const remaining = () => {
    const left = deadline - Date.now();
    if (left < 1) throw new AwsStreakReadError("state_unknown");
    return left;
  };
  let page: Page | undefined;
  try {
    remaining();
    page = await context.newPage();
    const ownerPage = page;
    const activity = createOwnArticleActivity(ownerPage);
    activity.begin();
    await ownerPage.goto(`${ORIGIN}/profile`, { waitUntil: "domcontentloaded", timeout: remaining() });
    const main = ownerPage.locator("main");

    async function uniqueVisible(locator: Locator): Promise<Locator> {
      while (remaining()) {
        const matches: Locator[] = [];
        for (const match of await locator.all()) {
          if (await match.isVisible()) matches.push(match);
        }
        if (matches.length > 1) throw new AwsStreakReadError("selector_unverified");
        if (matches.length === 1) return matches[0];
        await ownerPage.waitForTimeout(Math.min(100, remaining()));
      }
      throw new AwsStreakReadError("selector_unverified");
    }

    async function verifyOwner() {
      remaining();
      if (!ownProfileDocument(ownerPage.url())) throw new AwsStreakReadError("auth_required");
      // A self-edit link supplies positive hydration/ownership evidence; an
      // initially anonymous header alone cannot establish a completed session.
      const edit = await uniqueVisible(main.getByRole("link", { name: "Edit information", exact: true }));
      const editData = await edit.evaluate(element => ({ tag: element.tagName, href: element.getAttribute("href") }));
      if (editData.tag !== "A" || !editData.href || !selfEditLink(editData.href)) {
        throw new AwsStreakReadError("auth_required");
      }
      for (const signIn of await ownerPage.getByRole("button", { name: "Sign in", exact: true }).all()) {
        if (await signIn.isVisible()) throw new AwsStreakReadError("auth_required");
      }
      await activity.readAccount(expectedAccountProfileUrl, Math.min(10000, remaining()));
      if (!ownProfileDocument(ownerPage.url())) throw new AwsStreakReadError("auth_required");
      remaining();
    }

    await verifyOwner();
    const activityHeading = await uniqueVisible(main.getByRole("heading", { name: "Activity", exact: true }));
    await activityHeading.scrollIntoViewIfNeeded({ timeout: remaining() });
    const badges = await uniqueVisible(main.getByRole("tab", { name: "Badges", exact: true }));
    if (!(await badges.evaluate(element => element.tagName === "BUTTON"))) throw new AwsStreakReadError("selector_unverified");
    await badges.click({ timeout: remaining() });
    await badges.waitFor({ state: "visible", timeout: remaining() });
    if (await badges.getAttribute("aria-selected") !== "true") throw new AwsStreakReadError("selector_unverified");

    const titles = ["30-Day Visit Streak", "30-Day Like Streak", "30-Day Comment Streak", "90-Day Visit Streak"];
    const badgeButtons = (title: string) => main.getByRole("button").filter({ has: ownerPage.getByAltText(title, { exact: true }) });
    for (let index = 0; index < 8; index++) {
      if ((await Promise.all(titles.map(title => badgeButtons(title).count()))).every(count => count === 1)) break;
      const more = await uniqueVisible(main.getByRole("button", { name: "Load more", exact: true }));
      if (!(await more.evaluate(element => element.tagName === "BUTTON"))) throw new AwsStreakReadError("selector_unverified");
      const before = await main.locator("img[alt]").count();
      await more.scrollIntoViewIfNeeded({ timeout: remaining() });
      await more.click({ timeout: remaining() });
      await ownerPage.waitForFunction(count => document.querySelectorAll("main img[alt]").length > count,
        before, { timeout: remaining() });
    }

    async function readBadge<Total extends 30 | 90>(title: string, total: Total): Promise<AwsStreakProgress<Total>> {
      await verifyOwner();
      const button = await uniqueVisible(badgeButtons(title));
      if (!(await button.evaluate(element => element.tagName === "BUTTON"))) throw new AwsStreakReadError("selector_unverified");
      await button.click({ timeout: remaining() });
      const dialog = await uniqueVisible(ownerPage.getByRole("dialog", { name: title, exact: true }));
      const visibleDialogs = [];
      for (const match of await ownerPage.getByRole("dialog").all()) if (await match.isVisible()) visibleDialogs.push(match);
      if (visibleDialogs.length !== 1) throw new AwsStreakReadError("selector_unverified");
      const text = (await dialog.innerText({ timeout: remaining() })).replace(/\s+/g, " ").trim();
      const counts = [...text.matchAll(/(?:^|\s)(\d+)\s*\/\s*(\d+)\s+days(?=\s|$)/g)];
      if (counts.length !== 1) throw new AwsStreakReadError("state_unknown");
      const current = Number(counts[0][1]);
      if (!Number.isSafeInteger(current) || current < 0 || current > total || Number(counts[0][2]) !== total) {
        throw new AwsStreakReadError("state_unknown");
      }
      await verifyOwner();
      const close = await uniqueVisible(dialog.getByRole("button", { name: "Close modal", exact: true }));
      if (!(await close.evaluate(element => element.tagName === "BUTTON"))) throw new AwsStreakReadError("selector_unverified");
      await close.click({ timeout: remaining() });
      await dialog.waitFor({ state: "hidden", timeout: remaining() });
      return { current, total };
    }

    const visit = await readBadge(titles[0], 30);
    const like = await readBadge(titles[1], 30);
    const comment = await readBadge(titles[2], 30);
    const visit90 = await readBadge(titles[3], 90);
    await verifyOwner();
    return { observedAt: new Date().toISOString(), visit, like, comment, visit90 };
  } catch (error) {
    if (error instanceof AwsStreakReadError) throw error;
    if (error instanceof OwnArticleActivityError) throw new AwsStreakReadError(error.code);
    throw new AwsStreakReadError("state_unknown");
  } finally { await page?.close().catch(() => undefined); }
}
