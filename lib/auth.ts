import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { HttpError } from "./validation";

export const SESSION_COOKIE = "builder_daily_session";
export const SESSION_SECONDS = 8 * 60 * 60;

export function secureEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function authSettings() {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!password || password.length < 16 || !secret || secret.length < 32) {
    throw new HttpError(503, "Configure ADMIN_PASSWORD (16+ characters) and DASHBOARD_SESSION_SECRET (32+ characters).");
  }
  return { password, secret };
}

function signature(payload: string) {
  const { password, secret } = authSettings();
  return createHmac("sha256", secret).update(payload).update(createHash("sha256").update(password).digest()).digest("base64url");
}

export function checkPassword(password: string): boolean {
  return secureEqual(password, authSettings().password);
}

export function createSession(now = Date.now()): string {
  const payload = `v1.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  return `${payload}.${signature(payload)}`;
}

export function verifySession(token: string | undefined, now = Date.now()): boolean {
  if (!token || token.length > 150) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{10}$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  const current = Math.floor(now / 1000);
  if (expires <= current || expires > current + SESSION_SECONDS) return false;
  try { return secureEqual(parts[2], signature(`${parts[0]}.${parts[1]}`)); } catch { return false; }
}

export async function isDashboardAuthenticated(): Promise<boolean> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireDashboard() {
  if (!await isDashboardAuthenticated()) throw new HttpError(401, "Sign in to the dashboard again.");
}

export function requireOrigin(request: Request) {
  const configured = process.env.APP_URL;
  if (!configured) throw new HttpError(503, "Configure APP_URL with the exact dashboard origin.");
  let origin: string;
  try {
    const url = new URL(configured);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error();
    origin = url.origin;
  } catch { throw new HttpError(503, "APP_URL must use HTTPS (HTTP is allowed on localhost)."); }
  if (request.headers.get("origin") !== origin) throw new HttpError(403, "Request origin is not allowed.");
}

export function requireCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, "Configure CRON_SECRET with at least 32 characters.");
  if (!secureEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    throw new HttpError(401, "Unauthorized cron request.");
  }
}
