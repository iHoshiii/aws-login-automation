import "server-only";
import { getDashboardData, prepareDailyRun } from "./repository";
import { notifyRun } from "./notifications";
import { executionWindow } from "./time";
import { executeAutomaticRun } from "./automatic-workflow";

export async function runToday(options: { retry?: boolean; dryRun?: boolean; now?: Date } = {}) {
  const window = executionWindow(options.now ?? new Date());
  if (options.dryRun) return { outcome: "dry_run" as const, ...window, manualOnly: false, mode: "automatic-capable", databaseWritten: false, notificationsSent: false, browserOpened: false };
  if (!window.eligible) return { outcome: "too_early" as const, ...window, run: null };
  const data = await getDashboardData();
  if (data.config.auto_mode !== false) {
    return { ...await executeAutomaticRun({ localDate: window.localDate, scheduledAt: window.scheduledAt, retry: options.retry ?? false, data }), ...window };
  }
  const result = await prepareDailyRun({ localDate: window.localDate, scheduledAt: window.scheduledAt, retry: options.retry ?? false });
  if (result.run && result.outcome !== "disabled") {
    // A transient notification-storage error must not undo the already durable run.
    try { await notifyRun(result.run.id); } catch {
      console.error(JSON.stringify({ event: "notification_storage_failed", run_id: result.run.id }));
    }
  }
  return { ...result, ...window };
}
