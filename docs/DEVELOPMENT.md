# Development

syndicord uses TypeScript, npm, and the Cloudflare CLI (`cf`), with Wrangler as
its bundler. Node.js 26.13.0 is recorded in `.node-version`; the package
requires Node.js 26.12 or newer in the 26.x line and npm 11. The commands use a
POSIX shell, such as Bash or zsh.

## Check the project

```sh
bash scripts/setup.sh
bash scripts/check.sh
bash docket/scripts/ci.sh
```

`scripts/setup.sh` runs `npm ci`, which installs the pinned dependencies, builds
the CLI and Worker, and installs Git hooks for this checkout. Run it after
cloning and after pulling changes to `package.json` or `package-lock.json`.
Linked worktrees each need their own installation.

`scripts/check.sh` runs `npm run check` and `npm run test:package`. These cover
formatting, linting, generated Workers types, TypeScript, the Worker build,
tests, and npm installation. Tests use fixture feeds, fake Discord responses,
and temporary local D1 databases. A runtime test exercises scheduled events in
the built Worker. These checks need no Cloudflare account or Discord
credentials.

Miniflare and type generation start local runtime processes and bind loopback
ports. Restricted sandboxes must permit those operations. Local tests do not
measure hosted CPU usage or prove live Discord delivery.

`npm run types` refreshes editor types under `.cloudflare/types/`.
`npm run format` formats source, configuration, workflows, and Markdown.
`npm test` builds the Worker and runs the tests. `npm run build` writes the
deployment artifact to `.cloudflare/output/` without uploading it.

`package-lock.json` pins dependency versions. `package.json` records approvals
for the pinned native installers used by Cloudflare's tools; review these when
updating dependencies. Generated files, local databases, and secrets are ignored
by Git.

## Commit hooks and CI

### Format Markdown

```sh
npm run format:markdown
npm run format:markdown:check
```

Prettier formats Markdown structure and wraps prose to its default 80-column
target. The staged pre-commit hook formats changed Markdown files automatically,
and CI checks formatting through `npm run format:check`.

`AGENTS.md`, `TODO.md`, and `review/` keep their existing prose wrapping to
preserve installer-managed text, line-oriented queue metadata, and review
records. Vendored `docket/` and private `.docket/` files are excluded from
formatting.

### Staged checks

The pre-commit hook uses Husky and lint-staged to run Oxlint and Prettier on
staged files. Prettier's formatting changes are included in the commit; lint
errors block it. lint-staged backs up the original state and preserves unstaged
changes, including unstaged edits to a partially staged file.

Commits do not run type generation, builds, or tests. There is no pre-push hook.
Oxlint checks syntax and code correctness without starting the TypeScript
compiler.

| Command                | Scope                                      |
| ---------------------- | ------------------------------------------ |
| `npm run check:staged` | Run the commit checks on staged files      |
| `npm run lint`         | Check source and configuration with Oxlint |
| `npm run lint:fix`     | Apply Oxlint's automatic fixes             |
| `npm run format`       | Apply Prettier formatting                  |
| `npm run format:check` | Check formatting without editing files     |
| `npm run check`        | Run all checks, including builds and tests |

GitHub Actions runs `npm ci` and the full `npm run check` on pull requests and
pushes to `main`. Start it manually with `gh workflow run check.yml --ref main`
or from the Actions tab. CI also runs `npm run test:package` to verify npm
installation with production dependencies in a temporary directory and exercise
the installed CLI, local D1, and deployment dry-runs. This check needs npm
registry access but no Cloudflare credentials. It does not run in commit hooks.

The same complete gate is available as `bash scripts/check.sh`. A separate
**Queue and PR hygiene** job validates Docket queues, links, and PR
descriptions. See [quality and validation](QUALITY.md) for review inputs, test
policy, and hosting settings.

The workflow uses the Node version in `.node-version` and the npm version in
`package.json`, with cached npm downloads. Superseded PR runs are cancelled;
each push to `main` is checked. Hooks are disabled in CI, which runs the checks
directly.

If Git reports a missing hook command or package after an update, run `npm ci`
in that checkout and retry the commit. To inspect a lint-staged failure, use
`git status` and `git diff --cached` before retrying; an interrupted run may
retain a `lint-staged automatic backup` in `git stash list`.

## Run locally

```sh
cp .dev.vars.example .dev.vars
```

Set the Discord OAuth settings and a base64-encoded 32-byte
`CONFIG_ENCRYPTION_KEY` in `.dev.vars`;
[administration setup](WEB.md#enable-administration) explains application setup
and key generation. Register the local callback separately as described in
[local preview](WEB.md#local-preview). Keep that file private, then start with
an empty local database:

```sh
npm run db:migrate:local
npm run dev
```

The migration command always uses `--local`. It uses the same database ID as the
Worker configuration: the exported `SYNDICORD_DATABASE_ID`, or the built-in
local placeholder when that variable is absent. Export that variable in the
shell when changing it, rather than putting it in a dotenv file.

The local server normally listens on port 8787. Open
`http://localhost:8787/admin` and sign in with Discord, or use a second terminal
with `SYNDICORD_ADMIN_URL=http://localhost:8787` and run
`npm run syndicord -- login`. Follow
[the CLI configuration commands](OPERATIONS.md) to add webhooks and feeds. Both
clients update this local server's database.

Trigger a poll through the local runtime's scheduled-event route:

```sh
curl -fsS 'http://localhost:8787/cdn-cgi/local/scheduled'
```

This local poll uses the configured feeds and **real Discord webhooks**. The
first successful poll establishes a silent baseline. Later polls send new
entries. The scheduled-event route belongs to the local runtime; the deployed
Worker serves the Discord-authenticated editor at `/admin`.

Local D1 state is under `.cloudflare/state/` and is separate from hosted state.
The automated tests create their own databases and do not change this state.

## CLI development and installation checks

Run every operational command directly from the checkout:

```sh
npm run syndicord -- --help
npm run syndicord -- status
npm run deploy -- --dry-run
```

The repository's `.npmrc` sets `loglevel=silent` so npm script banners do not
pollute JSON output. Commands still write their own output and errors and retain
their exit status. To see npm's own diagnostics, override the setting for that
invocation, for example `npm --loglevel=notice ci`.

Deployment builds the current source before touching the hosted installation. It
does not depend on a previously generated package or a globally installed CLI.
`npm run status -- --remote` invokes the standalone status script; it requires
an explicit `--remote` or `--local` target.

`npm run package` builds the distributable CLI and Worker under ignored `dist/`.
The npm prepare lifecycle performs this build when installing from Git. It does
nothing in a built npm package, which contains no source or development tools.
The installed CLI uses its bundled Worker; source deployment always rebuilds.

`npm run test:package` checks the installed form in disposable directories and
cleans up its fixtures afterwards. No installation-specific identifiers, live
feeds, secrets, or local state are included in the npm package. Registry
publication is a separate release operation.

See [setup](SETUP.md#optional-npm-installation) for normal npm installation from
GitHub.

## Layout

| Path                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `src/config.ts`        | Feed and webhook validation                             |
| `src/feed.ts`          | RSS and Atom normalization                              |
| `src/discord.ts`       | Message formatting and confirmed webhook delivery       |
| `src/ledger.ts`        | D1 baselines, pending deliveries, leases, and cooldowns |
| `src/runner.ts`        | Bounded polling and delivery orchestration              |
| `src/config-store.ts`  | Installation configuration in D1                        |
| `src/admin.ts`         | Authorized configuration HTTP endpoints                 |
| `src/admin-auth.ts`    | Discord OAuth, role checks, and application sessions    |
| `src/admin-store.ts`   | Encrypted webhook configuration and atomic API saves    |
| `src/admin-page.ts`    | Feed, webhook, and routing web interface                |
| `cli/`                 | Installed command-line interface                        |
| `src/index.ts`         | Scheduled and HTTP Worker entrypoints                   |
| `test/`                | Unit, D1 integration, and built-Worker tests            |
| `migrations/`          | D1 schema migrations                                    |
| `cloudflare.config.ts` | Worker, bindings, schedule, and logging                 |

See [setup](SETUP.md) for the first hosted deployment,
[operations](OPERATIONS.md) for feeds and webhooks, and
[automatic deployment](DEPLOYMENT.md) for GitHub Actions.

## Tooling references

- [Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare CLI project commands](https://developers.cloudflare.com/cf/projects/)

For advanced provider operations, see the optional [API recipes](API.md).
