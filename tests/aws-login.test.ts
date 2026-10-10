import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { builderIdEmail, hasSignedInBuilderHeader, startBuilderIdLogin } from "@/lib/aws/login";

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
