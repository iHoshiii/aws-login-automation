import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const files = vi.hoisted(() => ({ exists: vi.fn(), read: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: files.exists, readFileSync: files.read }));
import { loadLocalAwsEnvironment } from "@/lib/aws/local-environment";

describe("private local Builder ID settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AWS_BUILDER_ID_EMAIL", "");
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    files.exists.mockImplementation((path: string) => path === ".local/aws-account.env");
    files.read.mockReturnValue("\uFEFFAWS_BUILDER_ID_EMAIL=owner@example.com\r\n");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("reads the owner setting written by Windows with a UTF-8 BOM", () => {
    loadLocalAwsEnvironment();
    expect(process.env.AWS_BUILDER_ID_EMAIL).toBe("owner@example.com");
    expect(process.loadEnvFile).not.toHaveBeenCalled();
  });
  it("preserves an explicitly configured account instead of overriding it", () => {
    vi.stubEnv("AWS_BUILDER_ID_EMAIL", "configured@example.com");
    loadLocalAwsEnvironment();
    expect(process.env.AWS_BUILDER_ID_EMAIL).toBe("configured@example.com");
    expect(files.read).not.toHaveBeenCalled();
  });
});
