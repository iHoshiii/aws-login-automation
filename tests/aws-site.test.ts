import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { canonicalContentUrl, canonicalProfileUrl, captureSiteProfile, createAwsSiteDriver, type SiteProfile } from "@/lib/aws/site";

const origin = "https://builder.aws.com";
const candidate = { url: `${origin}/content/RecordedId`, title: "An observed article" };
const own = `${origin}/community/@fixture-account`;
type Comment = { author: string; text: string; replies?: number };
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

// These controls are a local fixture based on the inspected public DOM. The
// authenticated composer and identity are synthetic; no real AWS request is made.
async function fixture(browser: Browser, options: { liked?: boolean; comments?: Comment[]; pageSize?: number; persistLike?: boolean; persistComment?: boolean; auth?: boolean; identitySource?: "self_profile"; recommendations?: boolean; backgroundRequests?: boolean; ssrUnliked?: boolean; hiddenOwnComment?: boolean; independentToolbars?: boolean; lazyComments?: boolean; activity?: "delayed" | "hanging" | "failed" | "aborted" | "http_failed" } = {}) {
  const page = options.identitySource ? await (await browser.newContext()).newPage() : await browser.newPage();
  const state = { liked: options.liked ?? false, comments: options.comments ?? [], likeAttempts: 0, commentAttempts: 0, recommendationAttempts: 0, latestAttempts: 0, selfAlias: "fixture-account" };
  const pageSize = options.pageSize ?? 10;
  const markup = (comment: Comment) => `<div class="_comment-main_recorded"><div data-module-id="profile"><a href="${escapeHtml(comment.author)}">Author</a></div><div class="_comment-content_recorded"><div class="_editor-container_recorded">${escapeHtml(comment.text)}</div><button aria-label="Reply ${comment.replies ?? 0}">${comment.replies ?? 0}</button></div></div>`;
  await page.exposeFunction("fixtureLike", () => { state.likeAttempts++; if (options.persistLike !== false) state.liked = true; });
  await page.exposeFunction("fixtureLatest", () => { state.latestAttempts++; });
  await page.exposeFunction("fixtureComment", (text: string) => { state.commentAttempts++; if (options.persistComment !== false) state.comments.unshift({ author: own, text }); });
  await page.exposeFunction("fixtureRecommendation", () => { state.recommendationAttempts++; });
  const routeTarget = options.identitySource ? page.context() : page;
  await routeTarget.route("**/*", async route => {
    const requestUrl = new URL(route.request().url());
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "builder-session-token,x-csrf-token,builder-id,builder-profile-id,content-type" };
    if (requestUrl.hostname === "api.builder.aws.com" && route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });
    if (requestUrl.hostname === "api.builder.aws.com" && requestUrl.pathname === "/ums/profile/get") {
      return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ profile: { basicInfo: { alias: state.selfAlias, userId: "fixture-user", builderProfileId: "fixture-profile" } } }) });
    }
    if (requestUrl.hostname === "api.builder.aws.com" && requestUrl.pathname === "/cs/v2/articles") {
      return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ articleId: requestUrl.searchParams.get("articleId"), isLiked: state.liked, commentsCount: state.comments.length }) });
    }
    if (requestUrl.hostname === "dataplane.rum.us-east-1.amazonaws.com" || (requestUrl.hostname === "api.builder.aws.com" && requestUrl.pathname.startsWith("/sms/")) || (requestUrl.hostname === "api.builder.aws.com" && requestUrl.pathname === "/cs/activity" && options.activity === "hanging")) {
      await new Promise<void>(resolve => page.once("close", () => resolve()));
      return;
    }
    if (requestUrl.hostname === "api.builder.aws.com" && requestUrl.pathname === "/cs/activity") {
      if (options.activity === "failed") return route.abort("failed");
      if (options.activity === "aborted") return route.abort("aborted");
      if (options.activity === "http_failed") return route.fulfill({ status: 503, contentType: "application/json", headers: { "access-control-allow-origin": origin }, body: '{"error":"unavailable"}' });
      await new Promise(resolve => setTimeout(resolve, 300));
      return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": origin }, body: JSON.stringify({ liked: state.liked }) });
    }
    if (options.identitySource && new URL(route.request().url()).pathname === "/profile") {
      return route.fulfill({ contentType: "text/html", body: `<main><h1>Fixture owner</h1><a href="/edit/profile">Edit information</a><button onclick="document.querySelector('[role=dialog]').hidden=false">QR code</button></main><div role="dialog" hidden>QR code Alias: @${state.selfAlias} <button>Download QR code</button></div>` });
    }
    const home = new URL(route.request().url()).pathname === "/";
    const comments = (options.hiddenOwnComment ? [] : state.comments).map(markup);
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
      <header>${options.auth === false ? '<button>Sign in</button>' : options.identitySource ? '<button id="account-menu" onclick="document.querySelector(\'[role=menu]\').hidden=false">Fixture owner</button><div role="menu" hidden><a id="own-account" href="/profile" role="menuitem">Manage profile</a><a href="/profile/content" role="menuitem">Manage content</a><span role="menuitem">Sign out</span></div>' : `<a id="own-account" href="${own}">My profile</a>`}</header>
      <main><a href="${own}">Article author</a><h1>${candidate.title}</h1>${home ? `<a href="/content/OlderSpotlight/spotlight">Older spotlight article</a><button data-testid="latest" aria-pressed="false">Latest</button><div role="feed"><a href="/content/RecordedId/an-observed-article">${candidate.title}</a><a href="/content/RecordedId/an-observed-article#comments">12</a><a href="https://other.example/content/id/wrong">External</a></div>` : ""}
      <button aria-label="Like this article 12" aria-pressed="${options.activity || options.ssrUnliked ? false : state.liked}">12</button>
      <p ${options.lazyComments ? 'style="min-height:1400px"' : ""}>The article's useful content.</p>
      <button aria-label="Like this article 12" aria-pressed="${options.activity || options.ssrUnliked ? false : state.liked}">12</button>
      <div id="comments"><h2>Comments (${comments.length})</h2>
      <div class="recorded-composer"><div id="comment-editor" contenteditable="true" role="textbox" aria-label="Fixture comment"></div><button id="comment-submit" type="submit">Post comment</button></div>
      <div role="feed" aria-busy="${comments.length > pageSize ? "false" : "true"}">${options.lazyComments ? '<span id="comments-loading" role="status" aria-label="Loading" aria-busy="true"></span>' : ""}<div id="comment-list">${options.lazyComments ? "" : comments.slice(0,pageSize).join("")}</div>${comments.length > pageSize ? '<button id="more-comments">Load more</button>' : ""}</div></div>
      ${options.recommendations ? '<aside><button aria-label="Likes 99" aria-pressed="true" onclick="window.fixtureRecommendation()">99</button><button aria-label="Likes 12" aria-pressed="false" onclick="window.fixtureRecommendation()">12</button></aside>' : ""}</main>
      <script>
      fetch('https://api.builder.aws.com/ums/profile/get',{method:'POST',credentials:'include',headers:{'content-type':'application/json','builder-session-token':'fixture-signer'},body:'{}'}).catch(()=>{});
      ${options.backgroundRequests ? `fetch('https://dataplane.rum.us-east-1.amazonaws.com/telemetry').catch(()=>{});fetch('https://api.builder.aws.com/sms/space/feed').catch(()=>{});fetch('https://api.builder.aws.com/sms/members/spaces/status',{method:'POST'}).catch(()=>{});` : ""}
      ${options.activity ? `fetch('https://api.builder.aws.com/cs/activity').then(response=>{if(!response.ok)throw new Error('Activity unavailable');return response.json();}).then(activity=>{for(const button of document.querySelectorAll('main button[aria-label^="Like this article"]'))button.setAttribute('aria-pressed',String(activity.liked));}).catch(()=>{});` : ""}
      document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=document.querySelector('[role=menu]');if(menu)menu.hidden=true;}});
      const comments=${JSON.stringify(comments)};let shown=${pageSize};
      ${options.lazyComments ? `const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){document.querySelector('#comment-list').innerHTML=comments.slice(0,${pageSize}).join('');document.querySelector('#comments-loading').remove();observer.disconnect();}});observer.observe(document.querySelector('#comments [role="feed"]'));` : ""}
      document.querySelector('button[data-testid=latest]')?.addEventListener('click',event=>{event.target.setAttribute('aria-pressed','true');window.fixtureLatest();});
      document.querySelector('#more-comments')?.addEventListener('click',event=>{
        document.querySelector('#comment-list').insertAdjacentHTML('beforeend',comments.slice(shown,shown+${pageSize}).join(''));shown+=${pageSize};if(shown>=comments.length)event.target.remove();
      });
      for(const button of document.querySelectorAll('main button[aria-label^="Like this article"][aria-pressed]'))button.addEventListener('click',async()=>{
        await window.fixtureLike();${options.independentToolbars ? "button.setAttribute('aria-pressed','true');" : `for(const item of document.querySelectorAll('main button[aria-label^="Like this article"][aria-pressed]'))item.setAttribute('aria-pressed','true');`}
      });
      document.querySelector('#comment-submit').addEventListener('click',async()=>{
        const editor=document.querySelector('#comment-editor');const text=editor.innerText;await window.fixtureComment(text);
        const root=document.createElement('div');root.className='_comment-main_recorded';
        const author=document.createElement('div');author.setAttribute('data-module-id','profile');const link=document.createElement('a');link.href=${JSON.stringify(own)};link.textContent='My profile';author.append(link);
        const content=document.createElement('div');content.className='_comment-content_recorded';const body=document.createElement('div');body.className='_editor-container_recorded';body.textContent=text;content.append(body);const reply=document.createElement('button');reply.setAttribute('aria-label','Reply 0');reply.textContent='0';content.append(reply);root.append(author,content);
        document.querySelector('#comment-list').prepend(root);document.querySelector('#comments h2').textContent='Comments ('+(comments.length+1)+')';editor.innerText='';
      });
      </script></body></html>` });
  });
  await page.goto(candidate.url);
  const profile = await captureSiteProfile(page, { accountProfileUrl: own, accountSelector: "#own-account", commentEditorSelector: "#comment-editor", commentSubmitSelector: "#comment-submit", ...(options.identitySource ? { identitySource: options.identitySource, accountMenuSelector: "#account-menu" } : {}) });
  const driver = createAwsSiteDriver(page, profile, { timeoutMs: options.identitySource ? 4000 : 1200, maxCommentPages: 3 });
  return { page, state, profile, driver };
}

describe("Builder site adapter against isolated browser fixtures", () => {
  let browser: Browser;
  let pages: Page[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterEach(async () => { await Promise.all(pages.map(page => page.context().close())); pages = []; });
  afterAll(async () => { await browser?.close(); });
  async function setup(options: Parameters<typeof fixture>[1] = {}) { const result = await fixture(browser, options); pages.push(result.page); return result; }

  it("canonicalizes only the actual inspected article and profile URL forms", () => {
    expect(canonicalContentUrl("/content/RecordedId/an-observed-article#comments")).toBe(candidate.url);
    expect(canonicalContentUrl("https://attacker.example/content/id/title")).toBeNull();
    expect(canonicalContentUrl("/poll/id")).toBeNull();
    expect(canonicalProfileUrl("/community/@fixture-account/")).toBe(own);
    expect(() => canonicalProfileUrl("/@fixture-account")).toThrow();
  });
  it("stops bounded browser preparation after the worker deadline without engagement", async () => {
    const { page, profile, state } = await setup();
    const expired = createAwsSiteDriver(page, profile, { deadline: Date.now() - 1, timeoutMs: 1200 });
    await expect(expired.inspectCandidate(candidate)).rejects.toMatchObject({ code: "state_unknown" });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("discovers distinct article links and verifies unused account state", async () => {
    const { driver, state } = await setup();
    expect(await driver.discoverCandidates(10)).toEqual([candidate]);
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: false, commented: false, commentsComplete: true });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("uses the Home feed without switching to Latest or selecting Spotlight", async () => {
    const { page, profile, state } = await setup();
    const homeDriver = createAwsSiteDriver(page, profile, { feedMode: "home", timeoutMs: 4000 });
    expect(await homeDriver.discoverCandidates(1)).toEqual([candidate]);
    expect(state.latestAttempts).toBe(0);
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("reads and likes the current article when recommendations have separate like controls", async () => {
    const { driver, state } = await setup({ recommendations: true });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: false, commented: false, commentsComplete: true });
    expect(await driver.likeAndVerify(candidate)).toBe("verified");
    expect(state.likeAttempts).toBe(1);
    expect(state.recommendationAttempts).toBe(0);
  });

  it("finds own comments on later pages and blocks any like attempt", async () => {
    const { driver, state } = await setup({ comments: [{ author: "/community/@another", text: "Earlier" }, { author: own, text: "Already mine" }], pageSize: 1 });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ commented: true });
    await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "already_done" });
    expect(state.likeAttempts).toBe(0);
  });

  it("avoids treating the article author's own-profile link as an existing comment", async () => {
    const { driver } = await setup({ comments: [{ author: "/community/@another", text: "Other person's comment" }] });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ commented: false, commentsComplete: true });
  });

  it("skips posts with unverified reply coverage", async () => {
    const { driver, state } = await setup({ comments: [{ author: "/community/@another", text: "Thread", replies: 1 }] });
    await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "state_unknown" });
    expect(state.likeAttempts).toBe(0);
  });

  it("does not unlike an already liked article", async () => {
    const { driver, state } = await setup({ liked: true });
    expect(await driver.likeAndVerify(candidate)).toBe("already_done");
    expect(state.likeAttempts).toBe(0);
  });

  it("does not click an anonymous SSR toolbar when the owner's persisted like already exists", async () => {
    const { driver, state } = await setup({ liked: true, ssrUnliked: true });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: true });
    expect(await driver.likeAndVerify(candidate)).toBe("already_done");
    expect(state.likeAttempts).toBe(0);
  });

  it("verifies one persisted like when the two toolbars update independently", async () => {
    const { driver, state } = await setup({ independentToolbars: true, ssrUnliked: true });
    expect(await driver.likeAndVerify(candidate)).toBe("verified");
    expect(await driver.likeAndVerify(candidate)).toBe("already_done");
    expect(state.likeAttempts).toBe(1);
  });

  it("scrolls lazy comments into view and accepts exhausted feed aria-busy while requiring the spinner to finish", async () => {
    const { driver, state } = await setup({ lazyComments: true, comments: [{ author: "/community/@other", text: "Loaded after scrolling" }] });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: false, commented: false, commentsComplete: true });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("blocks writes when a cached empty comment list omits an existing own comment", async () => {
    const { driver, state } = await setup({ comments: [{ author: own, text: "Already mine" }], hiddenOwnComment: true });
    await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "state_unknown" });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("allows inspection while observed telemetry and space sidebar requests remain open", async () => {
    const { driver, state } = await setup({ backgroundRequests: true });
    expect(await driver.checkAuthentication()).toBe(true);
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: false, commentsComplete: true });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("waits for persisted activity hydration before considering an SSR unpressed button eligible", async () => {
    const { page, profile, state } = await setup({ liked: true, activity: "delayed", backgroundRequests: true });
    const driver = createAwsSiteDriver(page, profile, { timeoutMs: 2000 });
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: true });
    expect(await driver.likeAndVerify(candidate)).toBe("already_done");
    expect(state.likeAttempts).toBe(0);
  });

  for (const activity of ["hanging", "failed", "aborted", "http_failed"] as const) {
    it(`blocks writes when article activity requests are ${activity}`, async () => {
      const { driver, state } = await setup({ activity });
      await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "state_unknown" });
      expect(state.likeAttempts).toBe(0);
      expect(state.commentAttempts).toBe(0);
    });
  }

  it("verifies persistence and sends only one like and one comment across retries", async () => {
    const { driver, state } = await setup();
    expect(await driver.likeAndVerify(candidate)).toBe("verified");
    expect(await driver.commentAndVerify(candidate, "Thanks for explaining the streaming setup.")).toBe("verified");
    expect(await driver.likeAndVerify(candidate)).toBe("already_done");
    expect(await driver.commentAndVerify(candidate, "Thanks for explaining the streaming setup.")).toBe("already_done");
    expect(state.likeAttempts).toBe(1);
    expect(state.commentAttempts).toBe(1);
  });

  it("classifies an optimistic like without persistence as uncertain", async () => {
    const { driver, state } = await setup({ persistLike: false });
    await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "action_uncertain" });
    expect(state.likeAttempts).toBe(1);
    expect(state.commentAttempts).toBe(0);
  });

  it("classifies an optimistic comment without persistence as uncertain", async () => {
    const { driver, state } = await setup({ liked: true, persistComment: false });
    await expect(driver.commentAndVerify(candidate, "A relevant comment")).rejects.toMatchObject({ code: "action_uncertain" });
    expect(state.commentAttempts).toBe(1);
  });

  it("rejects a shifted selector pointing at a different submit button", async () => {
    const { page, profile, state } = await setup({ liked: true });
    const html = (await page.content()).replace("Post comment", "Delete account");
    await page.route(`${origin}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
    const driver = createAwsSiteDriver(page, profile, { timeoutMs: 1200 });
    await expect(driver.commentAndVerify(candidate, "A relevant comment")).rejects.toMatchObject({ code: "selector_unverified" });
    expect(state.commentAttempts).toBe(0);
  });

  it("requires the exact signed-in account marker, with no engagement", async () => {
    const { page, profile, state } = await setup();
    const html = (await page.content()).replace(`id="own-account" href="${own}"`, 'id="own-account" href="/community/@wrong-account"');
    await page.unroute("**/*");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
    await expect(createAwsSiteDriver(page, profile, { timeoutMs: 1200 }).likeAndVerify(candidate)).rejects.toMatchObject({ code: "auth_required" });
    expect(state.likeAttempts).toBe(0);
  });

  it("rejects missing observation fingerprints before launching actions", async () => {
    const { page, profile } = await setup();
    const unrecorded: SiteProfile = { ...profile, controls: undefined };
    expect(() => createAwsSiteDriver(page, unrecorded)).toThrow(/fingerprints/);
  });

  it("cannot authenticate with an own-profile author link in an article", async () => {
    const { page } = await setup();
    await expect(captureSiteProfile(page, { accountProfileUrl: own, accountSelector: `main a[href="${own}"]`, commentEditorSelector: "#comment-editor", commentSubmitSelector: "#comment-submit" })).rejects.toMatchObject({ code: "auth_required" });
  });

  it("captures the observed Manage profile QR alias and verifies runtime identity with a fresh account response", async () => {
    const { driver, profile, state, page } = await setup({ identitySource: "self_profile" });
    expect(profile.identitySource).toBe("self_profile");
    expect(profile.accountProfileUrl).toBe(own);
    let profilePageRequests = 0;
    await page.route(`${origin}/profile**`, route => { profilePageRequests++; return route.abort(); });
    expect(await driver.checkAuthentication()).toBe(true);
    expect(await driver.inspectCandidate(candidate)).toMatchObject({ liked: false, commented: false, commentsComplete: true });
    expect(profilePageRequests).toBe(0);
    expect(page.context().pages()).toEqual([page]);
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("blocks engagement when the signed-in self-profile alias differs from the recorded owner", async () => {
    const { driver, state } = await setup({ identitySource: "self_profile" });
    state.selfAlias = "another-account";
    await expect(driver.likeAndVerify(candidate)).rejects.toMatchObject({ code: "auth_required" });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("cannot authenticate from a Manage profile link outside the account header or menu", async () => {
    const { page, state } = await setup({ identitySource: "self_profile" });
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.id = "article-profile";
      link.href = "/profile";
      link.textContent = "Manage profile";
      document.querySelector("main")!.prepend(link);
    });
    await expect(captureSiteProfile(page, { identitySource: "self_profile", accountProfileUrl: own, accountSelector: "#article-profile", commentEditorSelector: "#comment-editor", commentSubmitSelector: "#comment-submit" })).rejects.toMatchObject({ code: "auth_required" });
    expect(state.likeAttempts).toBe(0);
    expect(state.commentAttempts).toBe(0);
  });

  it("a rejected worker fence prevents the actual like click", async () => {
    const { page, profile, state } = await setup();
    let checks = 0;
    const driver = createAwsSiteDriver(page, profile, { timeoutMs: 1200, beforeSubmit: async () => { checks++; throw new Error("Worker lease lost"); } });
    await expect(driver.likeAndVerify(candidate)).rejects.toThrow("Worker lease lost");
    expect(checks).toBe(1);
    expect(state.likeAttempts).toBe(0);
  });

  it("a rejected worker fence prevents the actual comment submit click", async () => {
    const { page, profile, state } = await setup({ liked: true });
    let checks = 0;
    const driver = createAwsSiteDriver(page, profile, { timeoutMs: 1200, beforeSubmit: async () => { checks++; throw new Error("Daily execution window ended"); } });
    await expect(driver.commentAndVerify(candidate, "A relevant comment")).rejects.toThrow("Daily execution window ended");
    expect(checks).toBe(1);
    expect(state.commentAttempts).toBe(0);
  });
});
