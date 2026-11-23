# Configure Discord sign-in

For the person who hosts syndicord and manages its Cloudflare resources. To use
an existing installation, start with [managing feeds](USAGE.md).
[First deployment](SETUP.md) brings you here once the Worker is running.

People sign in to the web editor with Discord. You choose which Discord roles
can edit feeds and channels using one of the access models below. The
[syndicord CLI](USAGE.md) signs in through the browser and edits the same
configuration through the same API. Changes apply on the next scheduled poll.

## Enable administration

Start with a deployed Worker and its HTTPS address. If you have not deployed
yet, complete [first deployment](SETUP.md#create-the-database-and-deploy).
Administration remains disabled until all settings below are present. Missing
OAuth settings do not prevent deployment or scheduled relay operation. A fresh
installation starts empty, with polling paused.

Choose how people will edit feeds and channels:

| Access model                              | Who can edit what                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **One admin role**                        | Members of one configured Discord role can manage every feed, webhook, and route.                                                           |
| **Separate feed and channel permissions** | Roles can manage the shared feed catalog (the list of sources), specified destination channels, or both. A person's matching roles combine. |

Both use the same Discord application and encryption key. The
[permissions guide](PERMISSIONS.md#access-models) explains the models and gives
an example of separate feed and channel responsibilities.

### Register a Discord application

1. Open the
   [Discord Developer Portal](https://discord.com/developers/applications) and
   choose **New Application**, or select the application for this installation.
2. Under **OAuth2**, copy the **Client ID**, then reset/copy the **Client
   Secret** into your password manager. Only the Worker receives the client
   secret.
3. Under **OAuth2 → Redirects**, register the exact callback URL:
   `https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev/admin/auth/callback`. Use your
   custom HTTPS origin instead if that is where you administer the Worker. Save
   changes. The registered URL and `DISCORD_REDIRECT_URI` must match exactly,
   including scheme, host, port, and path.
4. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click
   the server and choose **Copy Server ID**. Under **Server Settings → Roles**,
   create or select the role allowed to administer syndicord and copy its role
   ID from the role's context menu. Use the numeric IDs, not names. For separate
   feed and channel permissions, collect the roles and channels in your
   [policy](PERMISSIONS.md#configure-access).

There is no Discord CLI setup command in this project; use these dashboard
steps. No bot installation or privileged member intent is needed. Sign-in asks
only for `identify` and `guilds.members.read`. It does not invite anyone, join a
server, or assign a role. Invitations and role assignment remain separate
server-administration actions.

### Configure the Worker

Use the values collected in
[Register a Discord application](#register-a-discord-application) above. The
`DISCORD_*` settings below name those same values; `CONFIG_ENCRYPTION_KEY` is a
separate key you generate here. Save these runtime settings on the Cloudflare
Worker. GitHub's `production` environment holds the deployment credentials
described in [automatic deployment](DEPLOYMENT.md).

For CLI commands,
[select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation)
first. Choose one way to save the settings below.

Generate an encryption key once, and save it in your password manager. Reuse an
installation's existing key if it already has saved webhooks:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

| Setting                 | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `CONFIG_ENCRYPTION_KEY` | Base64-encoded 32-byte key for saved webhooks and Discord session tokens |
| `DISCORD_CLIENT_ID`     | Client ID copied from Discord Developer Portal → OAuth2 (step 2)         |
| `DISCORD_CLIENT_SECRET` | Client Secret copied from Discord Developer Portal → OAuth2 (step 2)     |
| `DISCORD_REDIRECT_URI`  | Exact callback URL saved under OAuth2 → Redirects (step 3)               |
| `DISCORD_GUILD_ID`      | Server ID copied in Discord (step 4), when using one admin role          |
| `DISCORD_ROLE_ID`       | Role ID copied in Discord (step 4), when using one admin role            |

- **Cloudflare Dashboard:** Open **Workers & Pages → your Worker → Settings →
  Variables and Secrets**. Add each setting as a **Secret** using the names
  above, then deploy the changes. IDs and the callback URL are not confidential,
  but storing them as secrets preserves them alongside the other runtime
  settings during code deployment.
- **CLI:** Each command uses a hidden value prompt. Paste the value there. For
  separate feed and channel permissions, run the first four commands, then
  [set `DISCORD_AUTH_POLICY`](PERMISSIONS.md#configure-access); skip the last
  two commands, which configure one admin role.

  ```sh
  npm run syndicord -- cf workers secrets update CONFIG_ENCRYPTION_KEY \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_CLIENT_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_CLIENT_SECRET \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_REDIRECT_URI \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_GUILD_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_ROLE_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  ```

For separate feed and channel permissions, use `DISCORD_AUTH_POLICY` instead of
`DISCORD_GUILD_ID` and `DISCORD_ROLE_ID` in either method. All other settings
remain required.

For the [npm-installed CLI](SETUP.md#optional-npm-installation), substitute
`npx syndicord` for `npm run syndicord --`.

Open **Cloudflare Dashboard → Workers & Pages → your Worker** and copy its HTTPS
address. Add `/admin` to make the web-editor link, for example
`https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev/admin`. Share this complete link
with the people who will manage feeds and channels.

Open the link in your browser and sign in. An authorized account sees its
Discord identity, a **Sign out** control, and the editor. An account without the
configured membership or role receives an explanation and can sign out or try
another Discord account.

## CLI login

```sh
export SYNDICORD_ADMIN_URL='https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev'
npm run syndicord -- login
```

The CLI opens a browser and prints a verification URL and code. If opening the
browser fails, open that URL yourself. Use `login --no-browser` to print the URL
without opening a browser. Sign in with Discord, check that the code matches the
terminal, and approve the CLI request. Approve only a request you started. The
CLI receives its own syndicord session; Discord tokens and the client secret
stay on the Worker. Copying browser cookies is unnecessary.

Sessions are saved privately under `$XDG_CONFIG_HOME/syndicord`, or
`~/.config/syndicord`, and separated by Worker origin. Configuration commands
need no Cloudflare credentials. When a session expires, run `login` again. Sign
out of the selected installation with:

```sh
npm run syndicord -- logout
```

## Grant and revoke access

- **Grant:** Invite the person to a configured Discord server separately, then
  assign its configured role in **Discord → Server Settings → Members**. Have
  them sign in. With separate feed and channel permissions, their matching roles
  combine the corresponding permissions.
- **Revoke:** Remove that role, or remove the person from the server. Both the
  editor and configuration API check Discord membership and role; every
  configuration write requires a fresh check. Already loaded pages may remain
  visible, but further saves are refused. A write already authorized may finish.
- **Sign out:** Browser sign-out and CLI logout invalidate their respective
  application sessions. They do not sign the person out of Discord itself.
- **Change accounts:** Use **Try Discord sign-in again** on the access page, or
  sign out and choose **Sign in with Discord**. Select/switch the account in
  Discord's authorization screen. A private browser window can also select a
  different Discord login.

Sessions last at most eight hours and never outlive the Discord access token.
Expired or revoked credentials require another login. Discord outages and rate
limits block access until the check can succeed; no alternative login is used.

To disable administration without stopping the relay, delete
`DISCORD_CLIENT_SECRET` in **Cloudflare Dashboard → Workers & Pages → your
Worker → Settings → Variables and Secrets**, then deploy that settings change.
Alternatively, use the Cloudflare CLI command:

```sh
npm run syndicord -- cf workers secrets delete DISCORD_CLIENT_SECRET \
  --worker "$SYNDICORD_WORKER_NAME"
```

This closes both the editor and configuration CLI. Keep `CONFIG_ENCRYPTION_KEY`
stable and backed up: changing or losing it makes saved webhooks unreadable and
stops delivery until the correct key is restored. Back up D1 and the key
together for recovery.

## Add feeds and routing

Use [managing feeds](USAGE.md) for the web and CLI steps in either access model.
Feed changes apply on the next scheduled poll without a deployment. New
feed/destination pairs establish a silent baseline before delivering posts. See
[delivery behavior](BEHAVIOR.md) for retries and configuration changes.

## Troubleshooting and acceptance

| Symptom                             | Check                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Administration disabled             | OAuth/key settings, valid policy or server/role pair, callback origin/path, and migrations          |
| Discord rejects the callback        | The exact registered redirect matches `DISCORD_REDIRECT_URI` and the origin used in the browser/CLI |
| Access denied                       | The account matches a policy grant, or the exact server/role IDs configured for one admin role      |
| Sign-in expired or already used     | Start sign-in again; callbacks and CLI grants are single use                                        |
| Discord unavailable or rate limited | Wait as directed and retry; configuration has not been authorized                                   |
| CLI cannot authenticate             | Select the intended origin and run `login` again                                                    |

Automated checks use mocked Discord responses and local D1. Before relying on a
hosted installation, verify with real accounts: authorized browser and CLI
login, denied consent, a nonmember, a member without the role, and removal of
the role while both clients are signed in. Confirm that fresh reads/saves are
refused, logout invalidates the session, and a new login restores access only
after membership and role are granted. These checks require your own Discord
application and Cloudflare deployment.

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

In **Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables
and Secrets**, add either setting as a **Secret** and deploy the changes. These
values are visible on the page; using the Secret type preserves them during code
deployments, like the other installation settings.

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
installation's defaults, remove the setting in **Cloudflare Dashboard → Workers
& Pages → your Worker → Settings → Variables and Secrets** and deploy the
change, or use `cf workers secrets delete ADMIN_NAME` or
`cf workers secrets delete ADMIN_HEADER_COLOR` with the same Worker selection.
For local development, remove the setting from `.dev.vars`. Custom logos and
page-wide themes are not supported.

## Local preview

Follow [local development setup](DEVELOPMENT.md#run-locally). For interactive
Discord login, register `http://localhost:8787/admin/auth/callback` on a
development application and configure that callback in `.dev.vars`. Visit
`http://localhost:8787/admin`; for terminal editing set
`SYNDICORD_ADMIN_URL=http://localhost:8787` and run `login`. HTTP is permitted
only for loopback development. Automated tests need no real Discord application.

Both clients edit only that local Worker's D1 database. Saving configuration
does not send a Discord message; manually triggering a scheduled poll can.

## Authentication design

The Worker uses Discord's authorization-code flow with S256 PKCE, one-time
browser-bound state, and server-side code exchange. Discord's
[authorization server metadata](https://discord.com/.well-known/oauth-authorization-server)
advertises S256 support. It queries
[the current user's guild membership](https://docs.discord.com/developers/resources/user#get-current-user-guild-member)
with the user's access token and checks role IDs. See
[Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) for the
scopes and flow. These references were checked on 2026-11-22.

Syndicord owns revocable D1 sessions with opaque tokens, bounded lifetimes, and
Secure HttpOnly SameSite cookies in production. Discord access tokens are
encrypted in D1, never returned to the browser or CLI, and never logged by the
application. The deployment enables Cloudflare query-string redaction for
request logs and traces so callback codes are omitted from those URLs. Verify
this setting in the hosted installation and keep external proxies from logging
callback queries. Browser writes require the same origin; CLI writes
authenticate with the CLI's separate bearer session. Server-side authorization
covers both the editor and the shared configuration API.

[Documentation index](README.md) · [Manage feeds](USAGE.md) ·
[Feed and channel permissions](PERMISSIONS.md)
