# Daily activity on this computer

The Windows task runs at **09:00 Singapore/Philippines time**, using the private AWS session created by `npm run aws:connect`. This local mode does not need Supabase or Vercel credentials. The computer must be on and logged into Windows; missed runs start when it becomes available. It cannot make up activity for previous days.

Each run opens Home, scrolls to the feed, and inspects up to 24 articles. It skips previously liked or commented articles and articles whose history cannot be verified. It prepares a comment based on the inspected title and topic, then submits one like and one comment. Both must persist after reload. It then opens **Manage profile → Activity → Badges**, loads additional cards, and reads the visit, like and comment badge progress, including the 90-day visit badge. Those observed counts are separate from the verified article actions; the app does not assume a badge advanced.

Local comments use topic-specific questions about the inspected article. Articles without enough relevant technical context are skipped. This mode does not use the dashboard's fixed `AWS_COMMENT_TEXT`.

Check the saved login and AWS badge counts without adding engagement:

```powershell
npm run aws:daily -- --check
```

Check today's record:

```powershell
npm run aws:daily -- --status
```

Install or update the Windows task:

```powershell
npm run aws:schedule
```

The task is named **AWS Builder Daily Activity**. Its private records and latest output are in `.local/aws-daily/`. The task and journal block repeat actions for the same day. Earlier claimed articles are also excluded. An interrupted or uncertain action is never repeated automatically. An already completed live test can be recorded without submitting its actions again.

If sign-in expires, a scheduled failure displays a local notice. Run `npm run aws:connect -- --manual-browser`, complete Google/GitHub/passkey prompts yourself, and capture the renewed AWS session. The scheduled worker cannot approve your passkey. Check and finish that day's activity manually; the next day's run uses the renewed session.

Use one active daily runner. If you use this Windows task, keep the deployed dashboard's automatic mode disabled. A server deployment can use the existing Vercel cron instead once its Supabase and AWS credentials are configured.

To stop this computer's schedule:

```powershell
Disable-ScheduledTask -TaskName 'AWS Builder Daily Activity'
```
