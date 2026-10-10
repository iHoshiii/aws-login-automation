import { describe, expect, it } from "vitest";
import { postUrl, readBody, runId } from "@/lib/validation";

describe("input validation", () => {
  it("canonicalizes real content IDs so slugs and tracking cannot bypass duplicate checks", () => {
    expect(postUrl("https://builder.aws.com/content/ABC123/title?source=mail#comments")).toBe("https://builder.aws.com/content/ABC123");
  });
  it.each([
    "https://builder.aws.com.evil.example/content/ABC", "http://builder.aws.com/content/ABC",
    "https://user:password@builder.aws.com/content/ABC", "https://builder.aws.com:8443/content/ABC",
    "javascript:alert(1)", "https://builder.aws.com/", "https://builder.aws.com/content/%2Fprivate"
  ])("rejects unsafe or unsupported post links: %s", value => expect(() => postUrl(value)).toThrow());
  it("rejects malformed UUIDs", () => {
    expect(runId("11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
    expect(() => runId("invalid")).toThrow();
  });
  it("bounds the actual JSON body and enforces an object", async () => {
    const request = (body: string) => new Request("https://example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    await expect(readBody(request('{"enabled":true}'))).resolves.toEqual({ enabled: true });
    await expect(readBody(request("[]"))).rejects.toThrow("Invalid JSON");
    await expect(readBody(request("{bad"))).rejects.toThrow("Invalid JSON");
    await expect(readBody(request(JSON.stringify({ message: "x".repeat(5000) })))).rejects.toThrow("too large");
  });
});
