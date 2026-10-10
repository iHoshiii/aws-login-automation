<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git workflow

- Use `main` as the base branch and create a feature, fix, or maintenance branch for implementation changes.
- Commit all completed task changes in focused commits; do not put all development commits directly on `main`.
- Use commit messages in the form `type(scope): description`, such as `feat(aws): support Builder ID sign-in` or `chore(repo): update project tooling`.
- Keep credentials, `.env.local`, `.local/` browser profiles and sessions, generated builds, and test artifacts out of Git. Only the placeholder `.env.example` may be committed.
