import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/workflow", () => ({ runToday: mocks.run }));
import { GET } from "@/app/api/cron/route";

describe("cron HTTP endpoint", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "c".repeat(48)); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("rejects unauthenticated calls before workflow execution", async () => {
    const response = await GET(new Request("https://daily.example.com/api/cron"));
    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("supports a protected read-only dry run", async () => {
    mocks.run.mockResolvedValue({ outcome: "dry_run", databaseWritten: false });
    const response = await GET(new Request("https://daily.example.com/api/cron?dryRun=1", { headers: { Authorization: `Bearer ${"c".repeat(48)}` } }));
    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith({ dryRun: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns a recoverable failure without leaking server errors", async () => {
    mocks.run.mockRejectedValue(new Error("secret-token must not leak"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET(new Request("https://daily.example.com/api/cron", { headers: { Authorization: `Bearer ${"c".repeat(48)}` } }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-token");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
