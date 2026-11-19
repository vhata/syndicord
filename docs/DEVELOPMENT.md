# Development

The project uses TypeScript, npm, and the Cloudflare CLI (`cf`), with
Wrangler as its bundler. Node.js 26.13.0 is recorded in `.node-version`;
the package requires Node.js 26.12 or newer in the 26.x line and npm 11.
The CLI is installed locally as a pinned development dependency.

## Setup

From the repository root:

```sh
npm ci
npm run check
```

`npm ci` installs the versions recorded in `package-lock.json`.
`package.json` records install-script approvals for the pinned `esbuild`
and `workerd` binaries used by the Cloudflare tooling. Review those approvals when
updating dependencies.

`npm run check` checks formatting, generates Workers types, and type-checks
the TypeScript configuration. The source and test directories are empty;
the check does not exercise application behavior.

`npm run types` runs `cf workers types` and writes generated declarations
under `.cloudflare/types/`. These files are ignored by Git and regenerated
on every check. Run the command separately to refresh editor types after
changing `cloudflare.config.ts`.

`npm run format` formats TypeScript, JSON, and Markdown files.

## Layout

| Path                   | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `src/`                 | Worker source directory                                |
| `test/`                | Test directory                                         |
| `cloudflare.config.ts` | Worker identity and runtime configuration              |
| `tsconfig.json`        | Strict TypeScript settings and generated Workers types |
| `docs/`                | Development documentation                              |

The Cloudflare configuration names the worker `syndicord` and disables
`workers.dev` and preview URLs. It has no entrypoint, cron schedule, or
resource bindings; this scaffold is not a deployable worker.

## Local secrets

Keep Discord webhook URLs and other secrets in `.dev.vars` for local
development. `.dev.vars` and `.env` files, including environment variants,
are ignored by Git. Files named `.dev.vars.example` or `.env.example` are
trackable and must contain placeholders only.

## Tooling references

- [Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare CLI project commands](https://developers.cloudflare.com/cf/projects/)
