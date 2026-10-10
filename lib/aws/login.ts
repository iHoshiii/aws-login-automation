import type { BrowserContext, Page } from "playwright-core";
import { canonicalProfileUrl } from "./site";
import { isSelfProfileUrl, readSignedInSelfProfile } from "./identity";

export class GoogleCaptureLoginRejectedError extends Error {
  constructor() {
    super("Google rejected sign-in in the reopened capture browser. Run npm run aws:connect -- --manual-browser again. Complete your passkey or MFA and confirm your signed-in AWS account in the first Chrome window before closing it and pressing Enter. No AWS session was captured.");
    this.name = "GoogleCaptureLoginRejectedError";
  }
}

/** Positive account evidence, before the owner calibrates the exact controls. */
export async function hasSignedInBuilderHeader(page: Page): Promise<boolean> {
  if (new URL(page.url()).origin !== "https://builder.aws.com") return false;
  for (const signIn of await page.getByRole("button", { name: "Sign in", exact: true }).all()) {
    if (await signIn.isVisible()) return false;
  }
  const profiles = new Set<string>();
  const links = page.locator('header a[href],[role="banner"] a[href],[role="menu"] a[href]');
  for (const link of await links.all()) {
    if (!await link.isVisible()) continue;
    const href = await link.getAttribute("href");
    if (href) { try { profiles.add(canonicalProfileUrl(href)); } catch { /* Other header links are not account evidence. */ } }
  }
  if (profiles.size) return profiles.size === 1;
  const menus = [];
  for (const menu of await page.getByRole("menu").all()) {
    if (!await menu.isVisible()) continue;
    const ownLinks = [];
    for (const link of await menu.locator("a[href]").all()) {
      if (await link.isVisible() && (await link.textContent())?.replace(/\s+/g, " ").trim() === "Manage profile" && isSelfProfileUrl(await link.getAttribute("href") ?? "")) ownLinks.push(link);
    }
    const signOut = [];
    for (const item of await menu.getByRole("menuitem", { name: "Sign out", exact: true }).all()) {
      if (await item.isVisible()) signOut.push(item);
    }
    if (ownLinks.length === 1 && signOut.length === 1) menus.push(menu);
  }
  if (menus.length !== 1) return false;
  try { await readSignedInSelfProfile(page.context()); return true; }
  catch { return false; }
}

/** Verify the existing session after manual login; provider sign-in stays in the first browser. */
export async function waitForSignedInBuilder(context: BrowserContext, timeoutMs = 10 * 60_000, pollMs = 400): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages().filter(page => !page.isClosed());
    // A completed AWS session takes precedence over an old rejected OAuth tab.
    for (const page of pages) {
      if (await hasSignedInBuilderHeader(page).catch(() => false)) return page;
    }
    for (const page of pages) {
      let address: URL;
      try { address = new URL(page.url()); } catch { continue; }
      if (address.origin === "https://accounts.google.com" && address.pathname === "/v3/signin/rejected") {
        throw new GoogleCaptureLoginRejectedError();
      }
    }
    if (!pages.length) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  throw new Error("The signed-in AWS account was not observed. Reconnect and finish the browser sign-in before calibration.");
}

export function builderIdEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Configure a valid AWS_BUILDER_ID_EMAIL.");
  return email;
}

/** Uses the observed public AWS dialog; passwords and MFA remain interactive. */
export async function startBuilderIdLogin(page: Page, value: string, timeoutMs = 15000) {
  const email = builderIdEmail(value);
  if (new URL(page.url()).origin !== "https://builder.aws.com") throw new Error("Open AWS Builder Center before signing in.");
  await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await signIn.first().click({ timeout: timeoutMs });
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Sign in to join the community", exact: true }) });
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });
  if (new URL(page.url()).origin !== "https://builder.aws.com") throw new Error("Unexpected login origin.");
  const field = dialog.getByRole("textbox", { name: "Email", exact: true });
  const submit = dialog.getByRole("button", { name: "Continue with Builder ID", exact: true });
  if (await field.count() !== 1 || await submit.count() !== 1) throw new Error("AWS Builder ID sign-in controls changed.");
  await field.fill(email);
  // This selects the requested account's sign-in flow, never an engagement control.
  await submit.click({ timeout: timeoutMs });
}
