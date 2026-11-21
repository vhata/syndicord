## Documentation

For user-facing setup and operations, show clear dashboard steps alongside
simple CLI commands where both are available. Prefer the CLI's own prompts
over shell loops, input-handling scripts, or API helpers. Keep advanced
automation in a separate optional reference, not the main setup flow.
Verify commands against the project's pinned tools; when no simple CLI
option exists, do not obscure the task with a script to force one.

<!-- docket:begin -->

## Docket

This project is run with docket. Read [docket/CONTRACT.md](docket/CONTRACT.md) before any work; it is the authoritative workflow, and this section records only this project's settings. The installer keeps this section current: the text above the list is rewritten on every run, the list keeps the values this project has set, and the section may sit anywhere in this file.

- Queue areas: `[RELAY]`, `[CLI]`, `[TOOLING]`, `[DOCS]`.
- Concurrency cap: at most two heavy builds or test runs across agents; each worktree owns its dependencies, generated files, and local databases.
- Merging and releases: the user merges, releases, publishes packages, and deploys unless explicitly delegated; never change hosted branch protection without approval.
- Optional pieces in force: review ledger and stacked PRs; roadmap queue and scheduled extended validation are deferred. Every push to main runs CI.
- Environment: Node and npm versions come from `.node-version` and `package.json`. Automated checks use local fixtures without Cloudflare or Discord credentials; local runtime checks need loopback access. Real webhook sends and hosted mutations require explicit authorization.
- Commit hooks: preserve staged formatting and linting only, with no build, typecheck, test, or pre-push hook. Full validation belongs in `scripts/check.sh` and CI.
- Billable resources: before provisioning or changing billable third-party resources, explain the resource and billing implications and get user confirmation.

<!-- docket:end -->
