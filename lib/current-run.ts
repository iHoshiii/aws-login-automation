import { getDashboardData } from "./repository";
import { manilaDate } from "./time";
import { HttpError } from "./validation";

export async function requireCurrentRun(id: string) {
  const data = await getDashboardData();
  if (data.config.auto_mode === true) throw new HttpError(409, "Turn automatic mode off before editing a manual review.");
  const run = data.runs.find(run => run.id === id);
  if (!run) throw new HttpError(404, "Run was not found.");
  if (run.local_date !== manilaDate(new Date())) throw new HttpError(409, "This review belongs to an earlier Philippine date. Prepare today's review instead.");
  return run;
}
