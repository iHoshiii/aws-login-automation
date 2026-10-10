import { beforeEach, describe, expect, it, vi } from "vitest";
const dashboard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/repository", () => ({ getDashboardData: dashboard }));
vi.mock("@/lib/time", () => ({ manilaDate: () => "2026-10-09" }));
import { requireCurrentRun } from "@/lib/current-run";

describe("manual review mutation guard", () => {
  beforeEach(() => { dashboard.mockReset(); });
  it("blocks manual edits while automatic mode is enabled", async () => {
    dashboard.mockResolvedValue({ config: { auto_mode: true }, runs: [{ id: "run", local_date: "2026-10-09" }] });
    await expect(requireCurrentRun("run")).rejects.toMatchObject({ status: 409 });
  });
  it("allows the current manual review after automatic mode is turned off", async () => {
    const run = { id: "run", local_date: "2026-10-09" };
    dashboard.mockResolvedValue({ config: { auto_mode: false }, runs: [run] });
    expect(await requireCurrentRun("run")).toEqual(run);
  });
  it("preserves the historical record guard in manual mode", async () => {
    dashboard.mockResolvedValue({ config: { auto_mode: false }, runs: [{ id: "run", local_date: "2026-10-08" }] });
    await expect(requireCurrentRun("run")).rejects.toMatchObject({ status: 409 });
  });
});
