import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="login-shell">
      <section className="login-intro">
        <div className="brand light"><span className="brand-mark" aria-hidden="true">d.</span><span>Daily Activity</span></div>
        <div className="login-intro-copy">
          <span className="eyebrow">A little structure. Every day.</span>
          <h1>Keep your daily<br />activity on track.</h1>
          <p>Find an eligible Builder Center post, run your daily activity, and review the results in one private dashboard.</p>
          <div className="login-schedule"><span className="schedule-dot" aria-hidden="true" /><span>Scheduled for 9:00 AM <span className="muted-light">· Asia/Manila</span></span></div>
        </div>
        <p className="login-footnote">Connect AWS locally through the setup helper. The worker uses your encrypted session; the dashboard never asks for your AWS password.</p>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <span className="eyebrow">Private dashboard</span>
          <h2 id="login-title">Welcome back.</h2>
          <p className="muted">Enter your dashboard password to continue.</p>
          <LoginForm />
          <p className="small muted login-password-note">Use the password configured for this app. Your AWS password is never requested here.</p>
        </div>
      </section>
    </main>
  );
}
