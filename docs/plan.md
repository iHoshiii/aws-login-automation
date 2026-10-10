# Implementation plan and current scope

The original brief selected manual review when AWS automation permission was unclear. The initial implementation followed that fallback. The owner's later instruction to proceed superseded the manual-only implementation choice; the project now contains an automatic engagement worker and retains manual records as a secondary mode. AWS permission and reward eligibility remain research uncertainties, not verified outcomes.

The implemented scope is:

1. A private Next.js App Router dashboard with password authentication, signed HttpOnly sessions, origin checks, and server-only database/cron/AWS secrets.
2. Supabase migrations 001 and 002, preserving manual history while adding separate automatic runs, actions, logs, notifications, leased worker ownership, and shared pause/mode controls.
3. Local `aws:connect` for interactive AWS login and calibration of observed account/comment controls, exporting encrypted browser state. Login challenges remain interactive.
4. A Chromium/Playwright worker that verifies the connected identity, discovers feed candidates, considers optional queued links, and inspects both existing likes and account-authored comments before selecting an eligible post.
5. Durable action claims before external interaction, rechecking AWS state and database lease/configuration immediately before submission, and verifying persisted like/comment observations after reload. Ambiguous outcomes cannot be replayed automatically.
6. A protected daily cron at `0 1 * * *`, one automatic record per Manila date, a bounded execution budget, and explicit retries only before engagement. A metadata dry run does not launch AWS or write storage.
7. Automatic action/history/log views, session-configuration status, operator retry controls, pause/mode settings, an optional queue, secondary manual history, and durably claimed webhook delivery.
8. Local tests covering permissions, clocks, action claims, retry/uncertainty behavior, browser fixtures, and dashboard access/controls. The [validation record](validation.md) contains the actual completed checks.
9. Account-specific setup and deployment instructions in the [README](../README.md) and [automatic setup guide](automatic-setup.md).

The configured Vercel runtime packages Chromium without a paid remote browser service. Its Hobby cron executes within the selected hour, without guaranteeing exactly 09:00. Local fixture tests establish implementation behavior; connected AWS calibration, actual account engagement, Vercel browser execution, and AWS badge/streak eligibility still require live validation with the owner's accounts.
