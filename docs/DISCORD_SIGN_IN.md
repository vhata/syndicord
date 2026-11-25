# Configure Discord sign-in

This guide is for the person hosting syndicord. It connects a deployed Worker to
Discord and sets which roles can manage feeds and channels, in both the web
editor and CLI. If someone has already set up your installation, go straight to
[managing feeds](USAGE.md).

For a new installation, follow the setup steps below, then continue to
[Using syndicord](USAGE.md) to add your first feed and destination. The later
[grant and revoke access](#grant-and-revoke-access) and
[troubleshooting](#troubleshooting-and-acceptance) sections are references for
maintaining sign-in after setup.

## Enable administration

Start with a deployed Worker. If you have not deployed yet, complete
[first deployment](SETUP.md#create-the-database-and-deploy). Administration
stays disabled until you finish the steps below. A fresh installation has no
feeds and stays idle until you add them.

### Find and keep your Worker address

Open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
in the Cloudflare dashboard, select your Worker, then open **Domains** and copy
the HTTPS address for its `workers.dev` domain, for example
`https://syndicord.my-community.workers.dev`. Cloudflare's
[Domains tab](https://developers.cloudflare.com/changelog/post/2026-05-14-domains-tab/)
shows the Worker's addresses. Use the address without a trailing slash or path;
this is the **Worker origin** used below. If you already connected your own
HTTPS domain to this Worker, you can use that address instead. No custom domain
is needed for setup.

Create a password-manager entry for this installation and save the address as
**Worker URL**. Keep this entry open: you will collect the Discord credentials
and IDs there, then paste them into the Worker settings later in this guide. The
address also gives you two links:

| Link             | Make it by                                   | Example                                                          |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Discord callback | Add `/admin/auth/callback` to the Worker URL | `https://syndicord.my-community.workers.dev/admin/auth/callback` |
| Web editor       | Add `/admin` to the Worker URL               | `https://syndicord.my-community.workers.dev/admin`               |

Save both links in the same entry. The callback is where Discord returns you
after sign-in; you will register it in the next steps. The web-editor link is
what you will open and share with editors once setup is complete.

For a terminal lookup, use the terminal from deployment, where
`CLOUDFLARE_ACCOUNT_ID` and `SYNDICORD_WORKER_NAME` are still set:

```sh
npm run syndicord -- cf workers get "$SYNDICORD_WORKER_NAME" -q
```

Copy the `subdomain.url` value from the JSON output. The optional
[Worker address lookup](PROVIDER_API.md#find-the-worker-address) shows how to
extract just the URL with `jq`. For an
[npm-installed CLI](SETUP.md#optional-npm-installation), replace
`npm run syndicord --` with `npx syndicord`.

### Choose an access model

Choose based on what people should be allowed to manage. **One admin role** is
the simplest starting point when all editors should have full access.

| Model                                     | Use it when                                                                                    | What you will configure                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **One admin role**                        | Everyone with one role should manage every feed, webhook, and route.                           | A server ID and role ID in [Configure one admin role](#configure-one-admin-role).                                   |
| **Separate feed and channel permissions** | You want feed curators, editors limited to particular channels, or roles from several servers. | A JSON policy listing each role's permissions in [Configure separate permissions](#configure-separate-permissions). |

Choosing here does not change the Worker yet. Both paths first need the same
Discord application and encryption key. After saving those common settings,
follow **only your chosen model's configuration section**. For examples of
separate responsibilities, see [access models](PERMISSIONS.md#access-models).

### Register a Discord application

Collect the following values in your installation's password-manager entry. You
will use them under [Configure the Worker](#configure-the-worker), so there is
no need to set Worker secrets while working through these steps.

1. Open the
   [Discord Developer Portal](https://discord.com/developers/applications) and
   choose **New Application**, or select the application for this installation.
2. Under **OAuth2**, copy the **Client ID** and **Client Secret** into the
   entry, labelled `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. Use **Reset
   Secret** if you need to generate a secret. Keep it private; you will give it
   only to the Worker.
3. Under **OAuth2 → Redirects**, add the **Discord callback** you saved
   [above](#find-and-keep-your-worker-address), then save changes. For the
   example Worker, this is
   `https://syndicord.my-community.workers.dev/admin/auth/callback`. Save that
   exact URL as `DISCORD_REDIRECT_URI` in your entry too. Discord's registered
   URL and this Worker setting must match exactly.
4. In your **Discord client**, enable **User Settings → Advanced → Developer
   Mode** so you can copy numeric IDs. Right-click the server where you want to
   deliver RSS feeds and choose **Copy Server ID**. Under **Server Settings →
   Roles**, create or select the role whose members should manage syndicord,
   then copy its role ID from the role's context menu. For **one admin role**,
   save these as `DISCORD_GUILD_ID` and `DISCORD_ROLE_ID`; Discord calls a
   server a "guild" in its API. For **separate permissions**, collect each
   server and role ID you need, plus channel IDs from the channels' context
   menus, and label them with their server, role, or channel names for building
   the policy.
5. Assign the chosen role to yourself under **Server Settings → Members** so you
   can test sign-in. Owning the server alone does not satisfy syndicord's role
   check.

The Discord-side setup uses the Developer Portal and your Discord client;
syndicord's CLI does not create Discord applications or manage server roles. No
bot installation is needed. Sign-in asks Discord for your identity and server
membership so syndicord can check your roles; it does not join a server or
assign a role.

### Configure the Worker

Now save the Discord values you just collected as settings on the Cloudflare
Worker. You will also create `CONFIG_ENCRYPTION_KEY` below: this is a separate
key syndicord uses to encrypt saved webhook URLs and Discord session tokens.
Both access models need these four common settings.

#### Generate and save the encryption key

For a new installation, run this command once in your terminal:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy its output into your password-manager entry as `CONFIG_ENCRYPTION_KEY`. The
command only prints a new key; you will save it on the Worker in the next step.
For an existing installation, reuse its existing key. Replacing or losing that
key makes saved webhooks unreadable and prevents delivery.

#### Save the four common settings

| Setting                 | Paste this value from your password manager                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `CONFIG_ENCRYPTION_KEY` | The encryption key you just generated, or the installation's existing key |
| `DISCORD_CLIENT_ID`     | Client ID from the Developer Portal                                       |
| `DISCORD_CLIENT_SECRET` | Client Secret from the Developer Portal                                   |
| `DISCORD_REDIRECT_URI`  | The exact callback URL you registered under OAuth2 → Redirects            |

Choose **Cloudflare Dashboard** or **CLI**; both save the same settings:

- **Cloudflare Dashboard:** Open
  [**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
  select your Worker, then open **Settings → Variables and Secrets**. Add each
  setting as a **Secret**, with the name and value above, then deploy the
  settings changes. IDs and the callback URL are not confidential, but the
  Secret type preserves them during code deployment.
- **CLI:** Use the terminal where you set `CLOUDFLARE_ACCOUNT_ID` and
  `SYNDICORD_WORKER_NAME` during setup. If you opened a new terminal,
  [select the installation again](OPERATIONS.md#select-a-cloudflare-installation).
  Run each command below and paste that setting's value at its hidden prompt.
  For an [npm-installed CLI](SETUP.md#optional-npm-installation), replace
  `npm run syndicord --` with `npx syndicord`.

  ```sh
  npm run syndicord -- cf workers secrets update CONFIG_ENCRYPTION_KEY \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_CLIENT_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_CLIENT_SECRET \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_REDIRECT_URI \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  ```

Next, complete one of the following two sections to tell syndicord who may sign
in and edit.

### Configure one admin role

For **one admin role**, save these two additional Worker secrets. Together they
mean "allow members of this server who have this role to manage everything."

| Setting            | Value collected in your Discord client |
| ------------------ | -------------------------------------- |
| `DISCORD_GUILD_ID` | The numeric server ID                  |
| `DISCORD_ROLE_ID`  | The numeric role ID                    |

- **Cloudflare Dashboard:** Add both as **Secret** values in the same **Settings
  → Variables and Secrets** page, then deploy the changes.
- **CLI:** Run each command and paste the corresponding ID at the prompt:

  ```sh
  npm run syndicord -- cf workers secrets update DISCORD_GUILD_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  npm run syndicord -- cf workers secrets update DISCORD_ROLE_ID \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  ```

Continue to
[Sign in and start managing feeds](#sign-in-and-start-managing-feeds).

### Configure separate permissions

For **separate feed and channel permissions**, use the
[policy setup steps](PERMISSIONS.md#configure-access) to build and save one
`DISCORD_AUTH_POLICY` Worker secret and initialize the catalog. That guide
explains the JSON fields, gives a complete example, and shows both dashboard and
CLI commands.

The policy lists server/role pairs and what each may manage. It replaces the
single server/role pair, so this path does not set `DISCORD_GUILD_ID` or
`DISCORD_ROLE_ID`: those two values can express only unrestricted access for one
role. The four common settings above are still needed for sign-in and
encryption. After the policy steps, continue below.

### Sign in and start managing feeds

Open the **web-editor link** saved at the start (your Worker URL plus `/admin`)
and choose **Sign in with Discord**. Use the account you assigned the role to.
An authorized account sees its Discord identity, a **Sign out** control, and the
editor. If access is denied, check the server/role IDs and your role assignment,
or try another Discord account.

**Sign-in setup is complete. Continue to [Using syndicord](USAGE.md)** to add a
destination webhook and feed, in the browser or CLI. CLI login is optional and
is explained there when you choose terminal editing. Once you have a feed and
destination, return to [Verify delivery](SETUP.md#verify-delivery) to check that
new entries reach Discord.

Share the web-editor link with anyone else who should manage feeds and assign
them the configured roles. They need that link and their Discord account; keep
your Worker settings and secrets private.

## Grant and revoke access

- **Grant:** Invite the person to a configured Discord server separately, then
  assign its configured role in your **Discord client → Server Settings →
  Members**. Have them sign in. With separate feed and channel permissions,
  their matching roles combine the corresponding permissions.
- **Revoke:** Remove that role, or remove the person from the server. Browser
  and CLI permissions can remain valid for up to two minutes after their last
  successful Discord check. After that window, further reads and saves require
  another check and are refused if access was removed. Already loaded pages may
  remain visible. A write already authorized may finish.
- **Sign out:** Browser sign-out and CLI logout invalidate their respective
  application sessions. They do not sign the person out of Discord itself.
- **Change accounts:** Use **Try Discord sign-in again** on the access page, or
  sign out and choose **Sign in with Discord**. Select/switch the account in
  Discord's authorization screen. A private browser window can also select a
  different Discord login.

Sessions last at most eight hours and never outlive the Discord access token's
known expiry. Local sign-out, session expiry, and changes to the configured
Discord access policy invalidate access immediately. Discord-side token
revocation, role changes, and server departures are detected when the two-minute
permission window expires. Using the editor or CLI does not extend that window.

A valid permission result can be reused during a Discord outage until its fixed
deadline. After expiry, an outage, rate limit, or invalid Discord response
blocks access; expired permissions are never used as a fallback. A rate-limit
error shows how many seconds to wait. Keep the open form, wait, then save again;
the editor preserves an unsuccessful save's entered values and does not retry
saves automatically.

To disable administration without stopping the relay, open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
in the Cloudflare dashboard, select your Worker, then open **Settings →
Variables and Secrets**. Delete `DISCORD_CLIENT_SECRET` and deploy that settings
change. Alternatively, use the Cloudflare CLI command:

```sh
npm run syndicord -- cf workers secrets delete DISCORD_CLIENT_SECRET \
  --worker "$SYNDICORD_WORKER_NAME"
```

This closes both the editor and configuration CLI. Keep `CONFIG_ENCRYPTION_KEY`
stable and backed up: changing or losing it makes saved webhooks unreadable and
stops delivery until the correct key is restored. Back up D1 and the key
together for recovery.

## Troubleshooting and acceptance

| Symptom                             | Check                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Administration disabled             | OAuth/key settings, valid policy or server/role pair, callback origin/path, and migrations          |
| Discord rejects the callback        | The exact registered redirect matches `DISCORD_REDIRECT_URI` and the origin used in the browser/CLI |
| Access denied                       | The account matches a policy grant, or the exact server/role IDs configured for one admin role      |
| Sign-in expired or already used     | Start sign-in again; callbacks and CLI grants are single use                                        |
| Discord unavailable or rate limited | Keep the form, wait for the stated delay, then retry; the failed request did not save changes       |
| CLI cannot authenticate             | Select the intended origin and run `login` again                                                    |

Automated checks use mocked Discord responses and local D1. Before relying on a
hosted installation, verify with real accounts: authorized browser and CLI
login, denied consent, a nonmember, a member without the role, and removal of
the role while both clients are signed in. Allow the two-minute permission
window to expire, then confirm that reads and saves are refused. Verify that
logout invalidates its session immediately and a new login restores access only
after membership and role are granted. These checks require your own Discord
application and Cloudflare deployment.

## Related guides

- [Manage feeds and sign in with the CLI](USAGE.md#sign-in).
- [Change the installation name and colour](OPERATIONS.md#installation-name-and-colour).
- [Preview locally](DEVELOPMENT.md#run-locally).
- [Authentication design](DEVELOPMENT.md#authentication-design).

[Documentation index](README.md) ·
[Feed and channel permissions](PERMISSIONS.md)
