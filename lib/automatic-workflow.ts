import "server-only";
import {
  appendAutomationLog, assertAutomationActionReady, assignAutomationPost, beginAutomationAction,
  claimAutomationRun, finishAutomationAction, finishAutomationRun
} from "./automation-repository";
import { notifyAutomation } from "./automation-notifications";
import type { AutomationRun, AutomationRunStatus } from "./automation-types";
import type { ActivityType, DashboardData } from "./types";
import { loadSessionFromEnvironment, type AwsSessionBundle } from "./aws/session";
import { launchAwsBrowser } from "./aws/browser";
import { AwsSiteError, createAwsSiteDriver, type AwsCandidate } from "./aws/site";
import { manilaDate } from "./time";
import { postUrl } from "./validation";

export async function executeAutomaticRun(input: { localDate: string; scheduledAt: string; retry: boolean; data: DashboardData }) {
  let session: AwsSessionBundle | undefined;
  try { session = loadSessionFromEnvironment(); } catch { /* Persist an actionable auth_required run below. */ }
  const claim = await claimAutomationRun({ ...input, accountProfileUrl: session?.profile.accountProfileUrl ?? null });
  if (claim.outcome !== "claimed" || !claim.run || !claim.token) {
    if (claim.run && claim.run.status !== "running") {
      try { await notifyAutomation(claim.run.id, claim.run.status === "auth_required" ? "auth_required" : claim.run.status === "verified" ? "result" : "failure"); } catch { console.error(JSON.stringify({ event: "automation_notification_storage_failed", run_id: claim.run.id })); }
    }
    return { outcome: claim.outcome, run: claim.run, mode: "automatic" as const };
  }
  const id = claim.run.id;
  const token = claim.token;
  let currentRun: AutomationRun = claim.run;
  let browser: Awaited<ReturnType<typeof launchAwsBrowser>> | undefined;
  let activeAction: ActivityType | undefined;
  let engagementClaimed = false;
  const deadline = Date.now() + 120000;

  const checkTime = () => {
    if (Date.now() >= deadline || manilaDate(new Date()) !== input.localDate) {
      throw new AwsSiteError("state_unknown", "Execution budget or Philippine date boundary reached before another action.");
    }
  };
  const finish = async (status: Exclude<AutomationRunStatus, "running">, message: string) => {
    await finishAutomationRun(id, token, status, message);
    currentRun = { ...currentRun, status, finished_at: new Date().toISOString(), error_message: status === "verified" ? null : message };
    try { await notifyAutomation(id, status === "auth_required" ? "auth_required" : status === "verified" ? "result" : "failure"); } catch { console.error(JSON.stringify({ event: "automation_notification_storage_failed", run_id: id })); }
    return { outcome: "executed" as const, mode: "automatic" as const, run: currentRun };
  };

  try {
    if (!session) return await finish("auth_required", "Run npm run aws:connect, then configure AWS_SESSION_ENCRYPTED and AWS_SESSION_KEY.");
    const text = (process.env.AWS_COMMENT_TEXT ?? "nice").trim();
    if (!text || text.length > 500) return await finish("failed", "AWS_COMMENT_TEXT must contain 1 to 500 characters.");
    browser = await launchAwsBrowser({ session });
    const page = await browser.context.newPage();
    const driver = createAwsSiteDriver(page, session.profile, {
      feedMode: "home", maxDiscoveryPages: 2, maxCommentPages: 5, deadline,
      beforeSubmit: async () => {
        checkTime();
        if ((activeAction !== "like" && activeAction !== "comment") || !await assertAutomationActionReady(id, token, activeAction)) {
          throw new AwsSiteError("state_unknown", "Submission guard refused the action. Refresh the run before proceeding.");
        }
        checkTime();
      }
    });
    await driver.checkAuthentication();
    checkTime();

    const candidates: AwsCandidate[] = currentRun.post_url ? [{ url: currentRun.post_url, title: currentRun.post_title ?? "Previously selected post" }] : [];
    if (!candidates.length) {
      candidates.push(...await driver.discoverCandidates(6));
      // Optional curated links are a fallback; they still undergo AWS state checks.
      for (const post of input.data.posts.filter(post => post.state === "available")) {
        if (candidates.length >= 10) break;
        if (!candidates.some(candidate => postUrl(candidate.url) === post.url)) candidates.push({ url: post.url, title: post.title });
      }
    }
    let selected: AwsCandidate | undefined;
    for (const candidate of candidates) {
      checkTime();
      try {
        const observed = await driver.inspectCandidate(candidate);
        if (observed.liked || observed.commented || !observed.commentsComplete) {
          await appendAutomationLog(id, token, "candidate_skipped", "Existing like/comment or incomplete comment history; no engagement performed.");
          continue;
        }
        if (!await assignAutomationPost(id, token, candidate)) {
          await appendAutomationLog(id, token, "candidate_reserved", "Candidate is already reserved or has prior tracked engagement; skipped.");
          continue;
        }
        selected = candidate;
        currentRun = { ...currentRun, post_url: postUrl(candidate.url), post_title: candidate.title };
        break;
      } catch (error) {
        if (error instanceof AwsSiteError && error.code === "state_unknown") {
          await appendAutomationLog(id, token, "candidate_uninspectable", "Candidate history could not be confirmed; skipped without engagement.");
          continue;
        }
        throw error;
      }
    }
    if (!selected) {
      return await finish(currentRun.post_url ? "failed" : "no_post", "No eligible post with completely inspected comment history was found. No like/comment was attempted.");
    }
    checkTime();
    if (await beginAutomationAction(id, token, "visit")) {
      activeAction = "visit";
      await driver.checkAuthentication();
      await finishAutomationAction(id, token, "visit", "verified", "Signed-in account identity observed while visiting Builder Center.");
      activeAction = undefined;
    }

    for (const type of ["like", "comment"] as const) {
      checkTime();
      if (!await beginAutomationAction(id, token, type)) throw new AwsSiteError("state_unknown", "Action claim was refused. The run may be paused or already processed.");
      engagementClaimed = true;
      activeAction = type;
      const result = type === "like" ? await driver.likeAndVerify(selected) : await driver.commentAndVerify(selected, text);
      if (result !== "verified") {
        await finishAutomationAction(id, token, type, "skipped", "The action already existed when state was rechecked; no new action submitted.");
        activeAction = undefined;
        return await finish("failed", "Candidate state changed before submission. Automatic repetition is blocked.");
      }
      await finishAutomationAction(id, token, type, "verified", type === "like" ? "Liked state persisted after reloading the article." : "Account-authored comment with the intended text persisted after reload.");
      activeAction = undefined;
    }
    return await finish("verified", "Visit, like and comment observations recorded. AWS reward and streak eligibility remain unverified.");
  } catch (error) {
    const code = error instanceof AwsSiteError ? error.code : "worker_failed";
    // Once any engagement was claimed, a thrown error is ambiguous: it may follow
    // an accepted AWS request or a lost database reply. Never retry the external action.
    const uncertain = engagementClaimed || code === "action_uncertain";
    if (activeAction) {
      try { await finishAutomationAction(id, token, activeAction, uncertain ? "uncertain" : "failed", uncertain ? "External action outcome could not be durably confirmed. Automatic replay is blocked." : "Visit/authentication check failed before engagement."); } catch { /* Keep started claim unresolved; expired claims become uncertain. */ }
    }
    const status = uncertain ? "uncertain" : code === "auth_required" ? "auth_required" : "failed";
    const message = uncertain ? "Inspect the selected post on AWS. An action may have succeeded; automatic retries are blocked." :
      code === "auth_required" ? "AWS authentication expired or requires a challenge. Run npm run aws:connect again." :
      code === "selector_unverified" ? "Recorded website controls changed or were not captured. Reconnect before trying again." :
      "Worker could not confirm eligible content or complete preparation. No automatic retry loop was started.";
    try { return await finish(status, message); } catch {
      console.error(JSON.stringify({ event: "automatic_run_persistence_uncertain", run_id: id }));
      // A lost database response must never be presented as a persisted success.
      return { outcome: "persistence_uncertain" as const, mode: "automatic" as const, run: { ...currentRun, status: "uncertain" as const, error_message: "Refresh and inspect database/AWS before retrying. Final storage could not be confirmed." } };
    }
  } finally {
    if (browser) { try { await browser.browser.close(); } catch { console.error(JSON.stringify({ event: "browser_cleanup_failed", run_id: id })); } }
  }
}
