import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import type { Page } from "playwright-core";
import { AWS_BROWSER_VIEWPORT, launchAwsBrowser } from "../lib/aws/browser";
import { captureSiteProfile } from "../lib/aws/site";
import { readSignedInSelfProfile } from "../lib/aws/identity";
import { awsOnlyStorageState, encryptSession, generateSessionKey } from "../lib/aws/session";
import { postUrl } from "../lib/validation";
import { installControlPicker } from "../lib/aws/control-picker";
import { loadLocalAwsEnvironment } from "../lib/aws/local-environment";
import { builderIdEmail, GoogleCaptureLoginRejectedError, hasSignedInBuilderHeader, startBuilderIdLogin, waitForSignedInBuilder } from "../lib/aws/login";
import { assistFederatedLogin } from "../lib/aws/federated-login";
import { attachManualChrome, openManualChrome, waitForManualChromeClosed } from "../lib/aws/manual-browser";

loadLocalAwsEnvironment();

const terminal = createInterface({ input, output });
let selected: { selector: string; href: string | null } | undefined;

// Record a selector from a control the owner actually chooses. The selection click
// is intercepted before AWS receives it; picking the submit button publishes nothing.
async function pick(page: Page, label: string, kind: "button" | "account" | "editor"): Promise<{ selector: string; href: string | null }> {
  selected = undefined;
  console.log(label);
  await installControlPicker(page, label, kind);
  const expires = Date.now() + 5 * 60_000;
  while (!selected && !page.isClosed() && Date.now() < expires) await page.waitForTimeout(250);
  const captured = selected as { selector: string; href: string | null } | undefined;
  if (!captured) throw new Error("Control selection ended before a control was recorded. Restart the connection helper.");
  await page.waitForTimeout(750);
  return captured;
}

async function main() {
  console.log("Connect your own AWS Builder ID. Complete login/MFA yourself in the browser. This helper performs no likes or comments.");
  const email = builderIdEmail(process.env.AWS_BUILDER_ID_EMAIL || await terminal.question("Your AWS Builder ID email: "));
  const manualBrowser = process.argv.includes("--manual-browser");
  let connection: Awaited<ReturnType<typeof attachManualChrome>> | undefined;
  try {
    let page: Page;
    if (manualBrowser) {
      console.log(`Login phase: opening normal Chrome for ${email}. Complete AWS sign-in, including GitHub Continue with Google and your passkey or MFA, in this first window. Keep it open until AWS Builder Center shows your signed-in account.`);
      const login = await openManualChrome();
      await terminal.question("After your passkey or MFA is complete and you can see your signed-in AWS account, close this dedicated Chrome window and its popups, then press Enter here. ");
      console.log("Waiting for the dedicated login window to close before capturing the completed AWS connection.");
      await waitForManualChromeClosed(login.process, 10 * 60_000);
      console.log("Capture phase: reopening the completed AWS session. Open your account menu so your profile or Manage profile link is visible. If you see Sign in, close this capture window and restart manual login.");
      connection = await attachManualChrome(login);
      page = await waitForSignedInBuilder(connection.context);
    } else {
      const automated = await launchAwsBrowser({ headless: false });
      connection = { ...automated, close: () => automated.browser.close() };
      page = await automated.context.newPage();
      await page.goto("https://builder.aws.com/", { waitUntil: "domcontentloaded" });
      try {
        await startBuilderIdLogin(page, email);
        console.log("Builder ID sign-in started with your configured email. Complete password, passkey or MFA prompts directly in the browser.");
      } catch {
        console.log("Automatic email entry could not be confirmed. Use Sign in in the AWS browser and sign in with your configured Builder ID email.");
      }
      console.log("The helper will follow available GitHub/Google sign-in controls and wait for the AWS account to appear. On AWS, open your account menu so your profile or Manage profile link is visible.");
      const login = await assistFederatedLogin(automated.context, {
        email, startPage: page, isBuilderSignedIn: hasSignedInBuilderHeader,
        onStatus: result => { console.log(result.message); }
      });
      if (login.state !== "login_returned" || !login.page) {
        console.log("For Google sign-in rejected by the test browser, run npm run aws:connect -- --manual-browser to complete the one-time login in normal Chrome.");
        throw new Error("AWS sign-in was not verified.");
      }
      page = login.page;
    }
    const { context } = connection;
    await page.setViewportSize(AWS_BROWSER_VIEWPORT);
    // OAuth may return to another page. Bind the picker to that actual AWS page.
    await page.exposeFunction("recordAwsControl", (value: { selector: string; href: string | null }) => { selected = value; });
    await page.keyboard.press("Escape");
    const url = postUrl(await terminal.question("Paste an article URL where you can see an empty comment editor: "));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await terminal.question("Wait for the article to finish loading, then press Enter. ");
    const opener = await pick(page, "Click your account/profile menu button in the header", "button");
    const safeOpener = await page.locator(opener.selector).evaluate(element => element.tagName === "BUTTON" && !!element.closest('header,[role="banner"]'));
    if (!safeOpener) throw new Error("Select an account menu button in the page header.");
    await page.locator(opener.selector).click();
    const account = await pick(page, "Click your own profile or Manage profile link inside the account menu", "account");
    let accountProfileUrl: string;
    let identitySource: "self_profile" | undefined;
    if (account.href && /^https:\/\/builder\.aws\.com\/community\/@[A-Za-z0-9_.-]+\/?$/.test(account.href)) {
      accountProfileUrl = account.href.replace(/\/$/, "");
    } else if (account.href && /^https:\/\/builder\.aws\.com\/profile\/?$/.test(account.href)) {
      const ownProfileLink = await page.locator(account.selector).evaluate(element =>
        element.tagName === "A" && !!element.closest('header,[role="banner"],[role="menu"]') &&
        element.textContent?.replace(/\s+/g, " ").trim() === "Manage profile"
      );
      if (!ownProfileLink) throw new Error("Select Manage profile inside your signed-in account menu.");
      accountProfileUrl = await readSignedInSelfProfile(context);
      identitySource = "self_profile";
    } else {
      throw new Error("Select your own profile or Manage profile link inside the account menu.");
    }
    await page.keyboard.press("Escape");
    await terminal.question("Close the account menu if necessary and scroll to the empty comment editor, then press Enter. ");
    const editor = await pick(page, "Click the empty comment editor", "editor");
    const submit = await pick(page, "Click the comment submit button (selection only; nothing is posted)", "button");
    const profile = await captureSiteProfile(page, {
      accountProfileUrl, accountSelector: account.selector, ...(identitySource ? { identitySource } : {}),
      accountMenuSelector: opener.selector, commentEditorSelector: editor.selector, commentSubmitSelector: submit.selector
    });
    const state = awsOnlyStorageState(await context.storageState({ indexedDB: true }));
    const key = generateSessionKey();
    const encrypted = encryptSession({ version: 1, capturedAt: new Date().toISOString(), builderIdEmail: email, storageState: state, profile }, key);
    const directory = resolve(".local");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "aws-session.env"), `AWS_SESSION_KEY=${key}\nAWS_SESSION_ENCRYPTED=${encrypted}\n`, { mode: 0o600 });
    console.log("Saved encrypted connection values in .local/aws-session.env (ignored by Git). Copy both values privately into .env.local or Vercel server-only environment variables. Secrets were not printed.");
    console.log("Next run npm run aws:probe for a read-only account and candidate check.");
  } finally { await connection?.close(); }
}

try { await main(); } catch (error) {
  console.error(error instanceof GoogleCaptureLoginRejectedError
    ? error.message
    : "Connection could not be completed. Finish browser login and account verification before selecting controls. If Google rejects the test browser, use npm run aws:connect -- --manual-browser. No AWS engagement was submitted.");
  process.exitCode = 1;
} finally { terminal.close(); }
