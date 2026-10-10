import type { Page } from "playwright-core";
import { canonicalProfileUrl } from "./site";

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
  return profiles.size === 1;
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
