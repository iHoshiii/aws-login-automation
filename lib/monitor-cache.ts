import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { decryptSession } from "./aws/session";
import { canonicalProfileUrl } from "./aws/site";
import type { AwsStreakSummary } from "./aws/streaks";
import type { LocalDailyActivitySummary } from "./aws/local-daily";

export interface LocalMonitorBinding {
  accountProfileUrl: string;
  /** A nonreversible identity binding; the actual encryption key is never cached. */
  fingerprint: string;
}

export function localMonitorBinding(accountProfileUrl: string, sessionKey: string): LocalMonitorBinding {
  if (!/^[0-9a-f]{64}$/i.test(sessionKey)) throw new Error("Invalid local monitor identity.");
  const account = canonicalProfileUrl(accountProfileUrl);
  return {
    accountProfileUrl: account,
    fingerprint: createHash("sha256").update(`${account}\0${sessionKey.toLowerCase()}`).digest("hex")
  };
}

export async function readBoundedLocalFile(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > 128_000) return null;
    return await readFile(path, "utf8");
  } catch { return null; }
}

/** Only the server reads the encrypted export; callers receive no session values. */
export async function readLocalMonitorBinding(workspace: string): Promise<LocalMonitorBinding | null> {
  const saved = await readBoundedLocalFile(join(workspace, ".local/aws-session.env"));
  if (!saved) return null;
  const key = /^AWS_SESSION_KEY=([0-9a-f]{64})\s*$/mi.exec(saved)?.[1];
  const encrypted = /^AWS_SESSION_ENCRYPTED=([^\r\n]+)\s*$/m.exec(saved)?.[1]?.trim();
  if (!key || !encrypted) return null;
  try {
    const session = decryptSession(encrypted, key);
    return localMonitorBinding(session.profile.accountProfileUrl, key);
  } catch { return null; }
}

function observationCount(value: unknown, total: 30 | 90): { current: number; total: 30 | 90 } | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  return entry.total === total && typeof entry.current === "number" && Number.isInteger(entry.current) && entry.current >= 0 && entry.current <= total
    ? { current: entry.current, total } : null;
}

/** Ignore invalid/future observations and retain absent legacy counts as unknown. */
export function parseMonitorObservation(value: unknown, now: Date, requireAll = false): LocalDailyActivitySummary | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt)) || Date.parse(entry.observedAt) > now.getTime() + 60_000) return null;
  const visit = observationCount(entry.visit, 30);
  const like = observationCount(entry.like, 30);
  const comment = observationCount(entry.comment, 30);
  const visit90 = observationCount(entry.visit90, 90);
  const like90 = observationCount(entry.like90, 90);
  const comment90 = observationCount(entry.comment90, 90);
  if (!visit || !like || !comment || !visit90 || (requireAll && (!like90 || !comment90))) return null;
  if ((entry.like90 !== undefined && !like90) || (entry.comment90 !== undefined && !comment90)) return null;
  return {
    observedAt: entry.observedAt,
    visit: { current: visit.current, total: 30 }, like: { current: like.current, total: 30 }, comment: { current: comment.current, total: 30 },
    visit90: { current: visit90.current, total: 90 },
    ...(like90 ? { like90: { current: like90.current, total: 90 } as const } : {}),
    ...(comment90 ? { comment90: { current: comment90.current, total: 90 } as const } : {})
  };
}

export async function readLocalMonitorObservation(directory: string, binding: LocalMonitorBinding, now: Date): Promise<LocalDailyActivitySummary | null> {
  const saved = await readBoundedLocalFile(join(directory, "activity.json"));
  if (!saved) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object") return null;
    const cache = value as Record<string, unknown>;
    if (cache.version !== 1 || cache.accountProfileUrl !== binding.accountProfileUrl || cache.fingerprint !== binding.fingerprint) return null;
    return parseMonitorObservation(cache.activity, now, true);
  } catch { return null; }
}

/** Shared with the plain Node CLI; stores only allowlisted public observations. */
export async function writeLocalMonitorObservation(directory: string, activity: AwsStreakSummary, binding: LocalMonitorBinding): Promise<void> {
  const observation = parseMonitorObservation(activity, new Date(), true);
  if (!observation || !/^[0-9a-f]{64}$/.test(binding.fingerprint)) throw new Error("Invalid local monitor observation.");
  const accountProfileUrl = canonicalProfileUrl(binding.accountProfileUrl);
  await mkdir(directory, { recursive: true });
  const previous = await readLocalMonitorObservation(directory, binding, new Date());
  if (previous && Date.parse(previous.observedAt) > Date.parse(observation.observedAt)) return;
  const temporary = join(directory, `.activity.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ version: 1, accountProfileUrl, fingerprint: binding.fingerprint, activity: observation }, null, 2)}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(directory, "activity.json")); }
  finally { await unlink(temporary).catch(() => undefined); }
}
