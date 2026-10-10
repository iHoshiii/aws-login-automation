import { afterEach, describe, expect, it, vi } from "vitest";
import { awsOnlyStorageState, decryptSession, encryptSession, generateSessionKey, loadSessionFromEnvironment, type AwsSessionBundle } from "@/lib/aws/session";

const bundle = { version: 1, capturedAt: "2026-10-09T01:00:00Z", storageState: { cookies: [], origins: [] }, profile: { version: 1, capturedAt: "2026-10-09T01:00:00Z", accountProfileUrl: "https://builder.aws.com/community/@test", accountSelector: "#observed-account", likeSelector: "#fixture-like", commentEditorSelector: "#observed-editor", commentSubmitSelector: "#observed-submit" } } satisfies AwsSessionBundle;

describe("encrypted AWS session storage", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("round trips and uses fresh IVs", () => {
    const key = generateSessionKey();
    const encrypted = encryptSession(bundle, key);
    expect(decryptSession(encrypted, key)).toEqual(bundle);
    expect(encryptSession(bundle, key)).not.toBe(encrypted);
    expect(encrypted).not.toContain("observed-account");
    expect(encrypted).not.toContain(bundle.profile.accountProfileUrl);
  });
  it("rejects corrupted envelopes and credential rotation", () => {
    const encrypted = encryptSession(bundle, generateSessionKey());
    expect(() => decryptSession(encrypted, generateSessionKey())).toThrow("cannot be decrypted");
    expect(() => decryptSession("v1.bad.invalid.data", "a".repeat(64))).toThrow();
    expect(() => encryptSession(bundle, "weak")).toThrow("64 hexadecimal");
  });
  it("requires a reconnection when the configured Builder ID changes", () => {
    const key = generateSessionKey();
    vi.stubEnv("AWS_SESSION_KEY", key);
    vi.stubEnv("AWS_SESSION_ENCRYPTED", encryptSession({ ...bundle, builderIdEmail: "owner@example.com" }, key));
    vi.stubEnv("AWS_BUILDER_ID_EMAIL", "OWNER@example.com");
    expect(loadSessionFromEnvironment().builderIdEmail).toBe("owner@example.com");
    vi.stubEnv("AWS_BUILDER_ID_EMAIL", "another@example.com");
    expect(() => loadSessionFromEnvironment()).toThrow("different configured Builder ID");
  });
  it("excludes Google and GitHub credentials from the AWS worker's exported session", () => {
    const domains = [".builder.aws.com", "profile.aws.amazon.com", ".google.com", "github.com", "builder.aws.com.attacker.example"];
    const state = {
      cookies: domains.map(domain => ({ name: "fixture", value: "fixture-only", domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const })),
      origins: ["https://builder.aws.com", "https://profile.aws.amazon.com", "https://accounts.google.com", "https://github.com", "http://builder.aws.com"].map(origin => ({ origin, localStorage: [{ name: "fixture", value: "fixture-only" }] }))
    };
    const exported = awsOnlyStorageState(state);
    expect(exported.cookies.map(cookie => cookie.domain)).toEqual([".builder.aws.com", "profile.aws.amazon.com"]);
    expect(exported.origins.map(origin => origin.origin)).toEqual(["https://builder.aws.com", "https://profile.aws.amazon.com"]);
  });
});
