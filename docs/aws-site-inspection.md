# Builder Center browser inspection

Inspected on October 9, 2026 using the installed Playwright Chromium browser, without signing in. This inspection performed ordinary public navigation and read-only comment pagination. It performed no likes, comments, login attempts, challenge bypass, or private API requests.

## Observed on the real public website

- The home page at <https://builder.aws.com/> loads article links in its Explore area. Article links have `/content/<id>/<slug>` paths. Polls use a different `/poll/` path and are excluded by this adapter. Article feed pagination uses a visible `Load more` button.
- The home Explore `Latest` control was an actual native button with `data-testid="latest"` and `aria-pressed`. Clicking it after the page loaded changed its pressed state to true and loaded recent posts in a `role="feed"` container. The feed appeared after a short transition, so the adapter waits for its actual article links and prioritizes that feed ahead of Spotlight cards.
- <https://builder.aws.com/content/3KQYoLu7XiQSn6r13bPEE8jeKTj/aws-lambda-response-streaming-for-kotlin-and-java> has a `main` element, an `h1` title, and a `#comments` section. Opening the shorter <https://builder.aws.com/content/3KQYoLu7XiQSn6r13bPEE8jeKTj> also returned HTTP 200 and the same article title. The application stores that stable ID URL.
- Profile links use `/community/@alias`, for example the article author's `/community/@elenavanengelen` link. An author link is not evidence of the current signed-in account.
- Two article toolbar buttons had `aria-label="Like this article 72"` and `aria-pressed="false"`. Comment like buttons used distinct `Like comment <count>` labels inside `#comments`. The adapter scopes article toggle buttons outside `#comments`, checks native button elements and consistent pressed states, and refuses ambiguous controls.
- The comments heading was `Comments (51)`. A comment feed had `role="feed"`, `aria-busy`, and a `Load more` button. One pagination click increased rendered top-level comments from 10 to 20.
- Each inspected comment used a class containing `_comment-main_`. Its author links were inside `[data-module-id="profile"]`; the body was in an `_editor-container_` below `_comment-content_`. The driver compares the author's canonical profile URL, rather than a display name or arbitrary links in the article body.
- Reply counters were buttons with labels such as `Reply 0` and `Reply 1`. Nested replies used `_comment-nested_` containers and additional feeds; `Hide replies` appeared for expanded threads. Their complete pagination/count semantics were not established.
- The logged-out header had a `Sign in` button. The comments section said `Sign in to comment` and exposed no comment editor or comment submit button.

## Signed-in controls require an actual recorded sample

A follow-up public sign-in inspection on October 10, 2026 observed that **Sign in** opens a dialog on `https://builder.aws.com/`, headed **Sign in to join the community**. Its associated-label textbox is **Email**, with `type="email"` and `autocomplete="email"`; the native submit button is **Continue with Builder ID**. The helper uses these observed accessible controls to start the requested email's login flow. No email/password/MFA was submitted during that inspection, so later authentication screens were not inspected.

No authenticated AWS session was available for this implementation session. The account menu, current account profile link, comment editor, submit button, successful AWS writes, and persisted authenticated state were not tested against AWS.

`npm run aws:connect` opens a normal browser for the owner to sign in and finish MFA. The owner selects the actual account menu, their own profile link, the empty top-level comment editor, and its submit button. Selection clicks are intercepted by the recorder. `captureSiteProfile` validates the controls actually present on that article and records their selectors and fingerprints. It requires the account link to identify the expected `/community/@alias` inside the header or an account menu; a link in an article or comment cannot authenticate the session.

Before a later write, the driver checks the account again, checks the captured editor/submit fingerprints and their shared comment composer, and rejects changed controls. A menu opener must remain a native button inside the header. A like must change the observed `aria-pressed` state, and both likes and comments must remain confirmed after a fresh navigation. A possibly submitted write with no confirmed persisted result produces `action_uncertain`; the worker must retain that activity's lock and never automatically repeat the write.

## Comment coverage and exclusions

The current adapter proves absence of a previous comment only after every inspected top-level page has loaded, each comment has an identifiable author/body, the rendered comment count matches `Comments (N)`, no feed is busy, and every reply counter is `Reply 0`. A post with replies, a missing author/body, a count mismatch, unexpected pagination, or too much history is skipped with `state_unknown`. Finding the owner's comment immediately makes a post ineligible; exhaustive scanning is then unnecessary.

This intentionally limits candidate selection to histories the observed interface can prove complete. The inspection does not claim that an expanded thread contains every reply. Reply coverage can be extended after a real inspection establishes its counts and pagination.

## Validation boundary

`tests/aws-site.test.ts` uses an isolated browser fixture modeled on the public article markup, with synthetic account/composer controls. It covers discovery, later-page existing comments, uncertain persistence, account mismatch, changed submit controls, and repeated operations. All fixture requests are intercepted locally. Passing those tests does not establish that the owner's authenticated AWS account can publish successfully; run `aws:probe` after connecting, then test one authorized daily run in the configured deployment.
