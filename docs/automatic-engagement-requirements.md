# Automatic engagement: implementation and remaining validation

The owner requested automatic discovery of a Builder Center post their account has neither liked nor commented on, followed by a like, configured comment, verification, and a daily record. The later instruction to proceed superseded the initial manual-only implementation choice. This workflow is now implemented; it still needs the owner's connected AWS session and live account/deployment validation.

## Implemented safeguards

- Local interactive login and calibration capture the account and actual comment controls. The encrypted session/key are server-only secrets, outside source control and database records.
- The worker checks the account, like state, and account-authored comment history. Incomplete or ambiguous history is rejected rather than treated as an untouched post.
- Each action is durably claimed before external submission. AWS state and database lease/configuration are rechecked immediately before acting, and persisted results are inspected after reload.
- Completed or uncertain engagement cannot be repeated automatically. Explicit bounded retries apply only before engagement; expiry, pauses, and mode changes reject stale workers.
- MFA, CAPTCHA, and access challenges require reconnecting interactively. The worker does not bypass them.
- Manual records remain separate from worker observations. Neither certifies an AWS badge, streak, or reward.

See [automatic setup](automatic-setup.md), [database behavior](database.md), and the [README](../README.md) for current operation.

## Research caveats

The original brief required manual fallback when automation permission was unclear. Official sources reviewed did not establish permission for this unattended engagement workflow:

- The [AWS Builder Center FAQ](https://builder.aws.com/faq) prohibits manipulation and identifies repetitive, irrelevant, or valueless content as low quality.
- [AWS Builder Terms](https://builder.aws.com/terms) incorporate conduct requirements and permit removal of poor-quality content.
- [AWS Site Terms](https://aws.amazon.com/terms/) exclude robots/data extraction from the ordinary site license and prohibit spam. These provisions do not resolve every possible browser interaction.

No documented engagement API was found in the reviewed sources; this is not proof that none exists. The user's instruction authorized this project's implementation but does not establish AWS approval. `AWS_COMMENT_TEXT` defaults to `nice` as requested and is configurable; its default does not establish content-quality compliance or reward eligibility.

## Account-specific checks still required

1. Run `aws:connect` locally and calibrate the signed-in page; do not send passwords, MFA codes, or session values through chat.
2. Use `aws:probe` to verify the connected identity and candidate-state observations without publishing a like or comment.
3. Verify a real eligible execution and compare the saved observations with the selected AWS post. Fixture tests cannot establish the account's complete history or live control compatibility.
4. Verify Vercel Chromium launch, AWS session acceptance, cron invocation, storage, and optional webhook delivery in the deployed environment.
5. Check AWS's current policy and profile/reward rules for the intended use. Implementation and successful submission do not establish permission or reward credit.

## Optional question for AWS Support

This draft has not been sent. An AWS response can clarify remaining policy and reward questions; sending it is not an implementation prerequisite in the current scope.

> I want to use my own AWS Builder ID for a personal daily workflow: find an article I have neither liked nor commented on, like it, and submit a relevant comment. Is unattended browser automation or a supported API permitted, and can this activity qualify for Student Rewards streaks? Please identify supported access methods, automation restrictions, rate limits, and content-quality requirements.

Contact [AWS Builder Support](https://builder.aws.com/support) for an authoritative response.
