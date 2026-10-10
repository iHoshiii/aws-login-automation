"use client";

import { useState, type FormEvent } from "react";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Sign-in failed. Please try again.");
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect. Please try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="login-form">
      <label htmlFor="dashboard-password">Monitor password</label>
      <input id="dashboard-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} aria-describedby={error ? "login-error" : undefined} />
      {error && <p id="login-error" className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={pending}>{pending ? "Signing in…" : "Open monitor"}<span aria-hidden="true">→</span></button>
    </form>
  );
}
