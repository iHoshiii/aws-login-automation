import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { isSelfProfileUrl, readSignedInSelfProfile, SelfProfileIdentityError } from "@/lib/aws/identity";

const origin = "https://builder.aws.com";
const ownProfile = `${origin}/community/@owner20`;
const editLink = '<a href="/edit/profile">Edit information</a>';
const qrButton = '<button id="qr" aria-label="QR code">QR code</button>';
const aliasDialog = '<div id="profile-qr" role="dialog" hidden><h2>Profile QR code</h2><p>Alias: @owner20</p></div>';

type FixtureOptions = {
  header?: string;
  main?: string;
  dialogs?: string;
  extra?: string;
  redirect?: string;
};

// All browser requests are fulfilled locally. The self-profile controls and
// aliases are synthetic; no AWS session or real account details are used.
describe("signed-in self-profile identity", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
  afterAll(async () => { await browser?.close(); });

  async function fixture(options: FixtureOptions = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    await context.route("**/*", async route => {
      if (options.redirect && route.request().url() === `${origin}/profile`) {
        await route.fulfill({ status: 302, headers: { location: options.redirect } });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
        <header>${options.header ?? '<a href="/community/@article-author">An article author</a>'}</header>
        <main><h1>My profile</h1>${options.main ?? `${editLink}${qrButton}`}</main>
        ${options.dialogs ?? aliasDialog}${options.extra ?? ""}
        <script>
          document.querySelectorAll('button[aria-label="QR code"]').forEach(button => {
            button.addEventListener('click', () => {
              document.querySelectorAll('[role="dialog"][data-open], #profile-qr').forEach(dialog => { dialog.hidden = false; });
            });
          });
        </script>
      </body></html>` });
    });
    const existingPage = await context.newPage();
    await existingPage.goto(`${origin}/content/FixtureArticle`);
    return { context, existingPage };
  }

  function expectTemporaryPageClosed(context: BrowserContext, existingPage: Page) {
    expect(existingPage.isClosed()).toBe(false);
    expect(context.pages()).toEqual([existingPage]);
  }

  async function expectRejected(options: FixtureOptions) {
    const { context, existingPage } = await fixture(options);
    const error = await readSignedInSelfProfile(context, 1000).catch(error => error);
    expect(error).toBeInstanceOf(SelfProfileIdentityError);
    expectTemporaryPageClosed(context, existingPage);
  }

  it("reads the owner's QR alias and closes only its temporary page", async () => {
    const { context, existingPage } = await fixture();
    const openedUrls: string[] = [];
    context.on("page", page => page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) openedUrls.push(frame.url());
    }));

    expect(await readSignedInSelfProfile(context, 2000)).toBe(ownProfile);
    expect(openedUrls).toContain(`${origin}/profile`);
    expectTemporaryPageClosed(context, existingPage);
  });

  it("ignores hidden controls and aliases outside the visible QR dialog", async () => {
    const { context, existingPage } = await fixture({
      header: '<button hidden>Sign in</button><a href="/community/@article-author">An article author</a>',
      main: `${editLink}${qrButton}<a hidden href="/edit/profile">Edit information</a><button hidden aria-label="QR code">QR code</button><p>Alias: @article-author</p>`,
      extra: '<div role="dialog" hidden><p>Alias: @hidden-account</p></div>'
    });
    expect(await readSignedInSelfProfile(context, 2000)).toBe(ownProfile);
    expectTemporaryPageClosed(context, existingPage);
  });

  it("waits for the authenticated self-edit controls after the initial signed-out render", async () => {
    const { context, existingPage } = await fixture({
      header: '<button id="initial-sign-in">Sign in</button>',
      main: '<p>Loading profile</p>',
      extra: `<script>setTimeout(() => {
        document.querySelector('#initial-sign-in').remove();
        document.querySelector('main').innerHTML = '<h1>My profile</h1><a href="/edit/profile">Edit information</a><button id="hydrated-qr">QR code</button>';
        document.querySelector('#hydrated-qr').onclick = () => { document.querySelector('[role=dialog]').hidden = false; };
      }, 150);</script>`
    });
    expect(await readSignedInSelfProfile(context, 2000)).toBe(ownProfile);
    expectTemporaryPageClosed(context, existingPage);
  });

  it("reads the owner's alias after hydration selects the observed badges view", async () => {
    const { context, existingPage } = await fixture({
      header: '<button id="initial-sign-in">Sign in</button>',
      main: '<p>Loading profile</p>',
      extra: `<script>setTimeout(() => {
        if (location.pathname !== '/profile') return;
        document.querySelector('#initial-sign-in').remove();
        document.querySelector('main').innerHTML = '<h1>My profile</h1><a href="/edit/profile">Edit information</a><button id="hydrated-qr">QR code</button>';
        document.querySelector('#hydrated-qr').onclick = () => { document.querySelector('[role=dialog]').hidden = false; };
        history.replaceState(null, '', '/profile?tab=badges');
      }, 150);</script>`
    });
    const openedUrls: string[] = [];
    context.on("page", page => page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) openedUrls.push(frame.url());
    }));
    expect(await readSignedInSelfProfile(context, 2000)).toBe(ownProfile);
    expect(openedUrls).toContain(`${origin}/profile?tab=badges`);
    expectTemporaryPageClosed(context, existingPage);
  });

  it.each([
    "?tab=unknown",
    "?tab=badges&extra=1",
    "?tab=badges&tab=badges",
    "?other=badges",
    "?tab=badges#other"
  ])("rejects an unobserved self-profile view applied by replaceState: %s", async query => {
    await expectRejected({ extra: `<script>if (location.pathname === '/profile') history.replaceState(null, '', '/profile${query}');</script>` });
  });

  it("keeps recorded Manage profile destinations free of view parameters", () => {
    expect(isSelfProfileUrl("/profile")).toBe(true);
    expect(isSelfProfileUrl("/profile?tab=badges")).toBe(false);
  });

  it.each([
    { name: "missing", main: qrButton },
    { name: "outside main", main: qrButton, extra: editLink },
    { name: "wrong exact label", main: `<a href="/edit/profile">Edit information for this profile</a>${qrButton}` },
    { name: "public profile destination", main: `<a href="/community/@article-author">Edit information</a>${qrButton}` },
    { name: "foreign destination", main: `<a href="https://other.example/edit/profile">Edit information</a>${qrButton}` },
    { name: "non-anchor control", main: `<button role="link" href="/edit/profile">Edit information</button>${qrButton}` },
    { name: "ambiguous visible markers", main: `${editLink}${editLink}${qrButton}` }
  ])("rejects an unverified self-edit marker: $name", async options => {
    await expectRejected(options);
  });

  it("rejects a visible Sign in button despite the self-edit marker", async () => {
    await expectRejected({ header: '<button>Sign in</button>' });
  });

  it.each([
    { name: "missing", main: editLink },
    { name: "outside main", main: editLink, extra: qrButton },
    { name: "ambiguous visible controls", main: `${editLink}${qrButton}${qrButton}` }
  ])("rejects an unverified QR control: $name", async options => {
    await expectRejected(options);
  });

  it.each([
    { name: "missing alias", text: "Profile information" },
    { name: "missing at sign", text: "Alias: owner20" },
    { name: "invalid slash", text: "Alias: @owner20/other" },
    { name: "invalid encoded alias", text: "Alias: @owner%20" },
    { name: "two different aliases", text: "Alias: @owner20<br>Alias: @another-owner" },
    { name: "repeated alias", text: "Alias: @owner20<br>Alias: @owner20" }
  ])("rejects an invalid or ambiguous dialog alias: $name", async ({ text }) => {
    await expectRejected({ dialogs: `<div id="profile-qr" role="dialog" hidden><p>${text}</p></div>` });
  });

  it("requires exactly one visible QR dialog", async () => {
    await expectRejected({ dialogs: `${aliasDialog}<div role="dialog" data-open hidden><p>Alias: @another-owner</p></div>` });
  });

  it.each([
    "https://other.example/profile",
    "https://builder.aws.com.attacker.example/profile",
    `${origin}/community/@article-author`,
    `${origin}/profile/details`
  ])("rejects a final location outside the exact self-profile page: %s", async redirect => {
    await expectRejected({ redirect });
  });
});
