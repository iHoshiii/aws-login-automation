# AWS Builder Center research

Policy research reviewed on **2026-10-09**. These findings cover public official pages. Later public browser observations are recorded in [site inspection](aws-site-inspection.md); no authenticated AWS account or engagement action has been tested.

## Decision

The original brief selected manual review when permission was unclear, and the initial implementation followed that fallback. The owner's later instruction to proceed changed the implementation scope: an automatic worker now discovers candidates and submits configured engagement after account and state checks. The [README](../README.md) describes current behavior. This implementation change does not establish AWS approval or reward eligibility.

This is an implementation decision based on uncertainty and the quality rules below, not a claim that AWS explicitly bans every possible use of browser automation.

## Verified official facts

The [AWS Student Rewards launch announcement](https://builder.aws.com/content/3I1qkUtKhwU6K1VaGkfYRwtbz3o/introducing-student-rewards-on-aws-builder-center), published by Rick Suttles, AWS Builder Center Director, on August 20, 2026, describes verified higher-education students receiving 12 months of premium Skill Builder access after completing their profile. Badge milestones unlock $10 AWS Credits at 7 badges, another $20 at 14, and a $100 AWS Foundational Certification exam voucher at 21. Eligibility includes age 18 or older, enrollment at an accredited higher-education institution, and successful verification through SheerID. Reward redemption remains subject to current terms.

The current [Builder Center FAQ](https://builder.aws.com/faq) verifies these points:

- Builder ID is separate from AWS account credentials; engagement requires sign-in.
- Badges recognize community participation, not certification or skill validation. The complete badge/action list appears in the user's own profile.
- Streaks use UTC calendar days and weeks. Daily qualifying activity must occur before 23:59:59 UTC. Weekly activity uses consecutive Monday–Sunday UTC weeks; an empty week resets a weekly streak.
- Content must be thoughtful and accurate; attempts to manipulate features or content are prohibited.
- Repetitive, irrelevant, or valueless content is low quality and may be removed regardless of reward intent. Repeated low-quality content can cause profile suspension and restrict accrued rewards.

The latest FAQ sections about timing and low-quality content were read directly from publicly served HTML using an ordinary unauthenticated HTTP GET because the search service intermittently returned older extracts or timed out. Section titles: **What timezone are streaks based on?** and **What counts as low-quality content, and what happens if I post it?**

The [AWS Builder Terms](https://builder.aws.com/terms), particularly sections 1, 3, 4, and 6, require personal Builder ID use, incorporate AWS conduct and acceptable-use rules, permit removal of poor-quality content, and reserve suspension rights. No reviewed section expressly authorizes automated engagement.

The [AWS Site Terms](https://aws.amazon.com/terms/), under **License and Site Access**, exclude data mining, robots, and similar data gathering/extraction from the ordinary personal-use license. The **Reviews, Comments, Communications, and Other Content** section prohibits spam. This does not establish whether a specific browser interaction is categorically prohibited; it reinforces that scraping/automated discovery should not be assumed permitted.

## Timing implications

09:00 Asia/Manila equals 01:00 UTC, so `0 1 * * *` is the intended scheduler expression. This occurs one hour after the start of the UTC activity day. Store the Philippine date for operational runs as requested; do not equate that field with an AWS streak date. A user who completes a task much later can cross the UTC boundary even if the Philippine local date has not changed.

The app records its own scheduling, browser observations, and separate manual reports. A verified browser operation does not certify an earned badge, reward eligibility, or maintained streak.

## Unknown or unverified facts

- The exact visit/like/comment qualifying-action thresholds, 7/30/90-day requirements, moderation exclusions, and applicable content types were not verified from an authenticated badge profile. Community articles discuss these, but publication on builder.aws.com alone does not make an article official policy.
- No public permission for automatic likes or automatic repetitive `nice` comments was established. No claim is made that a one-word comment always fails an undocumented moderation filter.
- No documented public API for this engagement workflow was found. No internal endpoint should be invented or reused.
- Public selectors and fixture behavior have since been inspected/tested, but authenticated Builder Center compatibility, session lifetime, real account engagement and Vercel execution remain unverified.
- MFA, CAPTCHA, identity-provider challenges, or bot protections can require human interaction. They must not be bypassed.

## Current authentication and execution

The local connection helper uses interactive Builder ID sign-in. Passwords and MFA codes stay in the AWS browser. It captures encrypted browser storage and observed account/comment controls; the worker restores that session and checks the account profile before processing a candidate. No raw AWS password or session is stored in the database. Browser session values and their encryption key remain server-only secrets.

Automatic actions are claimed durably before submission, rechecked immediately before submission, and verified after reload. Posts already liked or commented by the connected account are skipped; incomplete history is rejected. An ambiguous action remains **Uncertain** and cannot be replayed automatically. Manual mode retains **User reported** records separately.

The absence of documented permission remains an external uncertainty. A dashboard setting does not establish AWS approval, and successful interaction does not establish reward eligibility.
