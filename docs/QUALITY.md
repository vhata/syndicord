# Quality and tooling reference

For the first clone and a contribution walkthrough, start with
[development](DEVELOPMENT.md). Use this reference when you need the exact
checks, tooling behavior, or review requirements.

Changes use GitHub pull requests and independent review under
[Docket's contract](../docket/CONTRACT.md). The user controls merging and hosted
operations. The commands below are local checks; they neither deploy a Worker
nor send Discord messages.

## Gates

Install dependencies in each checkout, then run the full gate:

```sh
bash scripts/setup.sh
bash scripts/check.sh
bash docket/scripts/ci.sh
```

The setup and check scripts resolve their own checkout, so they also work when
invoked by absolute path from another directory. Setup delegates to `npm ci`,
including package preparation and Husky installation. Run it after cloning and
when the dependency manifest or lockfile changes.

| Entry point                 | Checks                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run check:staged`      | Prettier and Oxlint on staged files only                                                   |
| `npm run check`             | Formatting, lint, generated Worker types, TypeScript, Worker build, and runtime/unit tests |
| `npm run test:package`      | Build, normal npm installation, installed CLI, local D1, and deployment dry-runs           |
| `bash scripts/check.sh`     | Both complete npm check commands, stopping on the first failure                            |
| `bash docket/scripts/ci.sh` | Queue structure, Markdown links, and PR markers when PR metadata is supplied               |

Toolchain versions are pinned in `.node-version`, `package.json`, and
`package-lock.json`. The package supports Node.js 26.12 or newer in the 26.x
line and npm 11. Miniflare and type generation require local runtime processes
and loopback ports. Package acceptance also needs npm registry access. None of
these checks requires Cloudflare credentials.

Tests use fixture feeds, fake HTTP/Discord responses, and temporary local D1
instances. Built-Worker runtime tests exercise scheduled events. Generated
files, local databases, and secrets are ignored by Git. `package.json` records
approvals for pinned native installers; review them when updating dependencies.

## Hooks and formatting

Husky calls lint-staged before a commit. Prettier formats staged files and
includes its changes in the commit; Oxlint rejects correctness errors without
starting TypeScript. lint-staged backs up the original state and preserves
unstaged changes, including those in a partially staged file. Commits do not
build, generate types, or run tests. There is no pre-push hook.

| Command                                                     | Purpose                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run check:staged`                                      | Check staged files as the commit hook does                                 |
| `npm run lint` / `npm run lint:fix`                         | Check source/configuration or apply automatic fixes                        |
| `npm run format` / `npm run format:check`                   | Format source, configuration, workflows, and Markdown, or check formatting |
| `npm run format:markdown` / `npm run format:markdown:check` | Format Markdown or check it                                                |
| `npm run types`                                             | Refresh editor types under `.cloudflare/types/`                            |
| `npm run build`                                             | Build `.cloudflare/output/` without uploading                              |
| `npm test`                                                  | Build the Worker and run source/runtime tests                              |

Prettier wraps Markdown prose to its default 80-column target. `AGENTS.md`,
`TODO.md`, and `review/` preserve their existing prose wrapping for
installer-managed text, queue metadata, and review records. Vendored `docket/`
and private `.docket/` files are excluded from formatting. CI checks formatting
through `npm run format:check`.

If a commit reports a missing hook command or package after an update, run
`npm ci` in that checkout and retry. For a lint-staged failure, inspect
`git status` and `git diff --cached`; an interrupted run may retain a
`lint-staged automatic backup` in `git stash list`.

## CLI and package development

Run the source CLI and local status without installing globally:

```sh
npm run syndicord -- --help
npm run syndicord -- status --local
```

Local status needs the local migrations from
[development](DEVELOPMENT.md#run-locally). `status` without `--local` reads
hosted D1 and requires Cloudflare access; see [operational status](STATUS.md).
The standalone `npm run status -- --local` script requires an explicit `--local`
or `--remote` target.

For a deployment dry-run, first set the account, Worker, and database IDs from
[installation selection](OPERATIONS.md#select-a-cloudflare-installation), then
run:

```sh
npm run deploy -- --dry-run
```

This validates the build without uploading or applying hosted migrations.

The repository's `.npmrc` sets `loglevel=silent` so npm banners do not pollute
JSON output. Commands retain their own output, errors, and exit status. To see
npm diagnostics for one invocation, use `npm --loglevel=notice ci`.

`npm run package` builds the distributable CLI and Worker under ignored `dist/`.
The npm prepare lifecycle builds these when installing from Git; it does nothing
in a built npm package, which contains no source or development tools. The
installed CLI uses its bundled Worker. Deployment from source always rebuilds
before touching the hosted installation, without relying on an older package or
globally installed CLI.

`npm run test:package` installs production dependencies in disposable
directories and exercises the installed CLI, local D1, and deployment dry-runs,
then cleans up. No installation identifiers, live feeds, secrets, or local state
are packaged. Registry publication is a separate release operation; normal
[installation from GitHub](SETUP.md#optional-npm-installation) needs no registry
release.

## Test policy

- Changes to parsing, routing, delivery, persistence, or CLI behavior need
  focused regression coverage at the affected boundary. Use fixture feeds, fake
  HTTP responses, and temporary local D1 databases.
- Documentation and simple tooling changes can use direct inspection,
  formatting/link checks, and disposable command fixtures instead of tests that
  merely restate their implementation.
- Empty or skipped suites do not establish a passing gate. There is no coverage
  percentage threshold; record the suites and test counts that actually ran.
- Do not retry failures until green. Investigate them and record flakes in
  `TODO.md` with reproduction evidence. A red main must be reverted or recorded
  as P1 work (P0 if release-blocking) the same day; recovery is a subsequent
  passing main run.

Local tests establish neither hosted CPU headroom nor real Discord delivery.
Those require the explicit operator checks in [setup](SETUP.md#verify-delivery)
and [status](STATUS.md).

## Review inputs

Read [relay behavior](BEHAVIOR.md), the [source layout](DEVELOPMENT.md#layout),
and the operator guides for [setup](SETUP.md), [configuration](OPERATIONS.md),
[deployment](DEPLOYMENT.md), [status](STATUS.md), and [recovery](RECOVERY.md).

Focus on these boundaries:

- D1 owns feed/routing configuration, encrypted webhook URLs, and delivery
  state. The web interface and CLI share one API. Worker secrets own the
  encryption key and Discord OAuth settings. Repository and package artifacts
  contain none of these installation values. API responses never reveal saved
  webhooks.
- First observation establishes a silent baseline. Retry identities, leases,
  destination cooldowns, and configuration changes must preserve the documented
  delivery semantics.
- Feed parsing and HTTP requests are bounded. Untrusted feed content must not
  introduce Discord mentions or expose secrets in logs.
- Source and npm-installed CLIs select the intended installation, validate
  before hosted changes, and preserve configuration during deployments and
  schema migrations.

For a codebase review, record `bash scripts/check.sh` and
`bash docket/scripts/ci.sh` results, including test counts and any unavailable
environment capabilities. Inspect the maintained `src/`, `cli/`, `scripts/`,
`migrations/`, `test/`, root configuration, workflows, and documentation.
`docket/` is vendored; check its provenance with the installed Docket skill's
`install.sh --check` when available, without editing individual vendored files.

Use these drift checks:

```sh
bash docket/scripts/review-due.sh --paths 'src cli scripts migrations test'
rg -n 'TODO|FIXME|HACK|XXX' src cli scripts migrations test
rg -n 'oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error' src cli scripts test
git ls-files
git status --short --ignored
```

No matches from `rg` is a valid result. Compare documented CLI commands and
configuration limits with their implementations; compare this file with the hook
and CI configuration. Inspect tracked files for stray credentials, generated
output, databases, and package archives. Expected project files are
TypeScript/JavaScript, SQL migrations, JSON, Markdown, shell scripts, workflow
YAML, XML fixtures, SVG/PNG artwork, the license, and tool configuration.
`node_modules/`, `.cloudflare/`, `dist/`, `.docket/`, and `.worktrees/` are
private or generated state.

## CI and hosting

`.github/workflows/check.yml` runs on pull requests (including body edits),
pushes to main, and manual dispatch. **Check** calls the same setup and check
scripts as local validation. **Queue and PR hygiene** runs
`docket/scripts/ci.sh` with the PR body and full base history. Production
deployment on main waits for both jobs. The workflow uses the Node version in
`.node-version` and npm version in `package.json`, caches npm downloads, and
disables hooks while running checks directly. Superseded PR runs are cancelled;
main runs are retained. There is no scheduled extended validation workflow; the
complete package suite runs on every PR and main push.

To inspect CI, open the repository's **Actions → CI** page or use
`gh run list --workflow check.yml`. A manual run on `main` also attempts a
production deployment: use **Run workflow → main** or
`gh workflow run check.yml --ref main` only when that deployment is intended.
See [automatic deployment](DEPLOYMENT.md) for credentials and setup.

As inspected on 2026-11-20, the default branch's active GitHub ruleset prevents
deletion and requires linear history, with an administrator bypass. It does not
require passing checks or approving reviews. The repository uses squash merges
with the PR title and body, and deletes merged branches. These settings do not
replace independent review or the user's final approval. Recommended required
checks are **Check** and **Queue and PR hygiene**; changing hosting settings is
a separate user decision.

Each change records actual validation and its limits. Independent review
evidence belongs in a PR comment or `.docket/review-<slug>.md`, not in the PR
description that becomes the squash commit message. Full codebase reviews are
indexed in [review/README.md](../review/README.md).
