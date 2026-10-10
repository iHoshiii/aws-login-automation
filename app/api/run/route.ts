import { handle, json, protectMutation } from "@/lib/http";
import { HttpError, readBody } from "@/lib/validation";
import { runToday } from "@/lib/workflow";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const body = await readBody(request);
    if (body.retry !== undefined && typeof body.retry !== "boolean") throw new HttpError(400, "Retry must be a boolean.");
    const result = await runToday({ retry: body.retry === true });
    if (result.outcome === "too_early") return json({ error: "Today's review can be prepared after 9:00 AM Philippine time." }, 409);
    if (result.outcome === "disabled") return json({ error: "Enable daily preparation before running it." }, 409);
    if (result.outcome === "retry_limit") return json({ error: "The daily preparation retry limit has been reached." }, 409);
    return json(result);
  });
}
