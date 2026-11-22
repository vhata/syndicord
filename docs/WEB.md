# Discord sign-in and administration

Open **`/admin`** on your Worker's HTTPS address and choose **Sign in with
Discord** to manage feeds, webhooks, and routing. Access requires membership in
an operator-configured Discord role. Use [scoped permissions](PERMISSIONS.md) to
combine roles across servers and delegate individual destination channels.
Without a policy, one configured server/role pair administers all configuration.
The [syndicord CLI](OPERATIONS.md) signs in through the browser and edits the
same configuration through the same API. Changes apply on the next scheduled
poll.

## Enable administration

[Select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation),
then deploy code and migrations with `npm run deploy` or your
[deployment workflow](DEPLOYMENT.md). Administration remains disabled until all
settings below are present. Missing OAuth settings do not prevent deployment or
scheduled relay operation. A fresh installation starts empty, with polling
paused.

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
   ID from the role's context menu. Use the numeric IDs, not names.

There is no Discord CLI setup command in this project; use these dashboard
steps. No bot installation or privileged member intent is needed. Sign-in asks
only for `identify` and `guilds.members.read`. It does not invite anyone, join a
server, or assign a role. Invitations and role assignment remain separate
server-administration actions.

### Configure the Worker

Generate an encryption key once, and save it in your password manager. Reuse an
installation's existing key if it already has saved webhooks:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

| Setting                 | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `CONFIG_ENCRYPTION_KEY` | Base64-encoded 32-byte key for saved webhooks and Discord session tokens |
| `DISCORD_CLIENT_ID`     | Application's numeric client ID                                          |
| `DISCORD_CLIENT_SECRET` | Application's client secret                                              |
| `DISCORD_REDIRECT_URI`  | Exact registered `/admin/auth/callback` URL                              |
| `DISCORD_GUILD_ID`      | Numeric server ID for the single-role mode                               |
| `DISCORD_ROLE_ID`       | Numeric required role ID for the single-role mode                        |

- **Cloudflare Dashboard:** Open **Workers & Pages → your Worker → Settings →
  Variables and Secrets**. Add each setting as a **Secret** using the names
  above, then deploy the changes. IDs and the callback URL are not confidential,
  but storing them as secrets preserves them alongside the other runtime
  settings during code deployment.
- **CLI:** Run these commands. Each uses the CLI's hidden value prompt; paste
  the corresponding value rather than putting credentials in shell history.

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

For scoped access, configure
[`DISCORD_AUTH_POLICY`](PERMISSIONS.md#configure-access) instead of the two
single-role settings. All other settings remain required.

For the [npm-installed CLI](SETUP.md#optional-npm-installation), substitute
`npx --no-install syndicord` for `npm run syndicord --`.

Visit the Worker's `/admin` address and sign in. Its Cloudflare overview shows
its HTTPS address. An authorized account sees its Discord identity, a **Sign
out** control, and the editor. An account without the configured membership or
role receives an explanation and can sign out or try another Discord account.

## Installation name and colour

The admin editor and its sign-in and access pages can show an installation name
beside the syndicord mark and use a custom header colour. The name also appears
in the browser tab. Both settings are optional:

| Setting              | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_NAME`         | Installation name, for example `Community updates`. Surrounding spaces are removed; at most 80 characters are shown. |
| `ADMIN_HEADER_COLOR` | Six-digit hex colour, for example `#304B70`. Header text automatically uses black or white for contrast.             |

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
invalid colour uses the default dark green header. Remove either setting from
**Variables and Secrets**, or use `cf workers secrets delete ADMIN_NAME` or
`cf workers secrets delete ADMIN_HEADER_COLOR` with the same Worker selection,
to restore its default. Custom logos and page-wide themes are not supported.

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

- **Grant:** Invite the person to the configured server separately, then assign
  the configured role in **Server Settings → Members**. Have them sign in.
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
`DISCORD_CLIENT_SECRET` in **Variables and Secrets**, or run:

```sh
npm run syndicord -- cf workers secrets delete DISCORD_CLIENT_SECRET \
  --worker "$SYNDICORD_WORKER_NAME"
```

This closes both the editor and configuration CLI. Keep `CONFIG_ENCRYPTION_KEY`
stable and backed up: changing or losing it makes saved webhooks unreadable and
stops delivery until the correct key is restored. Back up D1 and the key
together for recovery.

## Add feeds and routing

With `DISCORD_AUTH_POLICY`, use the
[catalog and subscription controls](PERMISSIONS.md#feeds-and-subscriptions). The
following whole-configuration flow applies only to single-role installations.

1. In Discord, open the destination channel's **Edit Channel → Integrations →
   Webhooks**, create a webhook, and copy its URL.
2. In syndicord, add that webhook with a short destination name.
3. Add a feed URL, choose its destinations, and save.

For terminal equivalents, use [`webhooks set` and `feeds set`](OPERATIONS.md). A
feed can send to several destinations, and a destination can receive several
feeds. There is no fixed feed or route count limit; see
[polling and configuration-size limits](OPERATIONS.md#polling-limits). Each feed
needs at least one destination. Remove a feed to stop its routes; remove all
feeds to pause polling. New routes silently establish a baseline before
delivering new posts. A poll already in progress may finish using its earlier
configuration.

Saved webhook URLs stay hidden. To rotate one, replace its URL under the same
destination name. Remove its routes before deleting the webhook. Deleting it in
syndicord does not delete it in Discord.

If another client changes configuration while a form is open, the editor rejects
the stale save. Reload and reapply your change. CLI writes also reject changes
that race with the command; exported feed files must be kept current. Feeds and
encrypted webhooks remain in D1's `relay_configuration` record, and saves update
them atomically. Deployments preserve configuration and secrets.

## Troubleshooting and acceptance

| Symptom                             | Check                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Administration disabled             | OAuth/key settings, valid policy or server/role pair, callback origin/path, and migrations          |
| Discord rejects the callback        | The exact registered redirect matches `DISCORD_REDIRECT_URI` and the origin used in the browser/CLI |
| Access denied                       | The signed-in account belongs to the configured server and has the exact configured role ID         |
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
