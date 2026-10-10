# Platform feasibility and stack decision

Checked against official documentation on 2026-10-09. These are provider facts, not proof that AWS permits automated engagement or that an AWS account can be accessed headlessly.

## Scheduling and execution

Vercel invokes a cron path using HTTP GET against the production deployment. Expressions always use UTC. The requested `0 1 * * *` means 01:00 UTC, corresponding to 09:00 Asia/Manila. Cron scheduling does not run automatically on local development servers. [Vercel Cron overview](https://vercel.com/docs/cron-jobs), [management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

| Plan | Minimum interval per cron job | Expected invocation window for this schedule |
| --- | --- | --- |
| Hobby | Once daily | 09:00:00–09:59:59 Manila |
| Pro / Enterprise | Once per minute | 09:00:00–09:00:59 Manila |

Current documentation permits 100 cron jobs per project on each plan. Cron jobs are included; function resource limits and charges still apply. Hobby cannot guarantee an exact 09:00 execution. Even paid precision does not imply guaranteed delivery. [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Set `CRON_SECRET` to a random secret of at least 16 characters. Vercel supplies `Authorization: Bearer <secret>`; the handler must validate it. Cron delivery is best effort: an invocation may be missed or duplicated. Failed jobs are not automatically retried. Jobs can overlap, redirects are not followed, and requests that never reach the function produce no runtime log. [Vercel Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The provider's 16-character recommendation is a minimum in its documentation. This application requires at least 32 characters for its cron secret and dashboard session-signing secret, and at least 16 characters for its administrator password.

Implementation decision: use one daily cron, a unique Manila date and atomic database claim, bounded operator retries, and persisted status. Missed days remain missed; a later review cannot earn yesterday's AWS activity. Mark uncertain outcomes for manual reconciliation rather than replaying them. Show a due/missed warning in the dashboard when today's record is absent after the expected scheduling window.

## Browser feasibility and authentication

With Fluid Compute, Hobby functions have 300-second default/maximum duration and 2 GB memory. The ordinary Node.js uncompressed function bundle limit is 250 MB. Vercel now documents a 5 GB large-function beta, but this project need not rely on a beta feature. Cron duration is the function duration. [Vercel Functions limits](https://vercel.com/docs/functions/limitations).

Playwright requires matching browser binaries and OS dependencies. Its full browsers occupy hundreds of megabytes; installing only Chromium's headless shell can reduce deployment size. A successful development install alone therefore does not establish Vercel compatibility. [Playwright browsers](https://playwright.dev/docs/browsers). Playwright warns that a supplied custom executable has no compatibility guarantee. [BrowserType launch API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path).

Implementation now packages `@sparticuz/chromium` with `playwright-core` for Linux x64 Vercel functions. Next.js function tracing explicitly includes the browser binaries for `/api/cron` and `/api/run`; these handlers request a 180-second maximum duration, and the worker uses a smaller execution budget. This is an implemented runtime configuration, not evidence of a successful Vercel launch or authenticated AWS execution. Account and deployment compatibility still require a live probe.

The initial manual-only design avoided a runtime browser and stored no AWS session. The user's later instruction to proceed superseded that implementation choice. The current worker discovers posts, inspects prior likes and account-authored comments, performs durably claimed actions, and verifies persisted observations after reload. Manual review remains a separate optional mode. Control structure is validated against the profile captured from the owner's actual signed-in page; unavailable or ambiguous state causes a skip or recorded failure.

Playwright storage state can grant account access. `npm run aws:connect` obtains it through local interactive login and account/control calibration, then exports an AES-256-GCM encrypted bundle with a separate encryption key. Both values belong in server-only environment settings; neither raw browser state nor AWS passwords are stored in database tables. The helper output directory is ignored by Git. Reconnect when AWS expires the session, and stop on MFA, CAPTCHA, or access challenges. A dashboard login does not prove an active AWS login. [Playwright authentication](https://playwright.dev/docs/auth).

## Persistent storage and security

Supabase Free costs $0, includes 500 MB of database storage, and limits accounts to two active projects. It can pause after a week of inactivity and does not include automatic backups. This is suitable for a small personal tracker but is not an availability guarantee. Restore paused projects in the dashboard and keep deliberate exports if history matters. Pro currently starts at $25/month and is optional. [Supabase pricing](https://supabase.com/pricing), [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod).

Use Supabase's Data API from the Next.js server and Postgres RPCs for atomic claim/completion transactions; this avoids managing Postgres connections in short-lived functions. If direct SQL connections are introduced later, Supabase recommends transaction-pooler mode for serverless workloads. [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

Supabase recommends current secret keys over legacy service-role keys where possible. Both are elevated backend credentials that bypass RLS. Keep the key in Vercel environment variables and enforce dashboard authorization in the application. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).

Enable RLS on every exposed table; revoke client-role grants when the browser has no direct database access. A publishable key grants no rows after RLS is enabled without a matching policy. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security). RPC functions are executable by any role by default, so explicitly revoke `PUBLIC`, `anon`, and `authenticated` execution and grant only the server role. Prefer `SECURITY INVOKER`; a definer function requires a constrained search path and careful access checks. [Supabase database functions](https://supabase.com/docs/guides/database/functions).

Implementation decision: use database uniqueness, leased worker claims, and durable per-action intent rather than process memory or local files for idempotency. Migration 002 adds separate automatic run/action/log tables. A lease/configuration assertion immediately before external submission rejects a stale, paused, or changed worker. Uncertain actions remain protected from replay. Database records distinguish worker observations from manual attestations; neither establishes an AWS reward.

Notifications use durable, unique `(run_id, kind)` delivery records. Automatic events cover results, authentication requirements, and failures; manual events retain review/authentication/activity-failure delivery records. A claim moves `pending` to `sending` before a webhook request. A second request cannot resend `sending`, `sent`, `failed`, or `uncertain`; ambiguous delivery needs operator inspection. A process stopping after claim can leave `sending` unresolved. Do not automatically reset or resend it.

## Selected low-cost stack

- Next.js App Router with TypeScript and Node.js route handlers on Vercel Hobby.
- One Vercel cron at `0 1 * * *` and a documented hour-wide window.
- Supabase Free Postgres, accessed only from the server.
- A private dashboard for automatic action observations, pause/resume, bounded retries, errors, and secondary manual records.
- `playwright-core` with packaged Chromium for the worker; Playwright also tests controlled fixtures and application access locally.

Next.js supports Windows development. This project requires Node 22.17 or newer within the Node 22 release, or Node 24 or newer, to satisfy its selected runtime dependencies. Run ESLint separately: Next.js 16 does not run lint as part of `next build`. Dependency versions are recorded in the lockfile. [Next.js installation](https://nextjs.org/docs/app/getting-started/installation).

Never prefix secrets with `NEXT_PUBLIC_`, which causes Next.js to inline values into browser JavaScript. Keep local environment files out of version control and use server-only modules for privileged database access. [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables).

No paid remote browser service, Redis, or external queue is configured. Supabase stores the worker ledger and notification claims. Out-of-app alerts require a separately configured webhook receiver. Live AWS engagement, reward eligibility, Vercel runtime compatibility, and notification receipt remain account-specific validation steps; the local tests do not establish them.
