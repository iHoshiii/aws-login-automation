import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPassword, createSession, requireCron, requireOrigin, SESSION_SECONDS, verifySession } from "@/lib/auth";

const now = new Date("2026-10-09T01:00:00Z").getTime();
describe("dashboard and cron authentication", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_PASSWORD", "test-password-long-enough-123");
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "s".repeat(48));
    vi.stubEnv("CRON_SECRET", "c".repeat(48));
    vi.stubEnv("APP_URL", "https://daily.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("checks the password and signs a bounded session", () => {
    expect(checkPassword("wrong")).toBe(false);
    expect(checkPassword("test-password-long-enough-123")).toBe(true);
    const session = createSession(now);
    expect(verifySession(session, now)).toBe(true);
    expect(verifySession(session, now + SESSION_SECONDS * 1000)).toBe(false);
    expect(verifySession(session.replace("v1", "v2"), now)).toBe(false);
    expect(verifySession(session + "x", now)).toBe(false);
  });
  it("invalidates sessions after credential rotation", () => {
    const token = createSession(now);
    vi.stubEnv("ADMIN_PASSWORD", "changed-password-long-enough");
    expect(verifySession(token, now)).toBe(false);
  });
  it("fails closed with missing or weak configuration", () => {
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "weak");
    expect(() => createSession(now)).toThrow();
    expect(verifySession("v1.1791500000.signature", now)).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(() => requireCron(new Request("https://daily.example.com/api/cron"))).toThrow();
  });
  it("requires the exact cron bearer token", () => {
    const request = (authorization: string) => new Request("https://daily.example.com/api/cron", { headers: { authorization } });
    expect(() => requireCron(request(`Bearer ${"c".repeat(48)}`))).not.toThrow();
    expect(() => requireCron(request("Bearer wrong"))).toThrow();
    expect(() => requireCron(request(""))).toThrow();
  });
  it("blocks foreign or absent origins and invalid production origins", () => {
    const request = (origin?: string) => new Request("https://daily.example.com/api/config", { headers: origin ? { origin } : {} });
    expect(() => requireOrigin(request("https://daily.example.com"))).not.toThrow();
    expect(() => requireOrigin(request("https://attacker.example"))).toThrow();
    expect(() => requireOrigin(request())).toThrow();
    vi.stubEnv("APP_URL", "http://daily.example.com");
    expect(() => requireOrigin(request("http://daily.example.com"))).toThrow();
  });
});
