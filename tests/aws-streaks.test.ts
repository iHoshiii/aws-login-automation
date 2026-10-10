import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readAwsStreaks, AwsStreakReadError } from "@/lib/aws/streaks";

const origin = "https://builder.aws.com";
const expectedProfile = `${origin}/community/@fixture-owner`;
const titles = ["30-Day Visit Streak", "30-Day Like Streak", "30-Day Comment Streak", "90-Day Visit Streak"];

describe("read-only owner streak badge observations", () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
  afterAll(async () => { await browser?.close(); });

  async function fixture(options: {
    alias?: string;
    editHref?: string;
    signedOut?: boolean;
    observe?: boolean;
    query?: string;
    progress?: string[];
    wrongTitle?: boolean;
    duplicateDialog?: boolean;
    duplicateCard?: boolean;
    changeOwnerAfterBadge?: boolean;
    paginate?: boolean;
  } = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    const state = { badgeClicks: 0, moreClicks: 0, reads: [] as string[], writes: 0 };
    const progress = options.progress ?? ["7 / 30 days", "4 / 30 days", "2 / 30 days", "8 / 90 days"];
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const cors = {
        "access-control-allow-origin": origin, "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "builder-session-token, content-type"
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.origin === "https://api.builder.aws.com") {
        state.reads.push(`${request.method()} ${url.pathname}`);
        if (url.pathname === "/ams/getEnabledFeatures" && request.method() === "GET") {
          return route.fulfill({ headers: cors, contentType: "application/json", body: "{}" });
        }
        if (url.pathname === "/ums/profile/get" && request.method() === "POST" && request.postData() === "{}") {
          const alias = options.changeOwnerAfterBadge && state.badgeClicks ? "changed-owner" : options.alias ?? "fixture-owner";
          return route.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ profile: { basicInfo: { alias, userId: "fixture-user", builderProfileId: "fixture-profile" } } }) });
        }
        state.writes++;
        return route.fulfill({ status: 403, headers: cors });
      }
      const cards = titles.map((title, index) => `<button data-badge="${index}" aria-label="Fixture badge description"><img alt="${title}"><img alt="${title}" hidden></button>`).join("");
      const initialCards = options.paginate === false ? cards : '<button aria-label="Fixture earned badge"><img alt="7-Day Visit Streak"></button><button id="more">Load more</button>';
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
        <header>${options.signedOut ? "<button>Sign in</button>" : ""}</header>
        <main><a href="${options.editHref ?? "/edit/profile"}">Edit information</a><h2>Activity</h2>
          <button role="tab" data-testid="badges" aria-selected="false" onclick="this.setAttribute('aria-selected','true')">Badges</button>
          <div id="cards">${initialCards}</div>
        </main>
        <div id="badge-dialog" role="dialog" aria-labelledby="dialog-title" hidden><h2 id="dialog-title"></h2><p id="progress"></p><button aria-label="Close modal">×</button></div>
        <script>
          const titles=${JSON.stringify(titles)}, progress=${JSON.stringify(progress)};
          function bindCards(){document.querySelectorAll('[data-badge]').forEach(button=>button.onclick=async()=>{
            await window.badgeClicked();
            document.querySelector('#dialog-title').textContent=${options.wrongTitle ? "'An unrelated badge'" : "titles[Number(button.dataset.badge)]"};
            document.querySelector('#progress').textContent=progress[Number(button.dataset.badge)];
            document.querySelector('#badge-dialog').hidden=false;
            ${options.duplicateDialog ? "document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-label=Other>Other dialog</div>');" : ""}
          });}
          document.querySelector('#more')?.addEventListener('click',async()=>{
            await window.moreClicked();document.querySelector('#cards').innerHTML=${JSON.stringify(cards + (options.duplicateCard ? '<button><img alt="30-Day Visit Streak"></button>' : ""))};bindCards();
          });
          document.querySelector('[aria-label="Close modal"]').onclick=()=>document.querySelector('#badge-dialog').hidden=true;
          bindCards();
          ${options.query ? `if(location.pathname==='/profile')history.replaceState(null,'','/profile${options.query}');` : ""}
          ${options.observe === false ? "" : "fetch('https://api.builder.aws.com/ams/getEnabledFeatures',{credentials:'include',headers:{'builder-session-token':'fixture-signer'}}).then(r=>r.text());"}
        </script>
      </body></html>` });
    });
    await context.exposeFunction("badgeClicked", () => { state.badgeClicks++; });
    await context.exposeFunction("moreClicked", () => { state.moreClicks++; });
    const existingPage = await context.newPage();
    await existingPage.goto(`${origin}/content/ExistingFixture`);
    return { context, existingPage, state };
  }

  function unchangedPage(context: BrowserContext, existingPage: Page) {
    expect(context.pages()).toEqual([existingPage]);
    expect(existingPage.isClosed()).toBe(false);
    expect(existingPage.url()).toBe(`${origin}/content/ExistingFixture`);
  }

  it("reads each actual dialog independently, paginates badges, and performs only account reads", async () => {
    const { context, existingPage, state } = await fixture({ query: "?tab=badges" });
    const summary = await readAwsStreaks(context, expectedProfile, { timeoutMs: 8000 });
    expect(summary).toMatchObject({ visit: { current: 7, total: 30 }, like: { current: 4, total: 30 }, comment: { current: 2, total: 30 }, visit90: { current: 8, total: 90 } });
    expect(Number.isFinite(Date.parse(summary.observedAt))).toBe(true);
    expect(state.badgeClicks).toBe(4);
    expect(state.moreClicks).toBe(1);
    expect(state.reads.filter(read => read === "POST /ums/profile/get").length).toBeGreaterThanOrEqual(9);
    expect(state.writes).toBe(0);
    unchangedPage(context, existingPage);
  });

  it("accepts zero and completed progress without treating awarded badges as the current streak", async () => {
    const { context } = await fixture({ progress: ["0 / 30 days", "30 / 30 days", "0 / 30 days", "90 / 90 days"], paginate: false });
    expect(await readAwsStreaks(context, expectedProfile, { timeoutMs: 8000 })).toMatchObject({ visit: { current: 0 }, like: { current: 30 }, comment: { current: 0 }, visit90: { current: 90 } });
  });

  it.each([
    { alias: "another-owner" },
    { editHref: "/edit/someone-else" },
    { editHref: "https://other.example/edit/profile" },
    { signedOut: true },
    { observe: false },
    { query: "?tab=other" }
  ])("rejects unproven owner identity before opening badge dialogs: %j", async options => {
    const { context, existingPage, state } = await fixture(options);
    await expect(readAwsStreaks(context, expectedProfile, { timeoutMs: 2000 })).rejects.toMatchObject({ code: "auth_required" });
    expect(state.badgeClicks).toBe(0);
    expect(state.writes).toBe(0);
    unchangedPage(context, existingPage);
  });

  it("rejects account drift after a badge opens without returning a partial summary", async () => {
    const { context, existingPage, state } = await fixture({ changeOwnerAfterBadge: true });
    await expect(readAwsStreaks(context, expectedProfile, { timeoutMs: 4000 })).rejects.toMatchObject({ code: "auth_required" });
    expect(state.badgeClicks).toBe(1);
    unchangedPage(context, existingPage);
  });

  it.each(["missing", "7 / 90 days", "31 / 30 days", "-1 / 30 days", "7.5 / 30 days", "7 / 30 days 8 / 30 days", "9007199254740992 / 30 days"])("rejects ambiguous or invalid progress: %s", async invalid => {
    const { context, existingPage } = await fixture({ progress: [invalid, "4 / 30 days", "2 / 30 days", "8 / 90 days"] });
    await expect(readAwsStreaks(context, expectedProfile, { timeoutMs: 4000 })).rejects.toMatchObject({ code: "state_unknown" });
    unchangedPage(context, existingPage);
  });

  it.each([{ wrongTitle: true }, { duplicateDialog: true }, { duplicateCard: true }])("rejects a changed or ambiguous badge control/dialog: %j", async options => {
    const { context, existingPage, state } = await fixture(options);
    const error = await readAwsStreaks(context, expectedProfile, { timeoutMs: 1200 }).catch(error => error);
    expect(error).toBeInstanceOf(AwsStreakReadError);
    expect(error.message).not.toContain("fixture-signer");
    expect(state.writes).toBe(0);
    unchangedPage(context, existingPage);
  });

  it("honors an expired deadline before creating a temporary page", async () => {
    const { context, existingPage, state } = await fixture();
    await expect(readAwsStreaks(context, expectedProfile, { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: "state_unknown" });
    expect(state.badgeClicks).toBe(0);
    unchangedPage(context, existingPage);
  });
});
