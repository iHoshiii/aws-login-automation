import { SESSION_COOKIE } from "@/lib/auth";
import { handle, protectMutation } from "@/lib/http";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 0 });
    return response;
  });
}
