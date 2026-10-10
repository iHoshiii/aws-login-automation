import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { builderIdEmail, GoogleCaptureLoginRejectedError, hasSignedInBuilderHeader, startBuilderIdLogin, waitForSignedInBuilder } from "@/lib/aws/login";

describe("Builder ID connection login", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });

  it("starts the observed Builder ID flow with the configured email without handling a password", async () => {
    page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `
      <button onclick="document.querySelector('[role=dialog]').hidden=false">Sign in</button>
      <div role="dialog" hidden><h2>Sign in to join the community</h2>
        <label for="email">Email</label><input id="email" type="email" autocomplete="email">
        <button id="continue">Continue with Builder ID</button></div>
      <script>document.querySelector('#continue').onclick=()=>window.recordLogin(document.querySelector('#email').value);</script>` }));
    const record = vi.fn();
    await page.exposeFunction("recordLogin", record);
    await page.goto("https://builder.aws.com/");
    await startBuilderIdLogin(page, "  OWNER@example.com ", 3000);
    await vi.waitFor(() => expect(record).toHaveBeenCalledExactlyOnceWith("owner@example.com"));
    expect(await page.locator('input[type="password"]').count()).toBe(0);
  });

  it("refuses to fill an email on an unexpected website", async () => {
    page = await browser.newPage();
    await page.setContent('<input type="email"><button>Continue with Builder ID</button>');
    await expect(startBuilderIdLogin(page, "owner@example.com")).rejects.toThrow("Open AWS Builder Center");
    expect(await page.locator("input").inputValue()).toBe("");
  });

  it("normalizes the account email and rejects malformed input", () => {
    expect(builderIdEmail("OWNER@example.com ")).toBe("owner@example.com");
    expect(() => builderIdEmail("owner\n@example.com")).toThrow();
    expect(() => builderIdEmail("not-an-email")).toThrow();
  });
  it.each([
    { markup: '<header></header><main><a href="/community/@author">Article author</a></main>', signedIn: false },
    { markup: '<header><a href="/community/@owner">My profile</a></header>', signedIn: true },
    { markup: '<header><button>Sign in</button><a href="/community/@owner">Profile</a></header>', signedIn: false },
    { markup: '<header><a href="/community/@owner">Profile</a><a href="/community/@another">Other profile</a></header>', signedIn: false }
  ])("requires positive, unambiguous signed-in account evidence: %j", async example => {
    page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: example.markup }));
    await page.goto("https://builder.aws.com/");
    expect(await hasSignedInBuilderHeader(page)).toBe(example.signedIn);
  });
});

describe("manual connection session verification", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
  afterAll(async () => { await browser?.close(); });

  async function setup() {
    const context = await browser.newContext();
    contexts.push(context);
    return context;
  }

  async function fixture(context: BrowserContext, url: string, markup: string) {
    const page = await context.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: markup }));
    await page.goto(url);
    return page;
  }

  it.each([
    { menu: '<div role="menu"><a role="menuitem" href="/profile">Manage profile</a><a role="menuitem" href="/profile/content">Manage content</a><span role="menuitem">Sign out</span></div>', signedIn: true },
    { menu: '<a href="/profile">Manage profile</a><div role="menu"><span role="menuitem">Sign out</span></div>', signedIn: false },
    { menu: '<div role="menu"><a role="menuitem" href="/profile">Manage profile</a></div><div role="menu"><span role="menuitem">Sign out</span></div>', signedIn: false },
    { menu: '<div role="menu"><a role="menuitem" href="/profile/content">Manage profile</a><span role="menuitem">Sign out</span></div>', signedIn: false }
  ])("requires the observed self-profile and Sign out controls in the same menu: %j", async example => {
    const context = await setup();
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<main><h1>Fixture owner</h1><a href="/edit/profile">Edit information</a><button onclick="document.querySelector(\'[role=dialog]\').hidden=false">QR code</button></main><div role="dialog" hidden>QR code Alias: @owner20 <button>Download QR code</button></div>' }));
    const page = await fixture(context, "https://builder.aws.com/", `<header>${example.menu}</header><main><a href="/community/@article-author">Article author</a></main>`);
    expect(await hasSignedInBuilderHeader(page)).toBe(example.signedIn);
    expect(context.pages()).toEqual([page]);
  });

  it("does not accept an account menu when the self-profile ownership marker points elsewhere", async () => {
    const context = await setup();
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<main><a href="/edit/someone-else">Edit information</a><button>QR code</button></main>' }));
    const page = await fixture(context, "https://builder.aws.com/", '<header><div role="menu"><a role="menuitem" href="/profile">Manage profile</a><span role="menuitem">Sign out</span></div></header>');
    expect(await hasSignedInBuilderHeader(page)).toBe(false);
    expect(context.pages()).toEqual([page]);
  });

  it("stops capture on Google's rejected URL when no signed-in AWS account is observed", async () => {
    const context = await setup();
    await fixture(context, "https://builder.aws.com/", '<header><button>Sign in</button></header>');
    const rejected = await fixture(context, "https://accounts.google.com/v3/signin/rejected?fixture-only-state=1", '<h1>Sign-in rejected</h1><label for="email">Email or phone</label><input id="email" type="email"><button>Next</button>');
    await expect(waitForSignedInBuilder(context, 1000, 20)).rejects.toBeInstanceOf(GoogleCaptureLoginRejectedError);
    expect(await rejected.locator("#email").inputValue()).toBe("");
  });

  it.each(["rejected", "aws"])("returns a verified AWS account despite a stale rejected tab (%s first)", async first => {
    const context = await setup();
    let aws: Page | undefined;
    for (const kind of first === "rejected" ? ["rejected", "aws"] : ["aws", "rejected"]) {
      if (kind === "rejected") {
        await fixture(context, "https://accounts.google.com/v3/signin/rejected", "<h1>Sign-in rejected</h1>");
      } else {
        aws = await fixture(context, "https://builder.aws.com/", '<header><a href="/community/@owner">My profile</a></header>');
      }
    }
    expect(await waitForSignedInBuilder(context, 1000, 20)).toBe(aws);
  });

  it.each([
    "https://accounts.google.com.attacker.example/v3/signin/rejected",
    "https://accounts.google.com/v3/signin/identifier"
  ])("does not classify another origin or Google sign-in step as browser rejection: %s", async url => {
    const context = await setup();
    await fixture(context, url, '<h1>Sign-in rejected</h1>');
    const error = await waitForSignedInBuilder(context, 80, 20).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GoogleCaptureLoginRejectedError);
  });
});
