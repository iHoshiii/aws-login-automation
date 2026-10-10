import { redirect } from "next/navigation";
import { Monitor } from "@/components/monitor";
import { isDashboardAuthenticated } from "@/lib/auth";
import { buildMonitorData } from "@/lib/monitor";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isDashboardAuthenticated())) redirect("/login");
  return <Monitor data={await buildMonitorData(new Date())} />;
}
