import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { BrowserContext } from "playwright-core";
import type { SiteProfile } from "./site";
import { builderIdEmail } from "./login";

export interface AwsSessionBundle {
  version: 1;
  capturedAt: string;
  builderIdEmail?: string;
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  profile: SiteProfile;
}

function keyBytes(key: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("AWS_SESSION_KEY must contain 64 hexadecimal characters.");
  return Buffer.from(key, "hex");
}

export function generateSessionKey(): string { return randomBytes(32).toString("hex"); }

/** The AWS worker does not need the owner's Google or GitHub login cookies. */
export function awsOnlyStorageState(state: AwsSessionBundle["storageState"]): AwsSessionBundle["storageState"] {
  const allowed = (hostname: string) => {
    const host = hostname.toLowerCase().replace(/^\./, "");
    return host === "aws.com" || host === "builder.aws.com" || host.endsWith(".builder.aws.com") || host === "aws.amazon.com" || host.endsWith(".aws.amazon.com");
  };
  return {
    cookies: state.cookies.filter(cookie => allowed(cookie.domain)),
    origins: state.origins.filter(origin => { try { const url = new URL(origin.origin); return url.protocol === "https:" && allowed(url.hostname); } catch { return false; } })
  };
}

export function encryptSession(bundle: AwsSessionBundle, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from("builder-automation-session-v1"));
  const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(bundle))), cipher.final()]);
  const value = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  if (Buffer.byteLength(value) > 60000) throw new Error("Session is too large for a Vercel environment variable. Remove unrelated browser storage and reconnect.");
  return value;
}

export function decryptSession(value: string, key: string): AwsSessionBundle {
  try {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || value.length > 60000) throw new Error();
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
    decipher.setAAD(Buffer.from("builder-automation-session-v1"));
    decipher.setAuthTag(tag);
    const data = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]);
    const bundle = JSON.parse(gunzipSync(data, { maxOutputLength: 1_000_000 }).toString("utf8"));
    if (bundle.version !== 1 || !Number.isFinite(Date.parse(bundle.capturedAt)) ||
        !bundle.storageState || !Array.isArray(bundle.storageState.cookies) || !Array.isArray(bundle.storageState.origins) || !bundle.profile) throw new Error();
    return bundle as AwsSessionBundle;
  } catch { throw new Error("AWS session is missing, invalid or cannot be decrypted. Run npm run aws:connect again."); }
}

export function loadSessionFromEnvironment(): AwsSessionBundle {
  const encrypted = process.env.AWS_SESSION_ENCRYPTED;
  const key = process.env.AWS_SESSION_KEY;
  if (!encrypted || !key) throw new Error("AWS session is not configured. Run npm run aws:connect and configure its two server-only secrets.");
  const session = decryptSession(encrypted, key);
  if (process.env.AWS_BUILDER_ID_EMAIL?.trim() && session.builderIdEmail !== builderIdEmail(process.env.AWS_BUILDER_ID_EMAIL)) {
    throw new Error("The connected session belongs to a different configured Builder ID. Run npm run aws:connect again.");
  }
  return session;
}
