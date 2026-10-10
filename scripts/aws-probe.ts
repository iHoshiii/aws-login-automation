import { launchAwsBrowser } from "../lib/aws/browser";
import { loadSessionFromEnvironment } from "../lib/aws/session";
import { createAwsSiteDriver, AwsSiteError } from "../lib/aws/site";
import { loadLocalAwsEnvironment } from "../lib/aws/local-environment";

loadLocalAwsEnvironment(true);

try {
  const session = loadSessionFromEnvironment();
  const { browser, context } = await launchAwsBrowser({ session });
  try {
    const page = await context.newPage();
    const driver = createAwsSiteDriver(page, session.profile, { timeoutMs: 8000, maxDiscoveryPages: 2, maxCommentPages: 5 });
    await driver.checkAuthentication();
    console.log("Recorded account identity observed. Probe is read-only; no likes/comments will be submitted.");
    const candidates = await driver.discoverCandidates(6);
    for (const candidate of candidates) {
      try {
        const state = await driver.inspectCandidate(candidate);
        console.log(JSON.stringify({ url: candidate.url, title: candidate.title, liked: state.liked, commented: state.commented, commentsComplete: state.commentsComplete, eligible: !state.liked && !state.commented && state.commentsComplete }));
      } catch (error) {
        console.log(JSON.stringify({ url: candidate.url, status: error instanceof AwsSiteError ? error.code : "inspection_failed" }));
      }
    }
    console.log("Probe finished. No database records, likes or comments were submitted; AWS pages were visited.");
  } finally { await browser.close(); }
} catch {
  console.error("Probe failed. Reconnect if the session expired; inspect the selected controls if the layout changed. No engagement was submitted.");
  process.exitCode = 1;
}
