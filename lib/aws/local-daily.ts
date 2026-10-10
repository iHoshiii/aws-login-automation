import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AwsSiteError, canonicalProfileUrl, type AwsCandidate, type AwsCandidateInspection, type AwsSiteDriver } from "./site";
import { postUrl } from "../validation";
import type { AwsStreakSummary } from "./streaks";

export type LocalDailyStatus = "running" | "verified" | "auth_required" | "no_post" | "failed" | "uncertain";
export type LocalDailyActionStatus = "not_started" | "started" | "verified";
/** Earlier journals contain four badge observations; leave absent counts unknown. */
export type LocalDailyActivitySummary = Omit<AwsStreakSummary, "like90" | "comment90"> &
  Partial<Pick<AwsStreakSummary, "like90" | "comment90">>;

/** This journal contains public observations, never browser state or credentials. */
export interface LocalDailyRun {
  version: 1;
  date: string;
  status: LocalDailyStatus;
  startedAt: string;
  finishedAt?: string;
  accountProfileUrl?: string;
  post?: AwsCandidate;
  comment?: string;
  actions: { like: LocalDailyActionStatus; comment: LocalDailyActionStatus };
  activity?: LocalDailyActivitySummary;
  activityError?: string;
  error?: string;
}

export interface ExecuteLocalDailyOptions {
  directory: string;
  now?: () => Date;
  sessionProfileUrl?: string;
  createDriver: (beforeSubmit: () => Promise<void>) => AwsSiteDriver | Promise<AwsSiteDriver>;
  composeComment: (candidate: AwsCandidate, observed: AwsCandidateInspection) => string | Promise<string>;
  verifyActivity: () => Promise<AwsStreakSummary>;
  /** Absolute timestamp after which no additional engagement can start. */
  deadline?: number;
}

export type LocalDailyResult = {
  outcome: "executed" | "existing" | "too_early";
  /** A claim without a readable journal is still protected against repetition. */
  run: LocalDailyRun | null;
};

export function localDailyDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid daily execution date.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function checkedDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid daily journal date.");
  }
  return date;
}

function journalPath(directory: string, date: string): string {
  return join(directory, `${checkedDate(date)}.json`);
}

function validRun(value: unknown, date: string): value is LocalDailyRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<LocalDailyRun>;
  return run.version === 1 && run.date === date &&
    ["running", "verified", "auth_required", "no_post", "failed", "uncertain"].includes(run.status ?? "") &&
    typeof run.startedAt === "string" && Number.isFinite(Date.parse(run.startedAt)) &&
    !!run.actions && ["not_started", "started", "verified"].includes(run.actions.like) &&
    ["not_started", "started", "verified"].includes(run.actions.comment);
}

export async function readLocalDailyRun(directory: string, date: string): Promise<LocalDailyRun | null> {
  try {
    const value: unknown = JSON.parse(await readFile(journalPath(directory, date), "utf8"));
    return validRun(value, date) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function previouslyClaimedPosts(directory: string): Promise<Set<string>> {
  const posts = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const previous = await readLocalDailyRun(directory, name.slice(0, -5));
    if (previous?.post && (previous.actions.like !== "not_started" || previous.actions.comment !== "not_started")) {
      posts.add(postUrl(previous.post.url));
    }
  }
  return posts;
}

async function writeRun(directory: string, run: LocalDailyRun): Promise<void> {
  const destination = journalPath(directory, run.date);
  const temporary = join(directory, `.${run.date}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    const publicRun: LocalDailyRun = {
      version: 1, date: run.date, status: run.status, startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.accountProfileUrl ? { accountProfileUrl: run.accountProfileUrl } : {}),
      ...(run.post ? { post: { url: run.post.url, title: run.post.title } } : {}),
      ...(run.comment ? { comment: run.comment } : {}),
      actions: { like: run.actions.like, comment: run.actions.comment },
      ...(run.activity ? { activity: publicActivity(run.activity) } : {}),
      ...(run.activityError ? { activityError: run.activityError } : {}),
      ...(run.error ? { error: run.error } : {})
    };
    await file.writeFile(`${JSON.stringify(publicRun, null, 2)}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, destination); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function publicActivity(value: LocalDailyActivitySummary, requireAll = false): LocalDailyActivitySummary {
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new Error("Invalid profile observation timestamp.");
  const count = <Total extends 30 | 90>(observed: { current: number; total: Total }, total: Total) => {
    if (observed.total !== total || !Number.isInteger(observed.current) || observed.current < 0 || observed.current > total) {
      throw new Error("Invalid profile streak observation.");
    }
    return { current: observed.current, total };
  };
  if (requireAll && (!value.like90 || !value.comment90)) throw new Error("Missing 90-day profile streak observations.");
  return {
    observedAt: value.observedAt,
    visit: count(value.visit, 30), like: count(value.like, 30), comment: count(value.comment, 30), visit90: count(value.visit90, 90),
    ...(value.like90 ? { like90: count(value.like90, 90) } : {}),
    ...(value.comment90 ? { comment90: count(value.comment90, 90) } : {})
  };
}

async function claimDate(directory: string, run: LocalDailyRun): Promise<boolean> {
  await mkdir(directory, { recursive: true });
  let file;
  try { file = await open(join(directory, `${checkedDate(run.date)}.claim`), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  // Claims are never deleted automatically, including after an interrupted write.
  try {
    await file.writeFile(`${JSON.stringify({ date: run.date, startedAt: run.startedAt })}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
  return true;
}

/** Record an already observed run without repeating the external engagement. */
export async function seedLocalDailyRun(directory: string, run: LocalDailyRun): Promise<LocalDailyResult> {
  if (!validRun(run, checkedDate(run.date))) throw new Error("Invalid daily seed observation.");
  if (!await claimDate(directory, run)) return { outcome: "existing", run: await readLocalDailyRun(directory, run.date) };
  await writeRun(directory, run);
  return { outcome: "executed", run };
}

export async function executeLocalDaily(options: ExecuteLocalDailyOptions): Promise<LocalDailyResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const date = localDailyDate(started);
  // Asia/Singapore has no daylight-saving transitions: 09:00 is 01:00 UTC.
  if (started.getTime() < new Date(`${date}T01:00:00Z`).getTime()) return { outcome: "too_early", run: null };
  const deadline = options.deadline ?? started.getTime() + 5 * 60_000;
  if (!Number.isFinite(deadline)) throw new Error("Invalid daily execution deadline.");
  let run: LocalDailyRun = {
    version: 1, date, status: "running", startedAt: started.toISOString(),
    actions: { like: "not_started", comment: "not_started" }
  };
  if (options.sessionProfileUrl) run.accountProfileUrl = canonicalProfileUrl(options.sessionProfileUrl);
  if (!await claimDate(options.directory, run)) return { outcome: "existing", run: await readLocalDailyRun(options.directory, date) };
  await writeRun(options.directory, run);
  let activeAction: "like" | "comment" | undefined;
  let submissionGuardUsed = false;

  const checkWindow = () => {
    const current = now();
    if (localDailyDate(current) !== date || current.getTime() >= deadline) {
      throw new AwsSiteError("state_unknown", "Daily execution date or deadline changed before submission.");
    }
  };
  const finish = async (status: LocalDailyStatus, error?: string): Promise<LocalDailyResult> => {
    run = { ...run, status, finishedAt: now().toISOString(), ...(error ? { error } : {}) };
    await writeRun(options.directory, run);
    return { outcome: "executed", run };
  };
  const beforeSubmit = async () => {
    checkWindow();
    if (!activeAction || submissionGuardUsed) throw new AwsSiteError("state_unknown", "Submission has no unused action claim.");
    const persisted = await readLocalDailyRun(options.directory, date);
    if (!persisted || persisted.status !== "running" || persisted.actions[activeAction] !== "started" ||
        persisted.post?.url !== run.post?.url || persisted.comment !== run.comment ||
        persisted.accountProfileUrl !== run.accountProfileUrl ||
        (activeAction === "comment" && persisted.actions.like !== "verified")) {
      throw new AwsSiteError("state_unknown", "The durable action claim could not be confirmed.");
    }
    checkWindow();
    submissionGuardUsed = true;
  };

  try {
    checkWindow();
    const driver = await options.createDriver(beforeSubmit);
    await driver.checkAuthentication();
    checkWindow();
    const usedPosts = await previouslyClaimedPosts(options.directory);
    const candidates = await driver.discoverCandidates(24);
    let selected: AwsCandidate | undefined;
    let comment: string | undefined;
    for (const candidate of candidates) {
      checkWindow();
      try {
        if (usedPosts.has(postUrl(candidate.url))) continue;
        const inspection = await driver.inspectCandidate(candidate);
        if (inspection.liked || inspection.commented || !inspection.commentsComplete) continue;
        const canonical = { url: postUrl(candidate.url), title: candidate.title };
        checkWindow();
        const composed = (await options.composeComment(canonical, inspection)).trim();
        if (!composed || composed.length > 500) throw new Error("The composed comment must contain 1 to 500 characters.");
        checkWindow();
        selected = canonical;
        comment = composed;
        break;
      } catch (error) {
        if (error instanceof AwsSiteError && error.code === "state_unknown") continue;
        throw error;
      }
    }
    if (!selected || !comment) return await finish("no_post", "No eligible article with complete comment history and a relevant comment was found.");
    checkWindow();
    run = { ...run, post: selected, comment };
    await writeRun(options.directory, run);

    for (const action of ["like", "comment"] as const) {
      checkWindow();
      run = { ...run, actions: { ...run.actions, [action]: "started" } };
      await writeRun(options.directory, run);
      activeAction = action;
      submissionGuardUsed = false;
      checkWindow();
      const result = action === "like"
        ? await driver.likeAndVerify(selected)
        : await driver.commentAndVerify(selected, comment);
      if (!submissionGuardUsed) throw new AwsSiteError("action_uncertain", "The driver did not confirm its final submission guard.");
      if (result !== "verified") {
        return await finish("uncertain", "Article state changed after the action was claimed. Automatic repetition is blocked.");
      }
      run = { ...run, actions: { ...run.actions, [action]: "verified" } };
      await writeRun(options.directory, run);
      activeAction = undefined;
    }

    // A profile read cannot undo article-level evidence that both writes persisted.
    try {
      checkWindow();
      run = { ...run, activity: publicActivity(await options.verifyActivity(), true) };
    } catch {
      run = { ...run, activityError: "Profile Activity streaks could not be observed. Check Manage profile on AWS." };
    }
    return await finish("verified");
  } catch (error) {
    const engagementClaimed = run.actions.like !== "not_started" || run.actions.comment !== "not_started";
    const status: LocalDailyStatus = engagementClaimed ? "uncertain" : error instanceof AwsSiteError && error.code === "auth_required" ? "auth_required" : "failed";
    const message = status === "uncertain"
      ? "An engagement action may have succeeded. Inspect the article on AWS; automatic repetition is blocked."
      : status === "auth_required" ? "AWS sign-in needs attention. Run npm run aws:connect again."
      : "Daily preparation could not be completed. No engagement action was claimed.";
    return await finish(status, message);
  }
}
