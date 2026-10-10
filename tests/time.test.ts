import { describe, expect, it } from "vitest";
import { executionWindow, manilaDate, nextScheduledTime, scheduledTime } from "@/lib/time";

describe("Philippine schedule and ledger dates", () => {
  it("uses the Philippine date at midnight, rather than the UTC date", () => {
    expect(manilaDate(new Date("2026-10-08T15:59:59Z"))).toBe("2026-10-08");
    expect(manilaDate(new Date("2026-10-08T16:00:00Z"))).toBe("2026-10-09");
  });
  it("prepares at 01:00 UTC and rejects earlier execution", () => {
    expect(executionWindow(new Date("2026-10-09T00:59:59Z")).eligible).toBe(false);
    expect(executionWindow(new Date("2026-10-09T01:00:00Z"))).toEqual({ eligible: true, localDate: "2026-10-09", scheduledAt: "2026-10-09T01:00:00.000Z" });
  });
  it("assigns a delayed run to the actual Philippine date", () => {
    expect(executionWindow(new Date("2026-10-09T15:50:00Z")).localDate).toBe("2026-10-09");
    expect(executionWindow(new Date("2026-10-09T16:30:00Z")).eligible).toBe(false);
  });
  it("crosses year and month boundaries for the next scheduled run", () => {
    expect(nextScheduledTime(new Date("2026-12-31T01:00:00Z")).toISOString()).toBe("2027-01-01T01:00:00.000Z");
    expect(nextScheduledTime(new Date("2026-10-09T00:30:00Z")).toISOString()).toBe("2026-10-09T01:00:00.000Z");
  });
  it("rejects malformed and impossible dates", () => {
    expect(() => scheduledTime("2026-02-30")).toThrow();
    expect(() => scheduledTime("2026-1-1")).toThrow();
    expect(() => manilaDate(new Date("invalid"))).toThrow();
  });
});
