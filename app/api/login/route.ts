import { checkPassword, createSession, requireOrigin, SESSION_COOKIE, SESSION_SECONDS } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { HttpError, readBody } from "@/lib/validation";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    requireOrigin(request);
    const { password } = await readBody(request);
    if (typeof password !== "string" || password.length > 500) throw new HttpError(400, "Password is required.");
    if (!checkPassword(password)) return json({ error: "Incorrect dashboard password." }, 401);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, createSession(), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
      path: "/", maxAge: SESSION_SECONDS
    });
    return response;
  });
}
