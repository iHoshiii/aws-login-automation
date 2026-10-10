import { requireCron } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { runToday } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(request: Request) {
  return handle(async () => {
    requireCron(request);
    const url = new URL(request.url);
    return json(await runToday({ dryRun: url.searchParams.get("dryRun") === "1" }));
  });
}
