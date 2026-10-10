import { open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { launchAwsBrowser } from "../lib/aws/browser";
import { awsOnlyStorageState, encryptSession, loadSessionFromEnvironment, type AwsSessionBundle } from "../lib/aws/session";
import { loadLocalAwsEnvironment } from "../lib/aws/local-environment";
import { createAwsSiteDriver, AwsSiteError } from "../lib/aws/site";
import { composeRelevantComment } from "../lib/aws/comment";
import { readAwsStreaks, AwsStreakReadError } from "../lib/aws/streaks";
import { executeLocalDaily, localDailyDate, readLocalDailyRun } from "../lib/aws/local-daily";

const workspace = fileURLToPath(new URL("../", import.meta.url));
process.chdir(workspace);
const directory = resolve(workspace, ".local/aws-daily");
const arguments_ = new Set(process.argv.slice(2));
let browser: Awaited<ReturnType<typeof launchAwsBrowser>> | undefined;
let session: AwsSessionBundle | undefined;
let sessionKey: string | undefined;
let originalLocalExport: string | undefined;

async function loadLocalSession() {
  loadLocalAwsEnvironment(true);
  // Local daily runs use the latest local export even when a dashboard .env exists.
  let saved: string;
  try { saved = await readFile(resolve(workspace, ".local/aws-session.env"), "utf8"); }
  catch { throw new AwsSiteError("auth_required", "Run npm run aws:connect to save your local AWS session."); }
  originalLocalExport = saved;
  const key = /^AWS_SESSION_KEY=([0-9a-f]{64})\s*$/mi.exec(saved)?.[1];
  const encrypted = /^AWS_SESSION_ENCRYPTED=([^\r\n]+)\s*$/m.exec(saved)?.[1]?.trim();
  if (!key || !encrypted) throw new AwsSiteError("auth_required", "Run npm run aws:connect to save your local AWS session.");
  process.env.AWS_SESSION_KEY = key;
  process.env.AWS_SESSION_ENCRYPTED = encrypted;
  sessionKey = key;
  try { session = loadSessionFromEnvironment(); }
  catch { throw new AwsSiteError("auth_required", "The local AWS session needs reconnecting. Run npm run aws:connect."); }
  return session;
}

async function refreshLocalSession() {
  if (!browser || !session || !sessionKey) return;
  const destination = resolve(workspace, ".local/aws-session.env");
  if (await readFile(destination, "utf8") !== originalLocalExport) return;
  const updated = { ...session, storageState: awsOnlyStorageState(await browser.context.storageState({ indexedDB: true })) };
  const encrypted = encryptSession(updated, sessionKey);
  const temporary = resolve(workspace, `.local/aws-session.${randomUUID()}.env`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`AWS_SESSION_KEY=${sessionKey}\nAWS_SESSION_ENCRYPTED=${encrypted}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
  // A reconnect completed during the check owns the newer local export.
  if (await readFile(destination, "utf8") !== originalLocalExport) return;
  await rename(temporary, destination);
}

try {
  if ([...arguments_].some(value => !["--status", "--check", "--scheduled"].includes(value))) {
    throw new Error("Unsupported daily command.");
  }
  if (arguments_.has("--status")) {
    const date = localDailyDate(new Date());
    console.log(JSON.stringify({ date, run: await readLocalDailyRun(directory, date) }, null, 2));
  } else if (arguments_.has("--check")) {
    const connected = await loadLocalSession();
    browser = await launchAwsBrowser({ session: connected });
    const activity = await readAwsStreaks(browser.context, connected.profile.accountProfileUrl);
    console.log(JSON.stringify({ readOnly: true, account: "verified", activity }, null, 2));
    await refreshLocalSession();
  } else {
    const deadline = Date.now() + 10 * 60_000;
    let connectionError: unknown;
    try { await loadLocalSession(); } catch (error) { connectionError = error; }
    const result = await executeLocalDaily({
      directory, deadline, sessionProfileUrl: session?.profile.accountProfileUrl,
      createDriver: async beforeSubmit => {
        if (connectionError) throw connectionError;
        const connected = session ?? await loadLocalSession();
        browser = await launchAwsBrowser({ session: connected });
        const page = await browser.context.newPage();
        return createAwsSiteDriver(page, connected.profile, { feedMode: "home", maxDiscoveryPages: 4, maxCommentPages: 5, deadline, beforeSubmit });
      },
      composeComment: composeRelevantComment,
      verifyActivity: async () => {
        if (!browser || !session) throw new Error("No connected local browser.");
        return readAwsStreaks(browser.context, session.profile.accountProfileUrl, { deadline });
      }
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome === "executed" && result.run?.status === "verified" && result.run.activity) await refreshLocalSession();
    if (result.outcome !== "too_early" && (!result.run || result.run.status !== "verified" || result.run.activityError)) process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof AwsSiteError || error instanceof AwsStreakReadError ? error.code : "local_check_failed";
  console.error(JSON.stringify({ status: code, message: "Check the local daily record. If AWS needs a passkey, run npm run aws:connect -- --manual-browser and complete sign-in yourself." }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.browser.close().catch(() => undefined);
}
