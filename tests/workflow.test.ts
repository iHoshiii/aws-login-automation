import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), notify: vi.fn(), data: vi.fn(), automatic: vi.fn() }));
vi.mock("@/lib/repository", () => ({ prepareDailyRun: mocks.prepare, getDashboardData: mocks.data }));
vi.mock("@/lib/automatic-workflow", () => ({ executeAutomaticRun: mocks.automatic }));
vi.mock("@/lib/notifications", () => ({ notifyRun: mocks.notify }));
import { runToday } from "@/lib/workflow";

describe("daily review orchestration", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.notify.mockResolvedValue(undefined); mocks.data.mockResolvedValue({ config: { auto_mode: false }, posts: [] }); });
  afterEach(() => vi.restoreAllMocks());
  it("dry run writes nothing and sends nothing", async () => {
    const result = await runToday({ dryRun: true, now: new Date("2026-10-09T01:00:00Z") });
    expect(result.outcome).toBe("dry_run");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("rejects premature invocations without storage access", async () => {
    expect((await runToday({ now: new Date("2026-10-09T00:59:59Z") })).outcome).toBe("too_early");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("records the schedule and passes only explicit retry authorization", async () => {
    mocks.prepare.mockResolvedValue({ outcome: "created", run: { id: "run" } });
    await runToday({ now: new Date("2026-10-09T01:42:00Z") });
    expect(mocks.prepare).toHaveBeenCalledWith({ localDate: "2026-10-09", scheduledAt: "2026-10-09T01:00:00.000Z", retry: false });
    expect(mocks.notify).toHaveBeenCalledWith("run");
  });
  it("preserves a committed daily run when notification storage fails", async () => {
    mocks.prepare.mockResolvedValue({ outcome: "created", run: { id: "run" } });
    mocks.notify.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await runToday({ now: new Date("2026-10-09T01:00:00Z") })).outcome).toBe("created");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("does not loop on a database outage", async () => {
    mocks.prepare.mockRejectedValue(new Error("offline"));
    await expect(runToday({ now: new Date("2026-10-09T01:00:00Z") })).rejects.toThrow("offline");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("dispatches automatic mode without creating a manual review", async () => {
    mocks.data.mockResolvedValue({ config: { auto_mode: true }, posts: [] });
    mocks.automatic.mockResolvedValue({ outcome: "executed", mode: "automatic", run: { status: "auth_required" } });
    const result = await runToday({ now: new Date("2026-10-09T01:00:00Z") });
    expect(result.outcome).toBe("executed");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.automatic).toHaveBeenCalledWith(expect.objectContaining({ localDate: "2026-10-09", retry: false }));
  });
});
