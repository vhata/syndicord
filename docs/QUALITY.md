# Quality and validation

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

Husky's pre-commit hook calls lint-staged. Prettier writes staged formatting
changes; Oxlint rejects correctness errors. Unstaged changes are preserved.
Commits do not build, generate types, or run tests, and there is no pre-push
hook. Vendored `docket/` files and private `.docket/` evidence are excluded from
formatting. Hook recovery is documented in
[development](DEVELOPMENT.md#commit-hooks-and-ci).

Toolchain versions are pinned in `.node-version`, `package.json`, and
`package-lock.json`. Miniflare and type generation require local runtime
processes and loopback ports. Package acceptance also needs npm registry access.
None of these checks requires Cloudflare credentials.

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
deployment on main waits for both jobs. Superseded PR runs are cancelled; main
runs are retained. There is no scheduled extended validation workflow; the
complete package suite runs on every PR and main push.

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
