# Run an installation

For the person who hosts syndicord and manages its Cloudflare resources. This is
the **installation owner** in these guides. If you manage feeds or channels, use
[Using syndicord](USAGE.md); those tasks only need Discord sign-in. To host a
new installation, start with [setup](SETUP.md).

## Select a Cloudflare installation

Deployment, migrations, and operational status require Cloudflare access.
Signing in with Discord gives access to the feed editor, not to Cloudflare. Use
the account ID, Worker name, and D1 database UUID saved during
[setup](SETUP.md#select-an-installation). Reuse the existing database ID.

The examples use a source checkout. For the
[npm-installed CLI](SETUP.md#optional-npm-installation), replace
`npm run syndicord --` with `npx syndicord`.

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
export SYNDICORD_DATABASE_ID='your-database-uuid'
npm run syndicord -- cf auth login
npm run syndicord -- status
```

Each independent installation has its own Worker and D1 database. When switching
between feed editing and infrastructure commands, check that the
[web-editor address](USAGE.md#select-an-installation) and Cloudflare identifiers
refer to the same installation. The status command reads saved D1 health without
sending a Discord message; [reading the report](STATUS.md#reading-the-report)
explains its results.

## Maintain the installation

| Task                                                 | Guide                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Configure sign-in or change who can edit             | [Sign-in and access](WEB.md)                                |
| Update the deployed code                             | [Update the installation](SETUP.md#update-the-installation) |
| Deploy automatically from GitHub                     | [Automatic deployment](DEPLOYMENT.md)                       |
| Check health and pending deliveries                  | [Operational status](STATUS.md)                             |
| Diagnose failures, pause, roll back, or restore data | [Troubleshooting and recovery](RECOVERY.md)                 |

## Where settings and state live

| Setting                                                          | Authoritative location    |
| ---------------------------------------------------------------- | ------------------------- |
| Feed URLs, routing, encrypted webhook URLs                       | D1 `relay_configuration`  |
| Discord OAuth settings, authorization policy, and encryption key | Cloudflare Worker secrets |
| Baselines, pending deliveries, and health                        | D1 delivery ledger        |
