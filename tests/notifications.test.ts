import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/repository", () => ({ claimNotification: mocks.claim, finishNotification: mocks.finish }));
import { notifyRun } from "@/lib/notifications";

describe("notification delivery", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NOTIFICATION_WEBHOOK_URL", "https://notify.example.com/hook");
    mocks.claim.mockResolvedValue({ id: "run", local_date: "2026-10-09", status: "pending_review" });
    mocks.finish.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("sends nothing when a durable notification was already claimed", async () => {
    mocks.claim.mockResolvedValue(null);
    await notifyRun("run");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("marks a successful HTTP response without claiming the user read it", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await notifyRun("run");
    expect(mocks.finish).toHaveBeenCalledWith("run", "sent", expect.stringContaining("reading is unverified"), "review");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
  it("does not retry an uncertain network outcome", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    await notifyRun("run", "auth_required");
    expect(mocks.finish).toHaveBeenCalledWith("run", "uncertain", expect.stringContaining("may have arrived"), "auth_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("records a HTTP failure and a missing endpoint without loops", async () => {
    fetchMock.mockResolvedValue(new Response("failure", { status: 503 }));
    await notifyRun("run", "activity_failed");
    expect(mocks.finish).toHaveBeenCalledWith("run", "failed", expect.stringContaining("503"), "activity_failed");
    vi.stubEnv("NOTIFICATION_WEBHOOK_URL", "");
    await notifyRun("run");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
