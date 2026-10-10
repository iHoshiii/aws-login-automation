import { handle, json, protectMutation } from "@/lib/http";
import { updateConfig } from "@/lib/repository";
import { HttpError, readBody } from "@/lib/validation";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean" || typeof body.notifications_enabled !== "boolean" ||
        typeof body.max_attempts !== "number" || !Number.isInteger(body.max_attempts) || body.max_attempts < 1 || body.max_attempts > 3) {
      throw new HttpError(400, "Provide enabled, notifications_enabled and an attempt limit from 1 to 3.");
    }
    if (body.auto_mode !== undefined && typeof body.auto_mode !== "boolean") throw new HttpError(400, "Automatic mode must be a boolean.");
    return json({ config: await updateConfig({ enabled: body.enabled, notifications_enabled: body.notifications_enabled, max_attempts: body.max_attempts, ...(body.auto_mode !== undefined ? {auto_mode:body.auto_mode} : {}) }) });
  });
}
