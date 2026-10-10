import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { assistFederatedLogin, type FederatedLoginOptions } from "@/lib/aws/federated-login";

const email = "authorized-owner@example.com";
const githubUrl = "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize%3Fstate%3Dfixture-only-state";
const googleUrl = "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fgithub.com%2Ffixture-callback";
const builderUrl = "https://builder.aws.com/";
const builderHtml = '<header><button>Recorded owner account menu</button></header><h1>Builder Center</h1>';

// Synthetic OAuth fixtures only. GitHub Continue with Google and Google's
// Email or phone/Next names were inspected on their public real login pages.
// Google account-chooser/passkey screens below are synthetic; passkey names
// require an explicitly supplied actual observation, never a guessed default.
describe("federation assistance with isolated synthetic browser pages", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
  afterAll(async () => { await browser?.close(); });

  async function setup(html: string, url = githubUrl, responses: Record<string,string> = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    const actions: Array<{ action: string; value?: string; url?: string }> = [];
    await context.exposeFunction("recordAction", (action: string, value?: string, currentUrl?: string) => { actions.push({ action, value, url: currentUrl }); });
    await context.route("**/*", route => {
      const address = route.request().url();
      const key = `${new URL(address).origin}${new URL(address).pathname}`;
      return route.fulfill({ contentType: "text/html", body: responses[key] ?? (key === builderUrl ? builderHtml : html) });
    });
    const page = await context.newPage();
    await page.goto(url);
    return { context, page, actions };
  }

  const options = (page: Page, extra: Partial<FederatedLoginOptions> = {}): FederatedLoginOptions => ({
    email, startPage: page, timeoutMs: 1500, pollMs: 25,
    isBuilderSignedIn: async returned => returned.getByRole("button", { name: "Recorded owner account menu", exact: true }).isVisible(),
    ...extra
  });

  it("clicks the observed GitHub Google control and preserves the OAuth return URL", async () => {
    const { context, page, actions } = await setup(`<button onclick="window.recordAction('github',undefined,location.href).then(()=>location.assign('${builderUrl}'))">Continue with Google</button>`);
    const result = await assistFederatedLogin(context, options(page));
    expect(result.state).toBe("login_returned");
    expect(result.page).toBe(page);
    expect(actions).toEqual([{ action: "github", value: undefined, url: githubUrl }]);
  });

  it.each(["text", "email"])("fills only the observed Google identifier and clicks Next once (type=%s)", async type => {
    const { context, page, actions } = await setup(`<label for="email">Email or phone</label><input id="email" type="${type}" autocomplete="username"><input type="password"><button onclick="window.recordAction('next',document.querySelector('#email').value,location.href).then(()=>location.assign('${builderUrl}'))">Next</button>`, googleUrl);
    expect((await assistFederatedLogin(context, options(page))).state).toBe("login_returned");
    expect(actions).toEqual([{ action: "next", value: email, url: googleUrl }]);
  });

  it("selects the exact authorized own-email account and leaves other accounts untouched", async () => {
    const { context, page, actions } = await setup(`<h1>Choose an account</h1><button onclick="window.recordAction('other')">another@example.com</button><button onclick="window.recordAction('own').then(()=>location.assign('${builderUrl}'))">${email}</button>`, googleUrl);
    expect((await assistFederatedLogin(context, options(page))).state).toBe("login_returned");
    expect(actions.map(action => action.action)).toEqual(["own"]);
  });

  it("prefers an explicitly observed passkey control and waits for device confirmation", async () => {
    const { context, page, actions } = await setup(`<span>${email}</span><button onclick="window.recordAction('passkey')">Use your passkey</button><label for="email">Email or phone</label><input id="email" type="text" autocomplete="username"><button onclick="window.recordAction('next')">Next</button><label for="password">Password</label><input id="password" type="password">`, googleUrl);
    const statuses: string[] = [];
    const result = await assistFederatedLogin(context, options(page, { timeoutMs: 700, observedGooglePasskeyNames: ["Use your passkey"], onStatus: update => { statuses.push(update.state); } }));
    expect(result.state).toBe("waiting_device");
    expect(actions.map(action => action.action)).toEqual(["passkey"]);
    expect(await page.locator("#email").inputValue()).toBe("");
    expect(await page.locator("#password").inputValue()).toBe("");
    expect(statuses).toEqual(["waiting_device"]);
  });

  it("does not invent an unobserved Google passkey selector", async () => {
    const { context, page, actions } = await setup('<button onclick="window.recordAction(\'passkey\')">Use your passkey</button>', googleUrl);
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 130 }))).state).toBe("manual");
    expect(actions).toEqual([]);
  });

  it("does not initiate a passkey for another Google identity", async () => {
    const { context, page, actions } = await setup('<span>another@example.com</span><button onclick="window.recordAction(\'passkey\')">Use your passkey</button>', googleUrl);
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 250, observedGooglePasskeyNames: ["Use your passkey"] }))).state).toBe("manual");
    expect(actions).toEqual([]);
  });

  it("never clicks or fills on an unexpected origin or non-login GitHub page", async () => {
    for (const url of ["https://accounts.google.com.attacker.example/login", "https://github.com/login/oauth/authorize"]) {
      const { context, page, actions } = await setup(`<label for="email">Email or phone</label><input id="email" type="text" autocomplete="username"><button onclick="window.recordAction('clicked')">Next</button><button onclick="window.recordAction('grant')">Authorize</button><button onclick="window.recordAction('google')">Continue with Google</button>`, url);
      expect((await assistFederatedLogin(context, options(page, { timeoutMs: 130 }))).state).toBe("manual");
      expect(actions).toEqual([]);
      expect(await page.locator("#email").inputValue()).toBe("");
    }
  });

  it("does not retry a GitHub click across polls or repeated monitoring calls", async () => {
    const { context, page, actions } = await setup('<button onclick="window.recordAction(\'github\')">Continue with Google</button>');
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 800 }))).state).toBe("timed_out");
    await assistFederatedLogin(context, options(page, { timeoutMs: 250 }));
    expect(actions.map(action => action.action)).toEqual(["github"]);
  });

  it("does not repeat a Google identifier submission or enter a password", async () => {
    const { context, page, actions } = await setup(`<label for="email">Email or phone</label><input id="email" type="text" autocomplete="username"><label for="password">Password</label><input id="password" type="password"><button onclick="window.recordAction('next',document.querySelector('#email').value)">Next</button>`, googleUrl);
    await assistFederatedLogin(context, options(page, { timeoutMs: 900 }));
    await assistFederatedLogin(context, options(page, { timeoutMs: 250 }));
    expect(actions.map(action => action.action)).toEqual(["next"]);
    expect(await page.locator("#password").inputValue()).toBe("");
  });

  it("tracks a popup while retaining the original OAuth page and query context", async () => {
    const googleHtml = `<label for="email">Email or phone</label><input id="email" type="text" autocomplete="username"><button onclick="window.recordAction('popup-next',document.querySelector('#email').value,location.href).then(()=>location.assign('${builderUrl}'))">Next</button>`;
    const { context, page, actions } = await setup(`<button onclick="window.open('${googleUrl}')">Continue with Google</button>`, githubUrl, { "https://accounts.google.com/v3/signin/identifier": googleHtml });
    const result = await assistFederatedLogin(context, options(page));
    expect(result.state).toBe("login_returned");
    expect(result.page).not.toBe(page);
    expect(page.url()).toBe(githubUrl);
    expect(actions).toEqual([{ action: "popup-next", value: email, url: googleUrl }]);
  });

  it("limits Google federation to one attempt even if a login opens another login popup", async () => {
    const { context, page, actions } = await setup(`<button onclick="window.recordAction('github').then(()=>window.open('${githubUrl}'))">Continue with Google</button>`);
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 800 }))).state).toBe("timed_out");
    expect(actions.map(action => action.action)).toEqual(["github"]);
    expect(context.pages()).toHaveLength(2);
  });

  it("ignores unrelated Google tabs in the same desktop browser context", async () => {
    const { context, page, actions } = await setup(`<button onclick="window.recordAction('github').then(()=>location.assign('${builderUrl}'))">Continue with Google</button>`, githubUrl, { "https://accounts.google.com/v3/signin/identifier": '<label for="email">Email or phone</label><input id="email" type="text" autocomplete="username"><button onclick="window.recordAction(\'unrelated\')">Next</button>' });
    const unrelated = await context.newPage();
    await unrelated.goto(googleUrl);
    expect((await assistFederatedLogin(context, options(page))).state).toBe("login_returned");
    expect(await unrelated.locator("#email").inputValue()).toBe("");
    expect(actions.map(action => action.action)).toEqual(["github"]);
  });

  it("does not mistake an initial Builder home page for an OAuth return", async () => {
    const { context, page } = await setup(builderHtml, builderUrl);
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 130, isBuilderSignedIn: async () => false }))).state).toBe("timed_out");
  });

  it("accepts an already signed-in Builder page only with positive account-header verification", async () => {
    const { context, page } = await setup(builderHtml, builderUrl);
    expect((await assistFederatedLogin(context, options(page))).state).toBe("login_returned");
  });

  it("confirms a Builder root updated by a closing popup without navigating that root", async () => {
    const githubHtml = `<button onclick="window.opener.postMessage('fixture-auth-return','https://builder.aws.com');window.close()">Continue with Google</button>`;
    const rootHtml = `<header><button>Sign in</button></header><script>window.addEventListener('message',event=>{if(event.origin==='https://github.com'&&event.data==='fixture-auth-return')document.querySelector('header').innerHTML='<button>Recorded owner account menu</button>';});</script>`;
    const { context, page } = await setup(rootHtml, builderUrl, { "https://builder.aws.com/": rootHtml, "https://github.com/login": githubHtml });
    await page.evaluate(address => { window.open(address); }, githubUrl);
    const result = await assistFederatedLogin(context, options(page));
    expect(result.state).toBe("login_returned");
    expect(result.page).toBe(page);
    expect(page.url()).toBe(builderUrl);
  });

  it("waits through a manual native AWS IdP step and verifies its Builder callback", async () => {
    const { context, page, actions } = await setup('<button onclick="window.recordAction(\'unsupported\')">Continue with Google</button>', "https://profile.aws.amazon.com/fixture-signin");
    const monitor = assistFederatedLogin(context, options(page));
    await page.waitForTimeout(100);
    await page.goto(builderUrl);
    expect((await monitor).state).toBe("login_returned");
    expect(actions).toEqual([]);
  });

  it("requires a positive observed account-header check after returning to Builder", async () => {
    const { context, page } = await setup(`<button onclick="location.assign('${builderUrl}')">Continue with Google</button>`);
    const result = await assistFederatedLogin(context, options(page, { isBuilderSignedIn: undefined }));
    expect(result.state).toBe("manual");
    expect(result.message).toMatch(/has not been verified/);
  });

  it("stops immediately on the observed Google browser-rejection screen", async () => {
    const { context, page, actions } = await setup('<h1>Couldn’t sign you in</h1><button onclick="window.recordAction(\'retry\')">Next</button>', "https://accounts.google.com/v3/signin/rejected");
    const result = await assistFederatedLogin(context, options(page));
    expect(result.state).toBe("manual");
    expect(result.message).toMatch(/Google rejected this browser sign-in/);
    expect(result.message).toMatch(/AWS account is not connected/);
    expect(actions).toEqual([]);
  });

  it("rejects ambiguous controls and never picks a different configured identity", async () => {
    const { context, page, actions } = await setup('<button onclick="window.recordAction(\'one\')">Continue with Google</button><button onclick="window.recordAction(\'two\')">Continue with Google</button>');
    expect((await assistFederatedLogin(context, options(page, { timeoutMs: 130 }))).state).toBe("manual");
    const otherIdentity = await assistFederatedLogin(context, options(page, { email: "different@example.com" }));
    expect(otherIdentity.state).toBe("manual");
    expect(otherIdentity.message).toMatch(/different configured/);
    expect(actions).toEqual([]);
  });
});
