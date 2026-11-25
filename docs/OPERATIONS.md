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
| Configure sign-in or change who can edit             | [Sign-in and access](DISCORD_SIGN_IN.md)                    |
| Update the deployed code                             | [Update the installation](SETUP.md#update-the-installation) |
| Deploy automatically from GitHub                     | [Automatic deployment](GITHUB_DEPLOYMENT.md)                |
| Check health and pending deliveries                  | [Operational status](STATUS.md)                             |
| Diagnose failures, pause, roll back, or restore data | [Troubleshooting and recovery](RECOVERY.md)                 |

## Where settings and state live

| Setting                                                          | Authoritative location    |
| ---------------------------------------------------------------- | ------------------------- |
| Feed URLs, routing, encrypted webhook URLs                       | D1 `relay_configuration`  |
| Discord OAuth settings, authorization policy, and encryption key | Cloudflare Worker secrets |
| Baselines, pending deliveries, and health                        | D1 delivery ledger        |

## Installation name and colour

The admin editor and its sign-in and access pages can show an installation name
beside the syndicord mark and use a custom header colour. The name also appears
in the browser tab. Both settings are optional:

| Setting              | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_NAME`         | Installation name, for example `Community updates`. Surrounding spaces are removed; at most 80 characters are shown. |
| `ADMIN_HEADER_COLOR` | Six-digit hex colour, for example `#304B70`. Header text automatically uses black or white for contrast.             |

Use the
[HTML Color Codes colour picker](https://htmlcolorcodes.com/color-picker/) to
choose a colour, then copy its six-digit hex value, including the leading `#`,
into `ADMIN_HEADER_COLOR`.

Open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
in the Cloudflare dashboard, select your Worker, then open **Settings →
Variables and Secrets**. Add either setting as a **Secret** and deploy the
changes. These values are visible on the page; using the Secret type preserves
them during code deployments, like the other installation settings.

Alternatively, use the CLI's value prompts:

```sh
npm run syndicord -- cf workers secrets update ADMIN_NAME \
  --worker "$SYNDICORD_WORKER_NAME" --type secret_text
npm run syndicord -- cf workers secrets update ADMIN_HEADER_COLOR \
  --worker "$SYNDICORD_WORKER_NAME" --type secret_text
```

For local development, set these values in `.dev.vars`. Reload the page after
changing them. An absent or blank name shows only syndicord; an absent or
invalid colour uses the default dark green header. To restore a hosted
installation's defaults, open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
select your Worker, then open **Settings → Variables and Secrets**, remove the
setting, and deploy the change. Alternatively, use
`cf workers secrets delete ADMIN_NAME` or
`cf workers secrets delete ADMIN_HEADER_COLOR` with the same Worker selection.
For local development, remove the setting from `.dev.vars`. Custom logos and
page-wide themes are not supported.
