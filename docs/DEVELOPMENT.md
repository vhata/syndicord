# Develop and contribute

Use Node.js 26.13.0 (`.node-version`) and npm 11.20.0 (`package.json`). The
project uses TypeScript and the Cloudflare CLI (`cf`), with Wrangler as its
bundler. Commands below use Bash or another POSIX shell.

## Check the project

```sh
git clone https://github.com/vhata/syndicord.git
cd syndicord
bash scripts/setup.sh
bash scripts/check.sh
bash docket/scripts/ci.sh
```

Setup installs pinned dependencies, builds the CLI and Worker, and installs
commit hooks. The checks cover formatting, lint, types, tests, npm installation,
and documentation links. They use fixture feeds, fake Discord responses, and
local databases: **no Cloudflare account or Discord credentials are needed**.
They require npm registry access and permission to bind local loopback ports.

Run setup again when dependencies change, and in each new worktree. Use
`npm test` for the source/runtime tests while working; run both check scripts
before review. See [the complete command reference](QUALITY.md#gates) for
individual checks and their scope.

## Make a change

Read [AGENTS.md](../AGENTS.md) and the [Docket contract](../docket/CONTRACT.md).
Choose a focused change; [TODO.md](../TODO.md) lists work to pick up. For a
directly requested change, replace `my-change` with a descriptive name:

```sh
bash docket/scripts/claim-check.sh my-change
bash docket/scripts/start-work.sh task my-change
cd .worktrees/task-my-change
bash scripts/setup.sh
```

For a queued task, use its existing slug and `todo` or `review` instead of
`task`. Work in that worktree, update the relevant docs, and commit coherent
changes. Publish the branch before opening a PR:

- **With repository write access:** run `git push -u origin HEAD`.
- **Without write access:** choose **Fork** on GitHub, then run
  `git remote add fork https://github.com/YOUR_USERNAME/syndicord.git`.
  Alternatively, `gh repo fork --remote --remote-name fork` creates the fork and
  adds that remote. Then publish with `git push -u fork HEAD`.

On the upstream repository, choose **Pull requests → New pull request**, select
`main` as the base and your published branch as the compare branch, then
**Create draft pull request**. For a fork, use **compare across forks** to
select it; see
[GitHub's fork PR guide](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request-from-a-fork).
Or run `gh pr create --draft --repo vhata/syndicord --base main` from the
worktree. Follow the PR template; its title and description become the squash
commit message.

Run the checks and obtain an independent review. Resolve findings, then mark the
PR ready for review. The repository owner handles final review, merging,
releases, and deployment. [Quality and review](QUALITY.md) explains test policy
and review evidence; the contract covers the full workflow.

## Run locally

Tests above are the quickest way to exercise the project. For an interactive
editor, you also need a development Discord application and role:

```sh
cp .dev.vars.example .dev.vars
```

Fill in the OAuth settings and a base64-encoded 32-byte `CONFIG_ENCRYPTION_KEY`
in that private file. Follow
[administration setup](WEB.md#enable-administration) and register
`http://localhost:8787/admin/auth/callback` as described in
[local preview](WEB.md#local-preview). Then start the local database and server:

```sh
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787/admin` and sign in. For the CLI, use a second
terminal in the same checkout:

```sh
export SYNDICORD_ADMIN_URL='http://localhost:8787'
npm run syndicord -- login
```

Both clients edit this local database; use
[the feed-management guide](OPERATIONS.md) to configure it. Local state lives in
`.cloudflare/state/`, separately from hosted state and the automated tests'
temporary databases.

The migration command always uses `--local`. It uses the exported
`SYNDICORD_DATABASE_ID`, or the built-in local placeholder when absent. Set a
custom database ID in the shell, not a dotenv file, so migrations and the Worker
select the same database.

To trigger a local poll, open `http://localhost:8787/cdn-cgi/local/scheduled` in
a browser, or run:

```sh
curl -fsS 'http://localhost:8787/cdn-cgi/local/scheduled'
```

**This uses real feeds and Discord webhooks.** The first successful poll records
a silent baseline; later polls can send messages. The scheduled-event route is
provided by the local runtime. Hosted delivery is driven by cron.

## Layout

| Path                          | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `src/config.ts`               | Feed and webhook validation                             |
| `src/feed.ts`                 | RSS and Atom normalization                              |
| `src/discord.ts`              | Message formatting and confirmed webhook delivery       |
| `src/ledger.ts`               | D1 baselines, pending deliveries, leases, and cooldowns |
| `src/runner.ts`               | Bounded polling and delivery orchestration              |
| `src/config-store.ts`         | Installation configuration in D1                        |
| `src/admin.ts`                | Authorized configuration HTTP endpoints                 |
| `src/admin-auth.ts`           | Discord OAuth, role checks, and application sessions    |
| `src/admin-policy.ts`         | Operator-owned grants and exact channel scopes          |
| `src/catalog-store.ts`        | Scoped catalog operations and atomic relay projection   |
| `src/webhook-verification.ts` | Bounded Discord destination verification                |
| `src/admin-store.ts`          | Encrypted webhook configuration and atomic API saves    |
| `src/admin-page.ts`           | Feed, webhook, and routing web interface                |
| `cli/`                        | Installed command-line interface                        |
| `src/index.ts`                | Scheduled and HTTP Worker entrypoints                   |
| `test/`                       | Unit, D1 integration, and built-Worker tests            |
| `migrations/`                 | D1 schema migrations                                    |
| `cloudflare.config.ts`        | Worker, bindings, schedule, and logging                 |

Read [relay behavior](BEHAVIOR.md) for the polling and delivery model,
[authentication design](WEB.md#authentication-design) for sign-in, and
[permissions](PERMISSIONS.md) for the shared catalog and channel grants.

<a id="format-markdown"></a> <a id="staged-checks"></a>

## Commit hooks and CI

Commits run staged formatting and lint only. Builds and tests belong in the
check scripts and CI. See
[hooks and formatting](QUALITY.md#hooks-and-formatting) for commands and
recovery, and [CI and hosting](QUALITY.md#ci-and-hosting) for workflow details.

## CLI development and installation checks

Use `npm run syndicord -- --help` to explore the source CLI. See
[CLI and package development](QUALITY.md#cli-and-package-development) for
package builds, installation checks, local status, and deployment dry-runs.
Normal [CLI installation](SETUP.md#optional-npm-installation) and
[hosted deployment](SETUP.md) have separate guides.

## Tooling references

- [Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare CLI project commands](https://developers.cloudflare.com/cf/projects/)
- [Advanced provider API recipes](API.md)
