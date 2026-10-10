import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { isDashboardAuthenticated } from "@/lib/auth";
import { getDashboardData } from "@/lib/repository";
import { getAutomationHistory } from "@/lib/automation-repository";
import { manilaDate, nextScheduledTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isDashboardAuthenticated())) redirect("/login");

  let data: Awaited<ReturnType<typeof getDashboardData>> | null = null;
  let automation: Awaited<ReturnType<typeof getAutomationHistory>> | null = null;
  try {
    const results = await Promise.allSettled([getDashboardData(), getAutomationHistory()]);
    if (results[0].status === "fulfilled") data = results[0].value;
    if (results[1].status === "fulfilled") automation = results[1].value;
  } catch { /* Render a setup state without exposing connection details. */ }

  if (!data) {
    return (
      <main className="setup-shell">
        <div className="brand"><span className="brand-mark" aria-hidden="true">d.</span><span>Daily Review</span></div>
        <section className="setup-card">
          <span className="eyebrow">Connection needed</span>
          <h1>Your dashboard is ready for setup.</h1>
          <p>Daily activity records could not be loaded. Configure the Supabase environment variables, apply both database migrations, and verify that the database is reachable.</p>
          <div className="setup-checklist">
            <p><strong>1.</strong> Set <code>SUPABASE_URL</code> and <code>SUPABASE_SECRET_KEY</code> in your environment.</p>
            <p><strong>2.</strong> Apply <code>001_initial.sql</code>, then <code>002_automation.sql</code>, as described in the project README.</p>
            <p><strong>3.</strong> Restart the application or redeploy, then reload this page.</p>
          </div>
          <p className="small muted">No activity has been started from this page. Check server logs for connection details; secrets are never shown here.</p>
          <a className="button primary" href="/">Reload dashboard</a>
        </section>
      </main>
    );
  }

  const now = new Date();
  return (
    <Dashboard
      data={data}
      automation={automation}
      sessionConfigured={Boolean(process.env.AWS_SESSION_ENCRYPTED && process.env.AWS_SESSION_KEY)}
      nextScheduledAt={nextScheduledTime(now).toISOString()}
      today={manilaDate(now)}
      checkedAt={now.toISOString()}
    />
  );
}
