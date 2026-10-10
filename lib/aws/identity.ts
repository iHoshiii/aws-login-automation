import type { BrowserContext, Locator } from "playwright-core";

const ORIGIN = "https://builder.aws.com";

export class SelfProfileIdentityError extends Error {
  constructor(public readonly code: "auth_required" | "selector_unverified") {
    super(code === "auth_required"
      ? "The signed-in AWS self profile could not be verified. Reconnect your account."
      : "The observed AWS self-profile controls could not be verified. Reconnect to capture the current layout.");
    this.name = "SelfProfileIdentityError";
  }
}

function isBuilderPath(raw: string, path: string): boolean {
  try {
    const url = new URL(raw, ORIGIN);
    return url.origin === ORIGIN && url.pathname.replace(/\/$/, "") === path && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function isSelfProfileUrl(raw: string): boolean {
  return isBuilderPath(raw, "/profile");
}

function isSelfProfileDocument(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === ORIGIN && url.pathname.replace(/\/$/, "") === "/profile" &&
      (url.search === "" || url.search === "?tab=badges") && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/** Read the owner's public alias from the authenticated self-profile QR dialog. */
export async function readSignedInSelfProfile(context: BrowserContext, timeoutMs = 10000): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new SelfProfileIdentityError("selector_unverified");
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left < 1) throw new SelfProfileIdentityError("selector_unverified");
    return left;
  };
  const page = await context.newPage();
  async function uniqueVisible(locator: Locator): Promise<Locator> {
    while (remaining()) {
      const visible: Locator[] = [];
      for (const match of await locator.all()) {
        if (await match.isVisible()) visible.push(match);
      }
      if (visible.length > 1) throw new SelfProfileIdentityError("selector_unverified");
      if (visible.length === 1) return visible[0];
      await page.waitForTimeout(Math.min(100, remaining()));
    }
    throw new SelfProfileIdentityError("selector_unverified");
  }
  async function requireSignedInSelfPage() {
    remaining();
    if (!isSelfProfileDocument(page.url())) throw new SelfProfileIdentityError("auth_required");
    for (const signIn of await page.getByRole("button", { name: "Sign in", exact: true }).all()) {
      if (await signIn.isVisible()) throw new SelfProfileIdentityError("auth_required");
    }
  }
  try {
    await page.goto(`${ORIGIN}/profile`, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (!isSelfProfileDocument(page.url())) throw new SelfProfileIdentityError("auth_required");
    const main = page.locator("main");
    // Initial server markup can show Sign in until the owner's session hydrates.
    // Wait for positive self-edit evidence before interpreting that header.
    const edit = await uniqueVisible(main.getByRole("link", { name: "Edit information", exact: true }));
    if (!isSelfProfileDocument(page.url())) throw new SelfProfileIdentityError("auth_required");
    if (!(await edit.evaluate(element => element.tagName === "A")) || !isBuilderPath(await edit.getAttribute("href") ?? "", "/edit/profile")) {
      throw new SelfProfileIdentityError("auth_required");
    }
    const qr = await uniqueVisible(main.getByRole("button", { name: "QR code", exact: true }));
    if (!(await qr.evaluate(element => element.tagName === "BUTTON"))) throw new SelfProfileIdentityError("selector_unverified");
    await requireSignedInSelfPage();
    await qr.click({ timeout: remaining() });
    const dialog = await uniqueVisible(page.getByRole("dialog"));
    const text = (await dialog.innerText({ timeout: remaining() })).replace(/\s+/g, " ").trim();
    const labels = text.match(/\bAlias:/g) ?? [];
    const alias = /(?:^|\s)Alias:\s*@([A-Za-z0-9_.-]+)(?=\s|$)/.exec(text);
    if (labels.length !== 1 || !alias || !isSelfProfileDocument(page.url())) {
      throw new SelfProfileIdentityError("selector_unverified");
    }
    await requireSignedInSelfPage();
    return `${ORIGIN}/community/@${alias[1]}`;
  } catch (error) {
    if (error instanceof SelfProfileIdentityError) throw error;
    throw new SelfProfileIdentityError("selector_unverified");
  } finally {
    await page.close().catch(() => undefined);
  }
}
