# Database and idempotency

Apply [001_initial.sql](../supabase/migrations/001_initial.sql), then [002_automation.sql](../supabase/migrations/002_automation.sql), in Supabase's SQL editor as the database owner. Existing installations apply only the missing second migration. Each migration runs transactionally; do not reapply one or delete history to repeat an action.

All application tables enable RLS and revoke client-role access. Privileged RPC execution is restricted to `service_role`, with constrained search paths. Keep the server key on the server; the dashboard receives sanitized records, never AWS session values or worker lease tokens.

| Table | Purpose |
| --- | --- |
| `app_config` | Shared pause switch, daily attempt budget, notifications, and `auto_mode` added by migration 002 |
| `queued_posts` | Canonical content URLs, optional candidates, and reserved/used state |
| `daily_runs`, `post_activities`, `execution_logs` | Original manual review records, user reports, and audit trail |
| `notification_deliveries` | Durably claimed manual workflow notifications |
| `automation_runs` | One automatic record per Manila date, selected post/account, attempts, status, and worker lease |
| `automation_actions` | One durable visit/like/comment attempt per run, phase, timestamps, and bounded diagnostics |
| `automation_logs` | Automatic claims, candidate decisions, action results, and notification events |
| `automation_notification_deliveries` | Unique result/authentication/failure webhook claim per automatic run/event |

## Automatic ownership and action claims

`claim_automation_run` locks the singleton configuration row, then the daily run. Disabled scheduling or manual mode returns no work. A new automatic run receives a private token and a four-minute lease. A duplicate request while that lease is active returns the existing run without the token, so it cannot become another worker.

Selected URLs are canonicalized by content ID. Selection checks prior automatic engagement, reserved/used queue state, and recorded manual engagement. `begin_automation_action` checks current ownership, lease, mode/pause configuration, date, selected post, action ordering, and prior claims. It commits the action's `started` record before the browser can submit anything. Like/comment claims consume an available matching queued link to prevent subsequent manual reservation.

Visit verification is required before a like claim, and like verification before a comment claim. The browser rechecks the AWS account/state and invokes `assert_automation_action_ready` immediately before external submission. This verifies ownership, configuration, date, selected post, and the still-started action claim. A stale token, expired lease, date change, pause, or mode change stops further submission. Finishing records can still preserve the result of an action that was already submitted.

The database assertion and AWS submission cannot be one transaction: configuration can change after the assertion, and a submitted request cannot be recalled. Persisting the claim before submission and freezing ambiguous outcomes protects against replay across this boundary. Browser verification reads the persisted AWS result after reload; database timestamps describe the recorded observation, not an AWS reward decision.

## Retries, expiry, and uncertain results

An explicit retry may recover `failed`, `auth_required`, or `no_post` before any engagement claim and within the configured attempt budget. A safely expired worker with no unresolved action or engagement claim also requires an explicit reclaim. Normal duplicate cron calls do not consume recovery attempts.

Any like/comment row blocks retry, including a failed or skipped attempt. Any `started` or `uncertain` action blocks replay. A verified visit can be retained for the exact same candidate; failed/skipped visit records are snapshotted before eligible retry. Retry must preserve a previously established account identity.

If a worker lease expires after an unresolved action or engagement claim, a subsequent claim records the run as `uncertain` rather than replaying it. A process crash can therefore leave a visible unresolved record until another claim reconciles the expired lease. Settled actions cannot be downgraded or overwritten. A `verified` run requires all three actions to be verified; an unresolved action requires an uncertain run.

Do not reset action phases, delete engagement claims, or change ledger history to force another submission. Reconcile an uncertain result by checking AWS and the evidence deliberately.

## Manual mode and notifications

The original `prepare_daily_run` reserves a queue candidate and creates a manual review in one database transaction. Manual activity records remain self-reported. Replacement/report functions protect completed and uncertain engagement; historical records cannot receive today's actions. Manual report, candidate replacement, and authentication-report API mutations are blocked while automatic mode is active. Automatic selection/action checks also consult tracked manual engagement.

Both notification ledgers use a unique `(run_id, kind)` key and move a delivery from `pending` to `sending` before HTTP submission. Claims cannot resend `sending`, `sent`, `failed`, or `uncertain` deliveries. A crash after claim may leave `sending` unresolved because the receiver could already have received the message. Inspect the receiver and logs rather than resetting the claim automatically.

Run/action notes and errors are length-limited and common credential patterns are redacted. No database column stores AWS passwords, raw browser cookies, or the encrypted AWS bundle. Keep deliberate database exports for backup. PGlite tests execute real PostgreSQL transitions locally; Supabase REST permissions, deployment connectivity, and live multi-worker behavior still require deployment verification.
