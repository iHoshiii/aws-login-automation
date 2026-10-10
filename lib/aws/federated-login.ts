import type { BrowserContext, Locator, Page } from "playwright-core";
import { builderIdEmail } from "./login";

export type FederatedLoginState = "waiting_device" | "manual" | "login_returned" | "timed_out";

export interface FederatedLoginResult {
  state: FederatedLoginState;
  page: Page | null;
  message: string;
}

export interface FederatedLoginOptions {
  email: string;
  startPage?: Page;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onStatus?: (result: FederatedLoginResult) => void | Promise<void>;
  /** Positive check of controls observed in the owner's actual signed-in header. */
  isBuilderSignedIn?: (page: Page) => Promise<boolean>;
  /** Supply only labels actually observed on this account's Google passkey screen. */
  observedGooglePasskeyNames?: readonly ("Use your passkey" | "Use passkey")[];
}

type Action = "github_google" | "google_account" | "google_identifier" | "google_passkey";
interface Flow {
  email: string;
  root: Page;
  pages: Set<Page>;
  actions: WeakMap<Page, Set<Action>>;
  attempted: Set<Action>;
  externalPages: Set<Page>;
  devicePages: Set<Page>;
  reported: Set<string>;
}

// A second call using the same context cannot repeat a failed/uncertain click.
const flows = new WeakMap<BrowserContext, Flow>();
const BUILDER = "https://builder.aws.com";
const GOOGLE = "https://accounts.google.com";
const GITHUB = "https://github.com";

function address(page: Page): URL | null {
  try { return new URL(page.url()); } catch { return null; }
}

function isGitHubLogin(page: Page): boolean {
  const url = address(page);
  return url?.origin === GITHUB && url.pathname === "/login";
}

async function visibleUnique(locator: Locator): Promise<Locator | null> {
  const visible: Locator[] = [];
  for (const match of await locator.all()) {
    if (await match.isVisible().catch(() => false)) visible.push(match);
  }
  return visible.length === 1 ? visible[0] : null;
}

async function namedControl(page: Page, name: string): Promise<Locator | null> {
  const controls = page.getByRole("button", { name, exact: true }).or(page.getByRole("link", { name, exact: true }));
  return visibleUnique(controls);
}

function hasAction(flow: Flow, page: Page, action: Action): boolean {
  return flow.attempted.has(action) || (flow.actions.get(page)?.has(action) ?? false);
}

function markAction(flow: Flow, page: Page, action: Action): void {
  const actions = flow.actions.get(page) ?? new Set<Action>();
  actions.add(action);
  flow.actions.set(page, actions);
  flow.attempted.add(action);
}

async function addPopupFamily(context: BrowserContext, flow: Flow): Promise<void> {
  // Popups are discovered on every poll, including ones created before this call.
  // Unrelated tabs in an attached desktop browser are not part of this OAuth flow.
  for (const page of context.pages()) {
    if (flow.pages.has(page) || page.isClosed()) continue;
    const opener = await page.opener().catch(() => null);
    if (opener && flow.pages.has(opener)) flow.pages.add(page);
  }
}

/**
 * Assist an already-started GitHub → Google login without restarting its OAuth
 * URL. Passwords, device/PIN prompts, grants, and unsupported screens stay manual.
 * A Builder return also requires the caller's positive signed-in-header check.
 */
export async function assistFederatedLogin(context: BrowserContext, options: FederatedLoginOptions): Promise<FederatedLoginResult> {
  const email = builderIdEmail(options.email);
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 400;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 || !Number.isFinite(pollMs) || pollMs < 10 || pollMs > 10000) {
    throw new Error("Federated login requires bounded positive monitoring limits.");
  }
  const observedPasskeyNames = options.observedGooglePasskeyNames ?? [];
  if (observedPasskeyNames.some(name => name !== "Use your passkey" && name !== "Use passkey")) {
    throw new Error("Only observed Google passkey controls may be selected.");
  }
  let flow = flows.get(context);
  if (!flow) {
    const initial = options.startPage ?? context.pages().findLast(page => isGitHubLogin(page) || address(page)?.origin === GOOGLE) ?? context.pages().at(-1);
    if (!initial) return { state: "manual", page: null, message: "Open the existing AWS sign-in browser before starting federation assistance." };
    flow = { email, root: initial, pages: new Set([initial]), actions: new WeakMap(), attempted: new Set(), externalPages: new Set(), devicePages: new Set(), reported: new Set() };
    // Include an opener when the current Google screen is already a popup.
    let ancestor = await initial.opener().catch(() => null);
    while (ancestor) {
      flow.pages.add(ancestor);
      ancestor = await ancestor.opener().catch(() => null);
    }
    flows.set(context, flow);
  }
  if (flow.email !== email) return { state: "manual", page: flow.root, message: "This browser flow is bound to a different configured Google identity. Continue manually." };
  const activeFlow = flow;
  const deadline = Date.now() + timeoutMs;
  let last: FederatedLoginResult | null = null;
  let progressed = false;

  async function report(state: FederatedLoginState, page: Page | null, message: string) {
    const result = { state, page, message };
    last = result;
    const key = `${state}:${message}`;
    if (!activeFlow.reported.has(key)) {
      activeFlow.reported.add(key);
      await options.onStatus?.(result);
    }
    return result;
  }

  async function clickOnce(page: Page, control: Locator, action: Action, allowed: () => boolean) {
    if (!allowed() || hasAction(activeFlow, page, action)) return false;
    // Record before clicking: a timeout/navigation failure must not cause retry.
    markAction(activeFlow, page, action);
    progressed = true;
    try {
      await control.click({ timeout: Math.max(1,Math.min(5000,deadline-Date.now())), noWaitAfter: true });
      return true;
    } catch {
      await report("manual", page, "The sign-in control was attempted once but its result could not be confirmed. Continue in the current browser.");
      return false;
    }
  }

  while (Date.now() < deadline && !options.signal?.aborted) {
    await addPopupFamily(context, activeFlow);
    const pages = [...activeFlow.pages].filter(page => !page.isClosed());
    // New popups first, so an old background sign-in page cannot override the
    // device prompt/identity page currently completing the same flow.
    for (const page of pages.reverse()) {
      const url = address(page);
      if (!url || url.protocol !== "https:") continue;
      if (isGitHubLogin(page) || url.origin === GOOGLE) {
        activeFlow.externalPages.add(page);
      }
      if (url.origin !== BUILDER) activeFlow.externalPages.add(page);
      if (url.origin === GOOGLE && url.pathname === "/v3/signin/rejected") {
        return report("manual", page, "Google rejected this browser sign-in. Your AWS account is not connected. Complete a supported sign-in manually; no email retry or browser-disguising workaround will be attempted.");
      }
      if (url.origin === BUILDER) {
        // A native AWS IdP or a closing popup may leave the original Builder
        // tab at the same URL. Positive observed account controls are decisive;
        // an origin change or disappearance of Sign in is not sufficient.
        if (options.isBuilderSignedIn && await options.isBuilderSignedIn(page).catch(() => false)) {
          return report("login_returned", page, "AWS Builder Center's observed signed-in account header was confirmed in the existing login browser.");
        }
        if (activeFlow.externalPages.has(page)) {
          if (!options.isBuilderSignedIn) return report("manual", page, "OAuth returned to AWS Builder Center, but a signed-in account has not been verified. Check the actual account header before recording a session.");
          await report("manual", page, "OAuth returned to AWS Builder Center, but the observed signed-in account header is not confirmed yet. Open the account menu if necessary.");
        }
        continue;
      }
      try {
        if (isGitHubLogin(page)) {
          if (hasAction(activeFlow, page, "github_google")) continue;
          const google = await namedControl(page, "Continue with Google");
          if (google) await clickOnce(page, google, "github_google", () => isGitHubLogin(page));
          else await report("manual", page, "GitHub's observed Continue with Google control is absent or ambiguous. Continue this sign-in manually.");
          continue;
        }
        if (url.origin === GOOGLE) {
          const chooser = await visibleUnique(page.getByRole("heading", { name: "Choose an account", exact: true }));
          const ownIdentityVisible = !!(await visibleUnique(page.getByText(email, { exact: true }))) || !!(await namedControl(page, email));
          let passkey: Locator | null = null;
          for (const name of observedPasskeyNames) {
            const match = await namedControl(page, name);
            if (match) {
              if (passkey) { passkey = null; break; }
              passkey = match;
            }
          }
          if (passkey && !chooser && ownIdentityVisible && !hasAction(activeFlow, page, "google_passkey")) {
            if (await clickOnce(page, passkey, "google_passkey", () => address(page)?.origin === GOOGLE)) {
              activeFlow.devicePages.add(page);
              await report("waiting_device", page, "Use the passkey prompt on your own device. Complete its fingerprint, face, security key, or device PIN confirmation there.");
            }
            continue;
          }
          if (activeFlow.devicePages.has(page)) {
            await report("waiting_device", page, "Use the passkey prompt on your own device. Complete its fingerprint, face, security key, or device PIN confirmation there.");
            continue;
          }
          if (!hasAction(activeFlow, page, "google_account") && !hasAction(activeFlow, page, "google_identifier")) {
            // Exact own-email accessible name only. Do not choose another row,
            // use hidden provider attributes, or infer an account from a name.
            const ownAccount = chooser ? await namedControl(page, email) : null;
            if (ownAccount) {
              await clickOnce(page, ownAccount, "google_account", () => address(page)?.origin === GOOGLE);
              continue;
            }
            const field = await visibleUnique(page.getByRole("textbox", { name: "Email or phone", exact: true }));
            const next = await visibleUnique(page.getByRole("button", { name: "Next", exact: true }));
            if (field && next) {
              const actual = await field.evaluate(element => ({ tag: element.tagName, type: element.getAttribute("type"), autocomplete: element.getAttribute("autocomplete") }));
              if (actual.tag === "INPUT" && (actual.type === "text" || actual.type === "email") && actual.autocomplete === "username" && address(page)?.origin === GOOGLE) {
                markAction(activeFlow, page, "google_identifier");
                progressed = true;
                await field.fill(email, { timeout: Math.max(1,Math.min(3000,deadline-Date.now())) });
                if (address(page)?.origin !== GOOGLE || !(await next.isEnabled())) {
                  await report("manual", page, "Google's identifier step changed before continuing. Check it in the current browser.");
                  continue;
                }
                await next.click({ timeout: Math.max(1,Math.min(5000,deadline-Date.now())), noWaitAfter: true });
                continue;
              }
            }
          }
          await report("manual", page, "Complete the current Google sign-in or verification step in the browser. No password, PIN, or OAuth permission grant is entered automatically.");
          continue;
        }
        if (url.origin !== BUILDER) {
          await report("manual", page, "The current OAuth screen is outside the supported GitHub and Google sign-in controls. Continue manually without restarting the flow.");
        }
      } catch {
        await report("manual", page, "The sign-in screen changed during inspection. Continue manually in the existing browser; attempted controls will not be retried.");
      }
    }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs,Math.max(1,deadline-Date.now()))));
  }
  // Device/manual statuses remain actionable when the observation period ends.
  const final = last as FederatedLoginResult | null;
  if (!options.signal?.aborted && final && (final.state === "waiting_device" || final.state === "manual")) return final;
  return report("timed_out", [...activeFlow.pages].findLast(page => !page.isClosed()) ?? null,
    options.signal?.aborted ? "Federation monitoring stopped. The existing browser flow remains open." : progressed ? "The sign-in actions were attempted once, but an AWS Builder callback was not observed before the monitoring deadline." : "An AWS Builder callback was not observed before the monitoring deadline.");
}
