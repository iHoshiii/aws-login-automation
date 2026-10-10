import type { Locator, Page } from "playwright-core";
import { isSelfProfileUrl, readSignedInSelfProfile, SelfProfileIdentityError } from "./identity";
import { createAwsPageReadiness } from "./readiness";
import { createOwnArticleActivity, OwnArticleActivityError } from "./activity";

const ORIGIN = "https://builder.aws.com";
const LIKE_SELECTOR = 'main button[aria-pressed][aria-label^="Like this article"]:not(#comments button)';
const COMMENT_SELECTOR = '#comments [class*="_comment-main_"]';
const BODY_SELECTOR = '[class*="_comment-content_"] > [class*="_editor-container_"]';

export type AwsSiteErrorCode = "auth_required" | "selector_unverified" | "state_unknown" | "action_uncertain" | "already_done";

export class AwsSiteError extends Error {
  constructor(public readonly code: AwsSiteErrorCode, message: string) {
    super(message);
    this.name = "AwsSiteError";
  }
}

/** Only authenticated controls captured from the user's actual browser belong here. */
export interface SiteProfile {
  version: 1;
  capturedAt: string;
  accountProfileUrl: string;
  identitySource?: "self_profile";
  accountSelector: string;
  accountMenuSelector?: string;
  commentEditorSelector: string;
  commentSubmitSelector: string;
  likeSelector: string;
  controls?: {
    accountMenu?: ControlFingerprint;
    editor: ControlFingerprint;
    submit: ControlFingerprint;
    composer: { tag: string; className: string };
  };
}

export interface ControlFingerprint {
  tag: string;
  role: string | null;
  label: string | null;
  type: string | null;
  placeholder: string | null;
  editable: boolean;
  buttonText: string | null;
}

export type SiteProfileInput = Omit<SiteProfile, "version" | "capturedAt" | "likeSelector"> & { likeSelector?: string };

export interface AwsCandidate {
  url: string;
  title: string;
}

export interface AwsCandidateInspection {
  liked: boolean;
  commented: boolean;
  excerpt: string;
  commentsComplete: boolean;
}

export interface AwsSiteDriver {
  checkAuthentication(): Promise<true>;
  discoverCandidates(limit: number): Promise<AwsCandidate[]>;
  inspectCandidate(candidate: AwsCandidate): Promise<AwsCandidateInspection>;
  likeAndVerify(candidate: AwsCandidate): Promise<"verified" | "already_done">;
  commentAndVerify(candidate: AwsCandidate, text: string): Promise<"verified" | "already_done">;
}

export interface AwsSiteOptions {
  maxCommentPages?: number;
  maxDiscoveryPages?: number;
  timeoutMs?: number;
  /** Absolute execution deadline; bounded reads stop before starting more work. */
  deadline?: number;
  /** Fresh worker lease/configuration check at the last boundary before an AWS write. */
  beforeSubmit?: () => Promise<void>;
}

export function canonicalProfileUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw, ORIGIN); } catch { throw new AwsSiteError("selector_unverified", "Invalid Builder account profile URL."); }
  if (url.origin !== ORIGIN || !/^\/community\/@[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
    throw new AwsSiteError("selector_unverified", "Use the observed Builder account URL: https://builder.aws.com/community/@your-alias.");
  }
  return `${ORIGIN}${url.pathname.replace(/\/$/, "")}`;
}

export function canonicalContentUrl(raw: string): string | null {
  try {
    const url = new URL(raw, ORIGIN);
    const match = /^\/content\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
    if (url.origin !== ORIGIN || !match) return null;
    return `${ORIGIN}/content/${match[1]}`;
  } catch { return null; }
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

function validateProfile(value: SiteProfile, requireControls = true): void {
  if (value.version !== 1 || !value.capturedAt || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new AwsSiteError("selector_unverified", "Run aws:connect to capture the signed-in Builder controls.");
  }
  canonicalProfileUrl(value.accountProfileUrl);
  if (value.identitySource !== undefined && value.identitySource !== "self_profile") {
    throw new AwsSiteError("selector_unverified", "The recorded account identity source is unsupported. Reconnect your account.");
  }
  for (const selector of [value.accountSelector, value.commentEditorSelector, value.commentSubmitSelector, value.likeSelector]) {
    if (typeof selector !== "string" || !selector.trim() || selector.length > 500) {
      throw new AwsSiteError("selector_unverified", "The recorded Builder controls are incomplete. Run aws:connect again.");
    }
  }
  if (requireControls && (!value.controls?.editor || !value.controls.submit || !value.controls.composer || (value.accountMenuSelector && !value.controls.accountMenu))) {
    throw new AwsSiteError("selector_unverified", "The recorded controls lack observed fingerprints. Run aws:connect again.");
  }
}

async function fingerprint(locator: Locator): Promise<ControlFingerprint> {
  return locator.evaluate(element => ({
    tag: element.tagName,
    role: element.getAttribute("role"),
    label: element.getAttribute("aria-label"),
    type: element.getAttribute("type"),
    placeholder: element.getAttribute("placeholder"),
    editable: (element as HTMLElement).isContentEditable || ["INPUT", "TEXTAREA"].includes(element.tagName),
    buttonText: element.tagName === "BUTTON" ? element.textContent?.replace(/\s+/g, " ").trim() ?? "" : null
  }));
}

async function assertFingerprint(locator: Locator, expected: ControlFingerprint | undefined, name: string) {
  if (!expected || JSON.stringify(await fingerprint(locator)) !== JSON.stringify(expected)) {
    throw new AwsSiteError("selector_unverified", `The observed ${name} changed. Reconnect before proceeding.`);
  }
}

async function composerRelation(page: Page, profile: SiteProfile) {
  return page.evaluate(({ editorSelector, submitSelector }) => {
    const editor = document.querySelector(editorSelector);
    const submit = document.querySelector(submitSelector);
    if (!editor || !submit || !editor.closest("#comments") || !submit.closest("#comments") || editor.closest('[class*="_comment-main_"]') || submit.closest('[class*="_comment-main_"]')) return null;
    let parent = editor.parentElement;
    while (parent && !parent.contains(submit)) parent = parent.parentElement;
    if (!parent || parent.id === "comments" || !parent.closest("#comments") || parent.querySelector('[class*="_comment-main_"]')) return null;
    return { tag: parent.tagName, className: parent.className };
  }, { editorSelector: profile.commentEditorSelector, submitSelector: profile.commentSubmitSelector });
}

async function assertComposer(page: Page, profile: SiteProfile) {
  const relation = await composerRelation(page, profile);
  if (!relation || JSON.stringify(relation) !== JSON.stringify(profile.controls?.composer)) {
    throw new AwsSiteError("selector_unverified", "The recorded editor and submit button no longer share their observed comment composer.");
  }
}

async function uniqueVisible(locator: Locator, name: string, timeoutMs: number): Promise<Locator> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    if (await locator.count() !== 1) throw new Error("ambiguous");
    return locator;
  } catch {
    throw new AwsSiteError("selector_unverified", `The recorded ${name} is absent or ambiguous. Reconnect to capture the current controls.`);
  }
}

async function requireIdentity(page: Page, profile: SiteProfile, timeoutMs: number, capturing = false): Promise<void> {
  if (new URL(page.url()).origin !== ORIGIN) throw new AwsSiteError("auth_required", "AWS sign-in is required.");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  for (const button of await signIn.all()) {
    if (await button.isVisible()) throw new AwsSiteError("auth_required", "AWS session expired. Run aws:connect and sign in again.");
  }
  let openedMenu = false;
  try {
    const marker = page.locator(profile.accountSelector);
    if (!(await marker.isVisible().catch(() => false)) && profile.accountMenuSelector) {
      const opener = await uniqueVisible(page.locator(profile.accountMenuSelector), "account menu", timeoutMs);
      const safeArea = await opener.evaluate(element => element.tagName === "BUTTON" && !!element.closest('header,[role="banner"]'));
      if (!safeArea) throw new AwsSiteError("selector_unverified", "The recorded account menu opener is outside the page header.");
      if (!capturing) await assertFingerprint(opener, profile.controls?.accountMenu, "account menu opener");
      await opener.click();
      openedMenu = true;
    }
    await uniqueVisible(marker, "account identity link", timeoutMs);
    const identity = await marker.evaluate(element => ({
      href: element.getAttribute("href"),
      accountArea: !!element.closest('header,[role="banner"],[role="menu"]'),
      tag: element.tagName,
      label: element.textContent?.replace(/\s+/g, " ").trim()
    }));
    if (identity.tag !== "A" || !identity.accountArea || !identity.href) {
      throw new AwsSiteError("auth_required", "The signed-in AWS account does not match the recorded account identity.");
    }
    if (profile.identitySource === "self_profile") {
      if (identity.label !== "Manage profile" || !isSelfProfileUrl(identity.href)) {
        throw new AwsSiteError("auth_required", "The observed account control is not the signed-in AWS self profile.");
      }
      let ownProfile: string;
      try { ownProfile = await readSignedInSelfProfile(page.context(), timeoutMs); }
      catch (error) {
        throw new AwsSiteError(error instanceof SelfProfileIdentityError ? error.code : "selector_unverified", "The signed-in AWS self-profile identity could not be confirmed. Reconnect your account.");
      }
      if (ownProfile !== canonicalProfileUrl(profile.accountProfileUrl)) {
        throw new AwsSiteError("auth_required", "The signed-in AWS account does not match the recorded account identity.");
      }
    } else if (canonicalProfileUrl(identity.href) !== canonicalProfileUrl(profile.accountProfileUrl)) {
      throw new AwsSiteError("auth_required", "The signed-in AWS account does not match the recorded account identity.");
    }
  } finally {
    if (openedMenu) await page.keyboard.press("Escape").catch(() => undefined);
  }
}

async function likeState(page: Page, profile: SiteProfile, timeoutMs: number): Promise<boolean> {
  const buttons = page.locator(profile.likeSelector);
  try { await buttons.first().waitFor({ state: "visible", timeout: timeoutMs }); }
  catch { throw new AwsSiteError("state_unknown", "The article's like state cannot be read."); }
  const states = await buttons.evaluateAll(elements => elements.map(element => ({
    pressed: element.getAttribute("aria-pressed"),
    label: element.getAttribute("aria-label"),
    inComments: !!element.closest("#comments"),
    tag: element.tagName
  })));
  if (!states.length || states.length > 2 || states.some(state => state.tag !== "BUTTON" || state.inComments || !state.label?.includes("this article") || !["true", "false"].includes(state.pressed ?? ""))) {
    throw new AwsSiteError("state_unknown", "The recorded article like buttons no longer have the inspected structure.");
  }
  if (states.some(state => state.pressed !== states[0].pressed)) throw new AwsSiteError("state_unknown", "Article like controls disagree.");
  return states[0].pressed === "true";
}

/** Read-only capture. The CLI supplies selectors read from the real signed-in DOM. */
export async function captureSiteProfile(page: Page, input: SiteProfileInput): Promise<SiteProfile> {
  const profile: SiteProfile = {
    ...input,
    accountProfileUrl: canonicalProfileUrl(input.accountProfileUrl),
    likeSelector: input.likeSelector ?? LIKE_SELECTOR,
    version: 1,
    capturedAt: new Date().toISOString()
  };
  validateProfile(profile, false);
  if (!canonicalContentUrl(page.url())) throw new AwsSiteError("selector_unverified", "Open an actual Builder article before capturing its controls.");
  await requireIdentity(page, profile, 10000, true);
  await likeState(page, profile, 10000);
  const editor = await uniqueVisible(page.locator(profile.commentEditorSelector), "comment editor", 10000);
  const editorData = await editor.evaluate(element => ({
    inComments: !!element.closest("#comments"),
    inReply: !!element.closest('[class*="_comment-main_"]'),
    editable: (element as HTMLElement).isContentEditable || ["TEXTAREA", "INPUT"].includes(element.tagName),
    text: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent
  }));
  if (!editorData.inComments || editorData.inReply || !editorData.editable || normalized(editorData.text ?? "")) {
    throw new AwsSiteError("selector_unverified", "Select the empty top-level comment editor inside #comments.");
  }
  const submit = await uniqueVisible(page.locator(profile.commentSubmitSelector), "comment submit button", 10000);
  const submitData = await submit.evaluate(element => ({
    tag: element.tagName,
    inComments: !!element.closest("#comments"),
    inReply: !!element.closest('[class*="_comment-main_"]'),
    label: element.getAttribute("aria-label") || element.textContent
  }));
  if (submitData.tag !== "BUTTON" || !submitData.inComments || submitData.inReply || !normalized(submitData.label ?? "")) {
    throw new AwsSiteError("selector_unverified", "Select the named top-level comment submit button inside #comments.");
  }
  const composer = await composerRelation(page, profile);
  if (!composer) throw new AwsSiteError("selector_unverified", "The selected editor and submit button must share the actual top-level comment composer.");
  profile.controls = {
    editor: await fingerprint(editor),
    submit: await fingerprint(submit),
    composer
  };
  if (profile.accountMenuSelector) {
    const opener = await uniqueVisible(page.locator(profile.accountMenuSelector), "account menu", 10000);
    if (!(await opener.evaluate(element => element.tagName === "BUTTON" && !!element.closest('header,[role="banner"]')))) {
      throw new AwsSiteError("selector_unverified", "Select the actual account menu button in the header.");
    }
    profile.controls.accountMenu = await fingerprint(opener);
  }
  validateProfile(profile);
  return profile;
}

export function createAwsSiteDriver(page: Page, profile: SiteProfile, options: AwsSiteOptions = {}): AwsSiteDriver {
  validateProfile(profile);
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxCommentPages = options.maxCommentPages ?? 15;
  const maxDiscoveryPages = options.maxDiscoveryPages ?? 3;
  const ownProfile = canonicalProfileUrl(profile.accountProfileUrl);
  const readiness = createAwsPageReadiness(page);
  const activity = createOwnArticleActivity(page);
  let observedCommentCount: number | undefined;
  function checkBudget() {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      throw new AwsSiteError("state_unknown", "The browser inspection budget has expired.");
    }
  }

  async function settlePage() {
    checkBudget();
    // The public SSR toolbar starts unpressed. Let client-side account/activity
    // requests settle before interpreting that state as the owner's own state.
    try { await readiness.wait(timeoutMs, options.deadline); }
    catch { throw new AwsSiteError("state_unknown", "AWS page requests have not settled; account activity cannot be read reliably."); }
    checkBudget();
  }

  async function navigate(url: string) {
    checkBudget();
    readiness.begin({ accountOnly: new URL(url).pathname === "/", navigation: true, articleTruthRead: !!canonicalContentUrl(url) });
    activity.begin();
    observedCommentCount = undefined;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs * 2, 18000) });
    checkBudget();
    if (new URL(page.url()).origin !== ORIGIN) throw new AwsSiteError("auth_required", "AWS redirected to sign-in. Reconnect your session.");
    await settlePage();
    await requireIdentity(page, profile, timeoutMs);
    checkBudget();
  }

  async function commentsSnapshot() {
    return page.locator("#comments").evaluate(root => {
      const heading = root.querySelector("h2")?.textContent?.trim() ?? "";
      const match = /^Comments \((\d+)\)$/.exec(heading);
      const comments = Array.from(root.querySelectorAll('[class*="_comment-main_"]')).map(element => ({
        authors: Array.from(element.querySelectorAll('[data-module-id="profile"] a[href]')).map(link => link.getAttribute("href") ?? ""),
        body: element.querySelector('[class*="_comment-content_"] > [class*="_editor-container_"]')?.textContent ?? null,
        replies: Array.from(element.querySelectorAll('button[aria-label^="Reply "]')).map(button => button.getAttribute("aria-label") ?? ""),
        nested: !!element.closest('[class*="_comment-nested_"]')
      }));
      return {
        expected: match ? Number(match[1]) : null,
        comments,
        busy: !!root.querySelector('[role="status"][aria-label="Loading"][aria-busy="true"]'),
        loadMore: Array.from(root.querySelectorAll("button")).some(button => button.textContent?.trim() === "Load more")
      };
    });
  }

  async function ownLikeState(): Promise<boolean> {
    const rendered = await likeState(page, profile, timeoutMs);
    const url = canonicalContentUrl(page.url());
    if (!url) throw new AwsSiteError("state_unknown", "The current article cannot be verified.");
    checkBudget();
    try {
      const state = await activity.readState(url, ownProfile, Math.min(timeoutMs, options.deadline === undefined ? timeoutMs : Math.max(1, options.deadline - Date.now())));
      checkBudget();
      observedCommentCount = state.commentsCount;
      // Persisted true always skips a click. Persisted false also requires an
      // unpressed toolbar, because AWS can retain its anonymous SSR state.
      if (state.liked) return true;
      if (rendered) throw new AwsSiteError("state_unknown", "The article toolbar disagrees with the current account's persisted like state.");
      return false;
    } catch (error) {
      if (error instanceof AwsSiteError) throw error;
      throw new AwsSiteError(error instanceof OwnArticleActivityError ? error.code : "state_unknown", "The current account's persisted article activity could not be verified.");
    }
  }

  async function readComments(verifyText?: string): Promise<{ commented: boolean; complete: boolean }> {
    if (observedCommentCount === undefined) await ownLikeState();
    checkBudget();
    try { await page.locator("#comments h2").waitFor({ state: "visible", timeout: timeoutMs }); }
    catch { throw new AwsSiteError("state_unknown", "The article comment section cannot be read."); }
    // AWS defers comment fetching until this section enters the viewport.
    await page.locator("#comments h2").scrollIntoViewIfNeeded({ timeout: timeoutMs });
    const commentFeed = page.locator('#comments [role="feed"]').first();
    if (await commentFeed.count()) await commentFeed.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    for (let index = 0; index <= maxCommentPages; index++) {
      checkBudget();
      await page.waitForFunction(expected => {
        const root = document.querySelector("#comments");
        if (!root || root.querySelector('[role="status"][aria-label="Loading"][aria-busy="true"]')) return false;
        // AWS's feed aria-busy is !hasMore, so true means pagination exhausted.
        // Actual loading has a status spinner. Verify current server coverage too.
        const heading = /^Comments \((\d+)\)$/.exec(root.querySelector("h2")?.textContent?.trim() ?? "");
        const more = Array.from(root.querySelectorAll("button")).some(button => button.textContent?.trim() === "Load more");
        return heading && Number(heading[1]) === expected && (more || root.querySelectorAll('[class*="_comment-main_"]').length === expected);
      }, observedCommentCount, { timeout: timeoutMs }).catch(() => { throw new AwsSiteError("state_unknown", "Comment history is still loading or differs from the current server count."); });
      const snapshot = await commentsSnapshot();
      checkBudget();
      let invalid = snapshot.expected === null || snapshot.expected !== observedCommentCount;
      for (const comment of snapshot.comments) {
        const authors = new Set<string>();
        for (const raw of comment.authors) {
          try { authors.add(canonicalProfileUrl(raw)); } catch { invalid = true; }
        }
        if (authors.size !== 1 || comment.body === null) invalid = true;
        if (authors.has(ownProfile) && (!verifyText || normalized(comment.body ?? "") === normalized(verifyText))) {
          return { commented: true, complete: false };
        }
        if (comment.replies.length !== 1 || comment.replies[0] !== "Reply 0" || comment.nested) invalid = true;
      }
      if (!snapshot.loadMore) {
        if (invalid || snapshot.busy || snapshot.comments.length !== snapshot.expected) {
          throw new AwsSiteError("state_unknown", "Complete comment history could not be verified; this post is skipped.");
        }
        return { commented: false, complete: true };
      }
      if (index === maxCommentPages) throw new AwsSiteError("state_unknown", "The comment history exceeds the configured inspection limit.");
      const previous = snapshot.comments.length;
      const more = page.locator("#comments").getByRole("button", { name: "Load more", exact: true });
      if (await more.count() !== 1) throw new AwsSiteError("state_unknown", "Comment pagination is ambiguous.");
      await more.click();
      await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: COMMENT_SELECTOR, count: previous }, { timeout: timeoutMs }).catch(() => { throw new AwsSiteError("state_unknown", "Comment pagination did not make progress."); });
      checkBudget();
    }
    throw new AwsSiteError("state_unknown", "Comment history cannot be verified.");
  }

  async function inspectCandidate(candidate: AwsCandidate): Promise<AwsCandidateInspection> {
    const url = canonicalContentUrl(candidate.url);
    if (!url) throw new AwsSiteError("state_unknown", "Only inspected Builder article URLs can be processed.");
    await navigate(url);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible", timeout: timeoutMs });
    const liked = await ownLikeState();
    // An existing like already makes this candidate ineligible; no exhaustive comment scan is needed.
    if (liked) return { liked: true, commented: false, excerpt: "", commentsComplete: false };
    const comments = await readComments();
    const excerpt = normalized(await page.locator("main").innerText()).slice(0,2000);
    return { liked, commented: comments.commented, excerpt, commentsComplete: comments.complete };
  }

  async function likeAndVerify(candidate: AwsCandidate): Promise<"verified" | "already_done"> {
    const before = await inspectCandidate(candidate);
    if (before.liked) return "already_done";
    if (before.commented) throw new AwsSiteError("already_done", "You already commented on this post; it was skipped before liking.");
    if (!before.commentsComplete) throw new AwsSiteError("state_unknown", "Comment history is incomplete.");
    await requireIdentity(page, profile, timeoutMs);
    if (await ownLikeState()) return "already_done";
    if ((await readComments()).commented) throw new AwsSiteError("already_done", "You already commented on this post; it was skipped before liking.");
    const like = page.locator(profile.likeSelector).first();
    await options.beforeSubmit?.();
    try {
      await like.click({ timeout: timeoutMs });
      await page.waitForFunction(selector => {
        // AWS's top and bottom toolbars hold independent optimistic state.
        // Confirm the clicked control, then verify persistence with a fresh API read.
        return document.querySelector(selector)?.getAttribute("aria-pressed") === "true";
      }, profile.likeSelector, { timeout: timeoutMs });
      // A reload confirms server persistence; an optimistic pressed state alone is insufficient.
      await navigate(canonicalContentUrl(candidate.url)!);
      if (!(await ownLikeState())) throw new Error("like not persisted");
      return "verified";
    } catch {
      throw new AwsSiteError("action_uncertain", "A like was attempted but its persisted result could not be confirmed. It will not be clicked again automatically.");
    }
  }

  async function commentAndVerify(candidate: AwsCandidate, text: string): Promise<"verified" | "already_done"> {
    if (!normalized(text) || text.length > 1000) throw new AwsSiteError("state_unknown", "The configured comment must contain 1–1000 characters.");
    const url = canonicalContentUrl(candidate.url);
    if (!url) throw new AwsSiteError("state_unknown", "Invalid article URL.");
    await navigate(url);
    const existing = await readComments();
    if (existing.commented) return "already_done";
    if (!existing.complete || !(await ownLikeState())) throw new AwsSiteError("state_unknown", "A persisted like and complete comment history are required before commenting.");
    await requireIdentity(page, profile, timeoutMs);
    const editor = await uniqueVisible(page.locator(profile.commentEditorSelector), "comment editor", timeoutMs);
    await assertFingerprint(editor, profile.controls?.editor, "comment editor");
    await assertComposer(page, profile);
    const currentText = await editor.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent);
    if (normalized(currentText ?? "")) throw new AwsSiteError("state_unknown", "A comment draft already exists; automatic submission stopped.");
    await editor.fill(text, { timeout: timeoutMs });
    const submit = await uniqueVisible(page.locator(profile.commentSubmitSelector), "comment submit button", timeoutMs);
    await requireIdentity(page, profile, timeoutMs);
    await assertFingerprint(submit, profile.controls?.submit, "comment submit button");
    await assertComposer(page, profile);
    if (!(await submit.isEnabled())) throw new AwsSiteError("state_unknown", "The recorded comment submit button is disabled.");
    // Filling an editor can take time. Check for an own comment arriving during
    // that interval before the submit boundary, without republishing a draft.
    if (!(await ownLikeState())) throw new AwsSiteError("state_unknown", "The persisted like changed before commenting.");
    if ((await readComments()).commented) return "already_done";
    await requireIdentity(page, profile, timeoutMs);
    await assertFingerprint(submit, profile.controls?.submit, "comment submit button");
    await assertComposer(page, profile);
    if (!(await submit.isEnabled())) throw new AwsSiteError("state_unknown", "The comment submit button became disabled.");
    await options.beforeSubmit?.();
    try {
      await submit.click({ timeout: timeoutMs });
      await page.waitForFunction(({ selector, account, body, text }) => Array.from(document.querySelectorAll(selector)).some(comment => {
        const own = Array.from(comment.querySelectorAll('[data-module-id="profile"] a[href]')).some(link => new URL(link.getAttribute("href") ?? "", location.origin).href.replace(/\/$/, "") === account);
        return own && comment.querySelector(body)?.textContent?.replace(/\s+/g, " ").trim() === text;
      }), { selector: COMMENT_SELECTOR, account: ownProfile, body: BODY_SELECTOR, text: normalized(text) }, { timeout: timeoutMs });
      await navigate(url);
      const persisted = await readComments(text);
      if (!persisted.commented) throw new Error("comment not persisted");
      return "verified";
    } catch {
      throw new AwsSiteError("action_uncertain", "A comment was submitted but its persisted result could not be confirmed. It will not be submitted again automatically.");
    }
  }

  return {
    async checkAuthentication() {
      checkBudget();
      if (page.url() !== "about:blank" && new URL(page.url()).origin !== ORIGIN) {
        throw new AwsSiteError("auth_required", "AWS sign-in is required.");
      }
      // Reload existing AWS documents too: readiness must observe this load,
      // rather than trusting activity rendered before the driver was created.
      await navigate(page.url() === "about:blank" ? ORIGIN : page.url());
      return true;
    },
    async discoverCandidates(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AwsSiteError("state_unknown", "Candidate limit must be between 1 and 100.");
      await navigate(ORIGIN);
      const latest = page.locator('main button[data-testid="latest"]');
      const hasLatest = await latest.count() === 1;
      if (hasLatest) {
        const tab = await latest.evaluate(element => ({ text: element.textContent?.trim(), pressed: element.getAttribute("aria-pressed") }));
        if (tab.text !== "Latest" || !["false", "true"].includes(tab.pressed ?? "")) throw new AwsSiteError("state_unknown", "The observed Latest feed control changed.");
        if (tab.pressed !== "true") {
          readiness.begin();
          await latest.click();
        }
        await page.waitForFunction(() => document.querySelector('main button[data-testid="latest"]')?.getAttribute("aria-pressed") === "true", undefined, { timeout: timeoutMs });
        // Feed fetching can begin after the tab transition. Wait for actual
        // article links rather than allowing Spotlight to mask an empty feed.
        await page.locator('main [role="feed"] a[href^="/content/"]').first().waitFor({ state: "visible", timeout: timeoutMs });
        await settlePage();
      }
      const feeds = page.locator('main [role="feed"]').filter({ has: page.locator('a[href^="/content/"]') });
      const scope = await feeds.count() === 1 ? feeds : page.locator("main");
      await scope.locator('a[href^="/content/"]').first().waitFor({ state: "visible", timeout: timeoutMs });
      const found = new Map<string, AwsCandidate>();
      for (let index = 0; index < maxDiscoveryPages; index++) {
        checkBudget();
        const links = await scope.locator('a[href^="/content/"]').evaluateAll(elements => elements.map(element => ({ url: element.getAttribute("href") ?? "", title: element.textContent ?? "" })));
        for (const link of links) {
          const url = canonicalContentUrl(link.url);
          const title = normalized(link.title);
          if (url && title && !/^\d+$/.test(title) && !found.has(url)) found.set(url, { url, title: title.slice(0,300) });
        }
        if (found.size >= limit || index === maxDiscoveryPages - 1) break;
        const more = scope.getByRole("button", { name: "Load more", exact: true });
        if (await more.count() !== 1 || !(await more.isVisible())) break;
        const previous = await scope.locator('a[href^="/content/"]').count();
        await more.click();
        await page.waitForFunction(({ count, inFeed }) => document.querySelectorAll(inFeed ? 'main [role="feed"] a[href^="/content/"]' : 'main a[href^="/content/"]').length > count, { count: previous, inFeed: await feeds.count() === 1 }, { timeout: timeoutMs });
      }
      return [...found.values()].slice(0, limit);
    },
    inspectCandidate,
    likeAndVerify,
    commentAndVerify
  };
}
