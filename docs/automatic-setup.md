# Connect AWS and start automatic activity

The worker needs your AWS Builder Center browser session and a profile of the account and comment controls observed on the real page. You perform login and initial calibration locally. The server restores the encrypted session for later daily runs; the dashboard never requests your AWS password.

## 1. Install and configure the app

```powershell
npm ci
npx playwright install chromium
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

If `.env.local` already exists, keep it instead of copying over your configured values. Fill in the app and Supabase values listed in the [README](../README.md). Apply [001_initial.sql](../supabase/migrations/001_initial.sql), then [002_automation.sql](../supabase/migrations/002_automation.sql) in the intended Supabase project's SQL editor.

## 2. Capture and calibrate your AWS session

In a local interactive terminal, run:

```powershell
npm run aws:connect
```

Set `AWS_BUILDER_ID_EMAIL` in `.env.local` to your Builder ID email. If absent, the helper uses the private `.local/aws-account.env` setting when present or asks you for an email. It fills the observed AWS email dialog and selects **Continue with Builder ID**. It never enters or stores your password. If that interface changes, it leaves sign-in to you instead of guessing controls.

If the active sign-in flow goes through GitHub and Google, keep using that browser. The helper follows the existing OAuth flow and related popups, can select GitHub's **Continue with Google** and the available Google account/identifier controls, and waits for a verified return to AWS. Complete passwords, passkeys, device verification, and MFA yourself. A provider page or a URL returning to AWS alone does not establish a connected account. Open the account menu after returning to AWS so your own profile or **Manage profile** link is visible; calibration starts only after the helper verifies the account.

### If Google rejects the test browser

In one live connection attempt, Google displayed “Couldn't sign you in” in Chrome for Testing. The specific cause was not established. Google says it may block sign-ins from browsers controlled through automation and recommends supported browsers. [Google Account Help: supported browsers](https://support.google.com/accounts/answer/7675428?co=GENIE.Platform%3DDesktop&hl=en)

Use the manual login branch with installed Google Chrome:

```powershell
npm run aws:connect -- --manual-browser
```

1. The helper opens installed Chrome with a dedicated `.local/aws-manual-profile`. During this login phase it has no automation or debugging connection to Chrome.
2. Sign in to AWS yourself, following GitHub/Google and passkey/device prompts if present. Wait until you are back at AWS Builder Center.
3. Close this dedicated Chrome window and any popups it opened. Then press Enter in the helper's terminal. Enter acknowledges the window close; it does not prove authentication succeeded.
4. The helper waits for its Chrome process to exit and reopens the same isolated profile with a loopback connection for calibration and session capture.
5. In the reopened AWS page, open your account menu so your own profile or **Manage profile** link is visible. The helper verifies the account, then asks for the article and controls described below.

Finish every Google/GitHub and passkey prompt in the first Chrome window. Close it only after you are back on AWS with a signed-in account; then press Enter in the terminal. The reopened window is for checking the existing AWS session and selecting controls. If it returns to Google sign-in, close it and restart `npm run aws:connect -- --manual-browser` to finish login in the first window.

If installed Chrome is not detected, set `AWS_MANUAL_CHROME_PATH` in `.env.local` to its executable path. Keep `.local/aws-manual-profile` private: it is ignored by Git but contains local browser credentials. Use the helper's isolated profile rather than copying your everyday Chrome data. This branch still requires successful account verification and a later live probe; it does not guarantee Google or AWS will accept the session.

### Calibrate after verified sign-in

With either connection mode, follow these steps in the browser and terminal:

The helper uses the worker's browser dimensions during calibration so responsive account controls match when the saved session is restored.

1. Complete sign-in and open the account menu on AWS for verification. In the default mode, keep the active OAuth browser open; in manual-browser mode, finish the close/reopen sequence above first. For a passkey prompt, use your phone, security key, or device authenticator as requested.
2. Paste a real `https://builder.aws.com/content/...` article URL with an empty top-level comment editor. Wait for it to load and press Enter.
3. Select your account menu button in the page header when the helper prompts. The helper opens this menu and asks you to select your own profile link or **Manage profile**. For **Manage profile**, it reads your public account alias from the authenticated profile page's QR dialog in a temporary tab, then returns to the article. You do not need to enter or guess your profile URL.
4. Close the menu and scroll to the empty top-level comment editor. Select the editor and then the comment submit button when prompted.
5. The helper validates the observed account, article like controls, and comment composer and writes the encrypted connection values.

Control-selection clicks are intercepted before they activate the selected control. Selecting the submit button during calibration does not publish a comment. The helper performs no likes or comments. If it cannot validate the actual page structure, it exits and asks you to reconnect; it does not invent selectors or bypass a challenge.

The output file is:

```text
.local/aws-session.env
```

It contains `AWS_SESSION_KEY` and `AWS_SESSION_ENCRYPTED`. Copy both values privately into `.env.local` for local operation and into Vercel Production environment settings for deployed operation. Keep this file and both values out of Git, messages, and screenshots. The repository ignores `.local/` and `.env.local`.

The key has 64 hexadecimal characters. The encrypted bundle includes AWS cookies/storage, the connection's requested Builder ID email, the observed account profile identity, and the calibrated control profile. Google/GitHub cookies and storage are excluded from the export; they can still remain in the private local Chrome profile used for manual login. When `AWS_BUILDER_ID_EMAIL` is configured on the worker, it rejects a bundle recorded for another email. The actual runtime identity is checked using the recorded account profile. Having both session values grants access to the stored AWS session, so protect them like an account credential. The helper does not export a raw storage-state file or print these secrets.

## 3. Inspect the connection without publishing engagement

```powershell
npm run aws:probe
```

The probe loads the configured session, checks that the recorded account is visible, discovers a limited number of candidates, and prints whether each candidate can be inspected and appears eligible. It visits AWS pages but does not submit a like or comment or write a daily database run.

An eligible candidate has neither a prior like nor a prior comment by the connected account, with sufficient visible comment history to establish that result. Large, ambiguous, nested, or changed comment structures may be rejected. Seeing `state_unknown` means the worker cannot establish eligibility; it does not mean that the post has no existing activity.

The driver reads the current account and article directly from AWS before interpreting the toolbar. An existing server-side like skips the article even if AWS's cached page still shows an unpressed button. The server's comment count must agree with the fully inspected comment list. Actual loading indicators remain guarded; completed feeds and unrelated notification or Space polling do not prevent inspection.

If authentication or controls fail, rerun `aws:connect` and check the account and selections. The probe is necessary to establish live account/layout compatibility; the project's local fixture tests cannot do this for your account.

## 4. Choose the comment and run

Set `AWS_COMMENT_TEXT` to 1–500 characters you intend to publish. The default is `nice`; the worker uses the configured text rather than composing a new response from each post. It compares the persisted comment with that text during verification.

```powershell
npm run dev
```

Open `http://localhost:3000`, sign in with `ADMIN_PASSWORD`, and verify that automatic mode and the daily schedule are enabled. After 09:00 Philippine time, **Run now** executes the full workflow and can publish real AWS engagement. A candidate queue is optional: the worker can discover posts from AWS.

The dashboard's **Configured** connection label confirms that the two environment variables exist. The probe and worker check actual AWS authentication. Review the selected post, verified actions, and logs after execution. A run can take a few minutes. If a response is interrupted, refresh and inspect the committed record before another request.

## 5. Deploy the daily schedule

Apply both migrations in the production database, configure the server-only environment variables in Vercel, and deploy production. Set `APP_URL` to that deployment's exact origin. Redeploy whenever the stored AWS session or other environment values change.

The cron path is `/api/cron` with `0 1 * * *`, corresponding to 09:00 Asia/Manila. Vercel Hobby invokes it within the following hour. Local `npm run dev` does not schedule cron. The packaged serverless Chromium runtime targets Linux x64, and AWS access from Vercel must be verified with your connected account.

Use `/api/cron?dryRun=1` with the required cron authorization header to check authentication and schedule metadata. That endpoint does not launch the AWS browser or write a run. See the PowerShell example in the [README](../README.md).

## Reconnect and recover

AWS can expire or revoke the saved session. On `auth_required`, rerun `aws:connect`, replace **both** values, restart/redeploy, and probe again. Interactive provider/passkey handling belongs to the local connection helper. The production worker uses the captured AWS session and stops on an unverifiable account, MFA, CAPTCHA, or login challenge; it does not complete or bypass those challenges. Changed page layout may require the same recalibration.

The default daily budget is two attempts, adjustable from one to three. Repeated cron delivery keeps the same run. Only an explicit permitted retry consumes another attempt. A retry is allowed for failed preparation, authentication, no eligible post, or a safely expired worker when no engagement was claimed and no action remains ambiguous. Once any like or comment attempt is recorded, it cannot be repeated automatically, even if its later verification fails.

For a partially completed or uncertain run, inspect the post and AWS account yourself. Verified actions remain recorded; uncertain activity stays frozen. Do not delete records or reset action phases to force replay. A missed prior day remains missed, and this application does not certify streaks or badges.
