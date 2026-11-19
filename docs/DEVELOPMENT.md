# Development

syndicord uses TypeScript, npm, and the Cloudflare CLI (`cf`), with Wrangler
as its bundler. Node.js 26.13.0 is recorded in `.node-version`; the package
requires Node.js 26.12 or newer in the 26.x line and npm 11. The commands
use a POSIX shell, such as Bash or zsh.

## Check the project

```sh
npm ci
npm run check
```

The check covers formatting, generated Workers types, TypeScript, the Worker
build, and tests. Tests use fixture feeds, fake Discord responses, and temporary
local D1 databases. A runtime test exercises scheduled events in the built
Worker. These checks need no Cloudflare account or Discord credentials.

Miniflare and type generation start local runtime processes and bind loopback
ports. Restricted sandboxes must permit those operations. Local tests do not
measure hosted CPU usage or prove live Discord delivery.

`npm run types` refreshes editor types under `.cloudflare/types/`.
`npm run format` formats TypeScript, JSON, and Markdown. `npm test` builds the
Worker and runs the tests. `npm run build` writes the deployment artifact to
`.cloudflare/output/` without uploading it.

`package-lock.json` pins dependency versions. `package.json` records approvals
for the pinned native installers used by Cloudflare's tools; review these when
updating dependencies. Generated files, local databases, and secrets are ignored
by Git.

## Run locally

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with the real Discord webhook URLs for the destination names
in `feeds.json`. Keep that file private. Then:

```sh
npm run db:migrate:local
npm run dev
```

The migration command always uses `--local`. It uses the same database ID as
the Worker configuration: the exported `SYNDICORD_DATABASE_ID`, or the built-in
local placeholder when that variable is absent. Export that variable in the
shell when changing it, rather than putting it in a dotenv file.

The local server normally listens on port 8787. Trigger a poll through the local
runtime's scheduled-event route:

```sh
curl -fsS 'http://localhost:8787/cdn-cgi/local/scheduled'
```

This local poll uses the configured feeds and **real Discord webhooks**.
The first successful poll establishes a silent baseline. Later polls send new
entries. The scheduled-event route belongs to the local runtime; the deployed
Worker's HTTP handler returns 404.

Local D1 state is under `.cloudflare/state/` and is separate from hosted state.
The automated tests create their own databases and do not change this state.

## Layout

| Path                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `src/config.ts`        | Feed and webhook validation                             |
| `src/feed.ts`          | RSS and Atom normalization                              |
| `src/discord.ts`       | Message formatting and confirmed webhook delivery       |
| `src/ledger.ts`        | D1 baselines, pending deliveries, leases, and cooldowns |
| `src/runner.ts`        | Bounded polling and delivery orchestration              |
| `src/index.ts`         | Scheduled Worker entrypoint                             |
| `test/`                | Unit, D1 integration, and built-Worker tests            |
| `migrations/`          | D1 schema migrations                                    |
| `cloudflare.config.ts` | Worker, bindings, schedule, and logging                 |

See [operations](OPERATIONS.md) for configuration, deployment, and recovery.

## Tooling references

- [Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare CLI project commands](https://developers.cloudflare.com/cf/projects/)
