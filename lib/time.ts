export const TIME_ZONE = "Asia/Manila";
export const CRON_SCHEDULE = "0 1 * * *";

export function manilaDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function scheduledTime(localDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error("Invalid local date");
  const date = new Date(`${localDate}T01:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== localDate) {
    throw new Error("Invalid local date");
  }
  return date;
}

export function nextScheduledTime(now: Date): Date {
  const scheduled = scheduledTime(manilaDate(now));
  if (scheduled.getTime() > now.getTime()) return scheduled;
  return new Date(scheduled.getTime() + 86_400_000);
}

export function executionWindow(now: Date) {
  const localDate = manilaDate(now);
  const scheduled = scheduledTime(localDate);
  return { localDate, scheduledAt: scheduled.toISOString(), eligible: now.getTime() >= scheduled.getTime() };
}
