import { handle, json, protectMutation } from "@/lib/http";
import { replacePost } from "@/lib/repository";
import { requireCurrentRun } from "@/lib/current-run";
import { readBody, runId } from "@/lib/validation";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const id = runId((await readBody(request)).runId);
    await requireCurrentRun(id);
    await replacePost(id);
    return json({ ok: true });
  });
}
