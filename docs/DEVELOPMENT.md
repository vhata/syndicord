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

- `scripts/setup.sh` installs pinned dependencies, builds the CLI and Worker,
  and installs commit hooks.
- `scripts/check.sh` checks formatting, lint, types, source/runtime tests, and
  npm installation.
- `docket/scripts/ci.sh` checks the TODO and review queues for valid entries and
  checks relative documentation links and anchors. On GitHub pull requests, it
  also checks the PR description's queue markers. When run locally as above,
  `no PR set, markers skipped` is expected; it runs the local checks without
  starting a GitHub Actions run or deploying.

The tests use fixture feeds, fake Discord responses, and local databases: **no
Cloudflare account or Discord credentials are needed**. They require npm
registry access and permission to bind local loopback ports.

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
```

`claim-check.sh` looks for work already using that name in branches, worktrees,
and open or merged PRs, so contributors do not duplicate or conflict with work
already underway or completed. Continue when it reports **no existing claims
found**. If it finds a claim, coordinate with its owner first; a merged PR may
mean the work is already done. If it reports **PRs NOT checked**,
[install GitHub CLI](https://github.com/cli/cli#installation) if needed, sign in
with `gh auth login`, and rerun it. Resolve any reported errors before
continuing.

Once the name is free, `start-work.sh` repeats the claim check and creates the
branch `task/my-change` and its separate working directory (a Git worktree) at
`.worktrees/task-my-change`. It starts from `origin/main` when available,
otherwise local `main`, and prints the base and path it used. Enter that
directory, recheck for competing claims with `--self` (which ignores your own
branch and worktree), then install its dependencies:

```sh
bash docket/scripts/start-work.sh task my-change
cd .worktrees/task-my-change
bash docket/scripts/claim-check.sh --self my-change
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
editor with Discord sign-in, first follow
[Register a Discord application](WEB.md#register-a-discord-application) using a
development application and role. Those steps show where to get the client ID,
client secret, server ID, and role ID. At the redirect step, register
`http://localhost:8787/admin/auth/callback` for this local preview.

Then create the private settings file:

```sh
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and paste the Discord values you just collected into the
matching settings. Keep the local callback URL already shown there. Run the
key-generation command in the file's comments and paste its output into
`CONFIG_ENCRYPTION_KEY`. Keep that key when reusing the same local database so
its saved webhooks remain readable. These local settings stay in `.dev.vars`;
the hosted Worker secret commands in the sign-in guide are for deployments.

The Cloudflare CLI runs a local D1 database on your machine and saves its data
under `.cloudflare/state/` in this checkout. The migration command below creates
its tables; the development Worker uses that database for feeds, webhooks,
sessions, and delivery history. Start with the default local database:

```sh
unset SYNDICORD_DATABASE_ID
npm run db:migrate:local
npm run dev
```

The unset variable selects the built-in ID
`00000000-0000-4000-8000-000000000001`. This is a fixed identifier for the local
database; you do not need to create a Cloudflare database or obtain an ID from
the dashboard. Its data persists between development runs and is separate from
hosted data and the automated tests' temporary databases.

Open `http://localhost:8787/admin` and sign in. For the CLI, use a second
terminal in the same checkout:

```sh
export SYNDICORD_ADMIN_URL='http://localhost:8787'
npm run syndicord -- login
```

The browser editor and CLI both connect to the development Worker and edit the
same local D1 database. Use [the feed-management guide](OPERATIONS.md) to add
feeds and destinations.

`npm run db:migrate:local` always passes `--local`, even if invoked in CI. The
CI test job also uses local fixtures. Production deployment uses a separate
command to migrate the configured hosted D1 database; see
[deployment and migration behavior](DEPLOYMENT.md#deployment-and-migration-behavior).

To trigger a local poll, open `http://localhost:8787/cdn-cgi/local/scheduled` in
a browser, or run:

```sh
curl -fsS 'http://localhost:8787/cdn-cgi/local/scheduled'
```

**This uses real feeds and Discord webhooks.** The first successful poll records
a silent baseline; later polls can send messages. The scheduled-event route is
provided by the local runtime. Hosted delivery is driven by cron.

### Optional: use a different local database

The default is enough for normal development. To keep a separate local dataset
in this checkout, stop the development server and choose another UUID, for
example the one below. Export it in the same terminal before running both
commands:

```sh
export SYNDICORD_DATABASE_ID='00000000-0000-4000-8000-000000000002'
npm run db:migrate:local
npm run dev
```

Keep the chosen ID to reopen that dataset later. It identifies another database
in the local emulator and does not need to match a hosted D1 ID. Set it in the
shell rather than `.dev.vars` or `.env`: the migration script reads the shell
variable, and the Worker configuration must receive the same value. Use that
same export for `npm run syndicord -- status --local` in another terminal. To
return to the default dataset, stop the server, unset the variable, and restart
with the earlier commands. Keep the encryption key that belongs to each dataset.

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
