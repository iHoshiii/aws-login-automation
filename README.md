# AWS Login Automation

For daily activity on this Windows computer using the saved AWS session, see [the local daily task guide](docs/local-daily.md). It runs at 09:00 Singapore/Philippines time, prepares relevant comments, and reads the 30-day and 90-day visit, like and comment badges from Manage profile. The goal is 90 consecutive days for all three activities.

A private Next.js application that searches AWS Builder Center for a post your account has neither liked nor commented on, likes it, publishes your configured comment, verifies the observed results, and stores the daily run in Supabase. Vercel invokes the worker daily after **09:00 Philippine time**. A manual review mode remains available for earlier records and operator fallback.

Automatic execution requires a connected AWS session and a calibrated browser profile. The code can be tested without AWS, but real account access, live engagement, and production deployment must be verified with your account. A passing test suite does not establish AWS rewards or permission for automated engagement.

## How the automatic run works

`Vercel cron → validate secret and time → claim daily run → restore encrypted AWS session → verify account → discover candidates → inspect prior likes and comments → persist action attempt → act → reload and verify → store result`

The worker uses a headless Chromium browser. It searches the AWS feed and can also consider links in your optional dashboard queue. It checks the authenticated account and both engagement states before selecting a post. Already liked or commented posts are skipped. If the page, identity, controls, or complete comment history cannot be established, it skips the candidate or stops with a recorded error rather than assuming the post is untouched.

Each local date has one automatic run. Each action is claimed durably before its external interaction. Repeated cron calls return the existing record. An explicit retry can recover a failure before engagement, subject to the configured daily attempt limit; a recorded like or comment attempt cannot be replayed, including after a crash or an uncertain result. The database also checks prior tracked activity before allowing a post to be reused.

Run statuses are `running`, `verified`, `no_post`, `auth_required`, `failed`, and `uncertain`. The dashboard displays observed visit, like, and comment results without editable automatic attestations. **Verified** means the worker observed the result on AWS after its operation; check badges and streaks directly in your AWS profile. The run ledger uses `Asia/Manila`, while AWS streak rules may use a different day boundary; see [AWS research](docs/aws-research.md).

## Local setup

Use Node.js 22.17 or newer within the Node 22 release, or Node 24 or newer, and npm.

```powershell
npm ci
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
npx playwright install chromium
```

Create a Supabase project. In its SQL editor, run these files in order:

1. [001_initial.sql](supabase/migrations/001_initial.sql)
2. [002_automation.sql](supabase/migrations/002_automation.sql)

For an existing installation, apply only the missing second migration. The original manual records remain available. The automatic migration adds the worker's run, action, notification, and log tables and enables automatic mode by default. Server-only tables use RLS with access restricted to the service role. Review database names before applying migrations to a shared project.

Fill in the Supabase URL and server secret key, dashboard credentials, cron secret, and `APP_URL=http://localhost:3000` in `.env.local`. The Supabase publishable/anon key is unsuitable for the server's privileged operations.

Connect AWS locally:

```powershell
npm run aws:connect
```

Set `AWS_BUILDER_ID_EMAIL` to your Builder ID email. The helper also reads `.local/aws-account.env`, when present, or asks for your email. It opens the observed AWS sign-in dialog, fills your email and selects **Continue with Builder ID**. It preserves the active GitHub/Google flow and its popups, can select the available Google sign-in controls, and waits for a verified return to AWS. Complete passwords, passkeys, device verification, and MFA yourself. On AWS, open your account menu so the helper can verify its profile link before article calibration.

If Google rejects the test browser, use installed Chrome for the interactive login:

```powershell
npm run aws:connect -- --manual-browser
```

This opens a dedicated Chrome window with an isolated `.local/aws-manual-profile` and no automation connection during sign-in. Complete the provider/passkey flow yourself, return to AWS, close that dedicated window, then press Enter in the terminal. The helper waits for its Chrome process to close and reopens the same profile with a local connection for calibration and capture. Open your account menu again in the reopened AWS page, then follow the article/control prompts. Google [documents that some automated browser sign-ins may be blocked](https://support.google.com/accounts/answer/7675428?co=GENIE.Platform%3DDesktop&hl=en). A live attempt showed a rejection in Chrome for Testing; the specific cause was not established, and normal Chrome does not guarantee successful login.

Setup does not publish likes or comments. After verified account/control capture, the helper creates `.local/aws-session.env` containing `AWS_SESSION_KEY` and `AWS_SESSION_ENCRYPTED`. The export keeps AWS cookies/storage and excludes Google/GitHub session state. The dedicated local Chrome profile still contains sensitive login data and is ignored by Git; keep it private and do not substitute your everyday Chrome profile. Copy both generated session values privately into `.env.local`. Follow the detailed [AWS connection guide](docs/automatic-setup.md), then run the probe; connection remains unverified until capture and the live checks succeed.

Check the stored session and candidate state without publishing likes or comments:

```powershell
npm run aws:probe
npm run dev
```

Open `http://localhost:3000` and enter `ADMIN_PASSWORD`. The dashboard shows **Configured** when both AWS session values are present; only the browser check establishes that the session still works. After 09:00 Philippine time, **Run now** executes real engagement. Local development has no automatic cron scheduler.

## Environment variables

All values are server only. Real secrets belong in `.env.local` or Vercel environment settings.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | HTTPS Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Server secret or legacy service-role key |
| `CRON_SECRET` | Yes | Independent random secret, at least 32 characters |
| `ADMIN_PASSWORD` | Yes | Dashboard password, at least 16 characters |
| `DASHBOARD_SESSION_SECRET` | Yes | Independent random secret, at least 32 characters |
| `APP_URL` | Yes | Exact app origin, such as `http://localhost:3000` or the deployed HTTPS origin |
| `AWS_BUILDER_ID_EMAIL` | Optional | Builder ID email used during connection; if set on the worker, must match the email recorded in its session bundle |
| `AWS_SESSION_KEY` | Automatic mode | Helper-generated 32-byte encryption key encoded as 64 hexadecimal characters |
| `AWS_SESSION_ENCRYPTED` | Automatic mode | Helper-generated encrypted browser state and calibrated site profile |
| `AWS_COMMENT_TEXT` | Optional | Comment text to publish; defaults to `nice` |
| `AWS_LOCAL_CHROMIUM_PATH` | Optional | Local Chromium executable override; ordinarily use the Playwright browser installation |
| `AWS_MANUAL_CHROME_PATH` | Optional | Installed Google Chrome executable used by `aws:connect -- --manual-browser` when automatic detection cannot find it |
| `NOTIFICATION_WEBHOOK_URL` | Optional | HTTPS endpoint receiving generic JSON notifications |
| `NOTIFICATION_WEBHOOK_SECRET` | Optional | Bearer secret sent only to that endpoint |

Use separate secrets for each purpose. For application secrets, generate a random value locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`. The AWS helper generates its own encryption key. Configure `AWS_COMMENT_TEXT` with 1–500 characters you intend to publish; the worker uses this configured text and does not generate a post-specific response.

Dashboard sessions use signed HttpOnly cookies and expire after eight hours. POST handlers require the configured origin and an authenticated dashboard session. Cron authentication uses `CRON_SECRET`. AWS session values and the internal worker lease token are never returned to the dashboard browser. Browser storage can grant AWS account access; both the encrypted value and its key must be kept private. Reconnect after AWS expires or revokes the session. Provider/passkey interaction happens locally during connection; the production worker stops for challenges and requires reconnecting rather than bypassing them.

## Vercel deployment

1. Import a private repository into Vercel, or deploy through Vercel CLI, using the Next.js preset and a supported Node.js runtime.
2. Apply both migrations to the production Supabase project.
3. Add the required environment values, including the two helper-generated AWS values. Set `APP_URL` to the production origin. Configure `AWS_COMMENT_TEXT` deliberately.
4. Build and deploy production. Redeploy after changing environment values.
5. Confirm `/api/cron` and `0 1 * * *` in the Vercel cron panel. Enable the daily schedule and automatic mode in the dashboard.
6. Test the authenticated dry run, review the AWS probe, then inspect the recorded result of your first real daily execution.

The production worker packages `@sparticuz/chromium` with `playwright-core` for Linux x64. Browser binaries are included in the cron/run function trace, and these handlers request a 180-second maximum duration. No paid remote browser service is configured. Live Vercel browser compatibility and AWS session acceptance still require a production probe; a successful local build cannot establish them.

The cron schedule is 01:00 UTC. Vercel Hobby schedules execution within **09:00–09:59 Philippine time**; exact timing and runtime limits depend on the deployment plan. Cron runs on production deployments, and Vercel does not automatically retry a failed invocation. See [platform research](docs/platform-research.md) and the official [Vercel cron documentation](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Testing

```powershell
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Unit and database tests use isolated fixtures and an embedded PostgreSQL engine. Browser fixture tests inspect a controlled local page rather than an AWS account. End-to-end tests cover this application's authentication and dry-run behavior with test credentials. These commands do not publish AWS likes or comments.

For a deployed cron authentication/time probe, load `APP_URL` and `CRON_SECRET` into your PowerShell environment, then run:

```powershell
Invoke-RestMethod -Uri "$env:APP_URL/api/cron?dryRun=1" -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

This dry run returns schedule metadata without database writes, AWS browser execution, or webhook delivery. It is different from `npm run aws:probe`, which opens AWS in a browser and inspects account/candidate state without publishing likes or comments. Neither is a real engagement test.

To test actual execution after 09:00, use **Run now**, wait for the response, and inspect the run status, selected post, action records, and logs. Open the post on AWS to compare the observations. Calling the normal run endpoint again should return the same daily record; only a permitted explicit retry starts a new attempt. Do not remove action records to force an engagement replay.

## Recovery

| Result | Next step |
| --- | --- |
| `auth_required` | Run `npm run aws:connect` again, replace both session values, restart/redeploy, and probe. Retry only if the dashboard offers it. |
| `no_post` | The scanned candidates were ineligible or could not be inspected. Queue a candidate or try a permitted explicit retry. |
| `failed` before engagement | Read the log, fix setup/connectivity/layout problems, then use the bounded retry if offered. |
| Expired worker before engagement | Use the offered explicit retry only when no unresolved action or engagement claim exists. |
| `uncertain` or an engagement already claimed | Inspect AWS and the recorded evidence. The run does not automatically repeat the like or comment. |
| Missing scheduled run | Check Vercel cron logs and Supabase availability; start today's run after 09:00. |
| Changed AWS controls | Reconnect and recalibrate, then use the read-only probe before another eligible run. |

The daily schedule switch pauses future automatic or manual runs. Turning automatic mode off selects the manual review workflow. Completed or ambiguous automatic actions stay protected across mode changes. Missed days do not receive retrospective activity credit.

Webhook notifications are optional and disabled by default. A configured receiver can receive run results, authentication problems, and failures. This is a generic JSON webhook, so Slack/Discord/email services may need an adapter you control. Delivery is claimed in storage before sending and is not automatically resent after an ambiguous result. Inspect your receiver and the app log if delivery fails.

## Research and account prerequisites

The initial implementation used the manual fallback in the original brief. The current implementation adds automatic engagement following the user's later instruction to proceed. This change does not establish AWS approval or a documented engagement API. The official [AWS FAQ](https://builder.aws.com/faq) identifies repetitive, low-value content as unsuitable. Review the configured comment and the platform's current rules for your use.

[AWS research](docs/aws-research.md), [platform research](docs/platform-research.md), and earlier [planning notes](docs/plan.md) retain the original investigation and decisions; current setup and behavior are described here and in [automatic setup](docs/automatic-setup.md). Supabase/Vercel account setup, connected AWS calibration, authenticated live verification, and production deployment remain account-specific steps.
