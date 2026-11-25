# Run an installation

**For the installation owner, with access to the installation's Cloudflare
account.** If you manage feeds or channels, use
[Manage feeds and channels](FEEDS.md); those tasks only need Discord sign-in. To
host a new installation, start with [Set up an installation](SETUP.md).

## Select a Cloudflare installation

Deployment, migrations, and operational status require Cloudflare access.
Signing in with Discord gives access to the feed editor, not to Cloudflare. Use
the account ID, Worker name, and D1 database UUID saved during
[setup](SETUP.md#steps). Reuse the existing database ID.

Commands use the checkout form; see [Install the CLI](CLI.md#npm-installation)
for the `npx syndicord` form.

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
export SYNDICORD_DATABASE_ID='your-database-uuid'
npm run syndicord -- cf auth login
npm run syndicord -- status
```

Each independent installation has its own Worker and D1 database. When switching
between feed editing and infrastructure commands, check that the
[web-editor address](FEEDS.md#select-an-installation) and Cloudflare identifiers
refer to the same installation. The status command reads saved D1 health without
sending a Discord message; [reading the report](STATUS.md#reading-the-report)
explains its results. The [documentation](README.md#operate-an-installation)
lists the other operating tasks.

## Update the installation

Use the same account, Worker, and database identifiers as above. For a checkout,
pull the revision you want, then run:

```sh
npm ci
npm run check
npm run deploy
```

For an npm installation, [update the CLI](CLI.md#update-the-cli), then run
`npx syndicord deploy`. Deployments preserve feeds, webhook URLs, and Worker
secrets. To deploy on every push to `main` instead, set up
[Automatic deployment from GitHub](GITHUB_DEPLOYMENT.md). To return to earlier
code, see [Pause and roll back](RECOVERY.md#pause-and-roll-back).

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
