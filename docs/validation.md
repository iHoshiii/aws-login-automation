# Validation record

Validated locally on October 10, 2026 with Node.js 24.13.0 on Windows.

| Check | Result |
| --- | --- |
| `npm test` | 159 tests passed across 18 suites |
| Private account configuration tests | Included above: Windows UTF-8 BOM handling and configured-account precedence |
| Actual migrations/RPC tests | Both migrations exercised in PGlite; 47 PostgreSQL transition/permission tests passed |
| AWS adapter/login/picker/federation browser fixtures | 45 tests passed using isolated Chromium pages |
| Manual Chrome connection tests | Five passed: no automation during human login, wait for window closure, reuse dedicated profile, validate loopback endpoint, stop only the owned capture process |
| `npm run test:e2e` | Four application authentication/HTTP tests passed |
| `npm run lint` | Passed after the final account-helper changes |
| `npm run typecheck` | Passed after the final account-helper changes |
| `npm run build` | Production build passed, including automatic worker routes |
| Production browser trace check | Both worker routes include four Chromium assets; each route/shared-server trace union is approximately 101.5 MiB locally |
| `npm audit` | Zero reported vulnerabilities, including development dependencies |
| `npm run aws:probe` without a connected session | Expected nonzero exit with a reconnect message; no AWS action or database operation |

Coverage includes Philippine date boundaries, scheduled execution, dashboard/cron authentication, origin checks, credential rotation, URL/body validation, daily claims, explicit retry limits, safe expired-worker recovery, immutable uncertain actions, lease/configuration rechecks immediately before submission, database permissions, candidate exclusion, complete comment history, identity/control changes, persisted fixture results, and stopped submission after a rejected fence or execution deadline.

The connection helper's picker is tested with enabled and disabled submit controls; selecting them submits nothing. Builder ID fixture tests verify that the helper fills the requested email only on the expected AWS origin and starts the observed login flow without handling a password. They require positive account evidence in the signed-in header. Federation fixtures verify provider selection, related popups, preserved OAuth context, one-attempt controls, rejected Google sign-in, and device/manual waiting states. Session tests verify encryption, corruption/rotation rejection, configured-account changes, and exclusion of Google/GitHub cookies from the AWS worker bundle.

Fixtures intercept all page requests locally and do not use an AWS account. Application end-to-end tests use dedicated test credentials and no Supabase account. PGlite verifies actual SQL statements, constraints and privileges; it does not emulate a production multi-connection load test. The committed RPCs use transactional row locks for production concurrency.

Public AWS navigation established the Latest feed, article like-state controls, top-level comment pagination, and the initial email sign-in dialog. It did not establish authenticated engagement compatibility. An authorized interactive attempt continued the owner's existing GitHub OAuth screen through Google and entered the requested email. Google returned its rejection screen before passkey authentication. No authenticated account or AWS action was established by that attempt.

The `--manual-browser` connection mode was launched in installed normal Chrome with its dedicated profile and no automation/debugging transport during sign-in. Its actual visible browser process was checked. The owner must finish login, return to AWS and close this dedicated window before the helper reopens that profile for account/control calibration. Successful session preservation and capture remain unverified until the owner completes those steps and runs the probe.

Live Supabase REST/RLS configuration, Vercel Linux browser execution, external webhook receipt, authenticated AWS writes, and actual AWS badge/streak outcomes remain untested. The local trace estimate is not a deployed Linux function-size or runtime guarantee. No successful AWS like/comment or earned reward is claimed by this validation record.
