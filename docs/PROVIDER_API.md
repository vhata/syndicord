# Advanced provider operations

**For the installation owner. Optional.** These recipes cover account-token
policies and provider API tasks that the dashboard and syndicord CLI do not
cover, or that are easier to script than to click. Normal setup is in
[Set up an installation](SETUP.md); routine feed and webhook edits are in
[Manage feeds and channels](FEEDS.md). The recipes use Bash, `curl`, and `jq`,
and operate on your selected hosted installation.

- [Create a deployment token with the CLI](#create-a-deployment-token-with-the-cli)
- [Find the Worker address](#find-the-worker-address)
- [Pause and restore cron triggers](#pause-and-restore-cron-triggers)
- [Create a Discord webhook](#create-a-discord-webhook)

## Create a deployment token with the CLI

First
[select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation).
Your membership needs **API Token Provisioning** (or Super Administrator), with
the product permissions you want to grant. This creates an account-owned token
for [GitHub deployment](GITHUB_DEPLOYMENT.md).

The pinned CLI's OAuth scopes support **Workers Scripts Write**. Use the
dashboard for the narrower **Workers Editor** permission.
[Workers permission reference](https://developers.cloudflare.com/workers/authorization/workers/)

Check the saved login before creating the token:

```sh
npm run syndicord -- cf auth scopes --filter account_api_tokens
npm run syndicord -- cf auth scopes --filter workers-scripts.write
npm run syndicord -- cf auth scopes --filter d1.write
```

These must show `account_api_tokens:create`, `workers-scripts.write`, and
`d1.write`. If a grant is missing, run
`npm run syndicord -- cf auth login --force`. On the browser authorization page,
open **Additional access → Sensitive scopes** and enable **Account API Token
Provisioning**. **API Tokens Write** manages user-owned tokens and can remain
off; it is not needed to create this account-owned token. Keep Workers and D1
access enabled, complete authorization, then check the scopes again.

This login consent is required even for a Super Administrator. It is an
interactive OAuth consent step; the CLI cannot approve sensitive scopes for you.

Create `ci-token-policy.json` with the permission IDs for **Workers Scripts
Write** and **D1 Write** below. Replace only `ACCOUNT_ID` with your Cloudflare
account ID:

```json
[
  {
    "effect": "allow",
    "permission_groups": [
      { "id": "e086da7e2179491d91ee5f35b3ca210a" },
      { "id": "09b2857d1c31407795e75e3fed8617a1" }
    ],
    "resources": {
      "com.cloudflare.api.account.ACCOUNT_ID": "*"
    }
  }
]
```

Both permissions apply across the selected account. The policy grants no zone
access.

Create the token:

```sh
npm run syndicord -- cf accounts tokens create --name syndicord-github --policies @ci-token-policy.json
```

In the JSON printed by `cf`, copy the complete `value` string (beginning with
`cfat_`), without the surrounding quotes.

Continue with
[storing the token in GitHub](GITHUB_DEPLOYMENT.md#store-the-token-in-github).
[Account token requirements](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

## Cloudflare API access

Use an existing account API token with the permissions required by the
operation. The saved `cf auth login` session does not populate
`CLOUDFLARE_API_TOKEN`.
[Token creation](#create-a-deployment-token-with-the-cli) has a CLI option.

Enter the token at a hidden prompt and define this helper in your current Bash
session. The token travels through stdin, not curl's command arguments:

```bash
IFS= read -r -s -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
printf '\n'
cf_api() {
  local endpoint="$1"
  shift
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl --disable --config - --fail --silent --show-error --max-time 30 \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/$endpoint" "$@"
}
```

Use `unset CLOUDFLARE_API_TOKEN; unset -f cf_api` when finished. These commands
make no automatic retries; inspect the current state after an ambiguous write.

## Find the Worker address

First
[select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation).
The pinned CLI can retrieve a Worker by name. If you have `jq`, extract its
address with:

```sh
npm run syndicord -- cf workers get "$SYNDICORD_WORKER_NAME" -q |
  jq -r '.subdomain.url'
```

Without `jq`, omit the pipe and read `subdomain.url` in the JSON output. `-q`
keeps CLI metadata out of the JSON. This lookup uses your existing Cloudflare
login; it does not need the API-token helper above.

This is the default `workers.dev` address without `/admin`. Use it when
`subdomain.enabled` is `true`; Cloudflare may return a URL even when that route
is disabled. If you use a custom domain, open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
in the Cloudflare dashboard, select your Worker, then open **Domains** and copy
that HTTPS address instead. See the
[Worker response fields](https://developers.cloudflare.com/api/resources/workers/).

Continue with
[Discord sign-in and access](DISCORD_SIGN_IN.md#find-and-keep-your-worker-address)
to make the callback and web-editor links from this address.

## Pause and restore cron triggers

For [database recovery](RECOVERY.md#restore-d1), prevent concurrent deployments
first. Save the existing schedules, then remove all schedules from this Worker:

```bash
(
  set -euo pipefail
  umask 077
  test ! -e cron-backup.json
  cron_backup="$(cf_api "workers/scripts/$SYNDICORD_WORKER_NAME/schedules" |
    jq -e 'if .success then [.result.schedules[] | {cron}] else error("Schedule lookup failed") end')"
  set -C
  printf '%s\n' "$cron_backup" > cron-backup.json
)
```

The snippet refuses to replace an existing backup. Check that `cron-backup.json`
contains the schedules you expect before disabling them. The next command
changes the hosted Worker:

```sh
cf_api "workers/scripts/$SYNDICORD_WORKER_NAME/schedules" \
  --request PUT --header 'Content-Type: application/json' --data '[]'
```

Verify the response reports success and a subsequent read shows no schedules.
Cloudflare says schedule changes can take up to 15 minutes to propagate; allow
that time and any running invocation to finish before restoring D1. Keep
concurrent deployments disabled throughout recovery because deployment applies
the schedule in source configuration.

After inspecting the restored data, restore the saved schedules:

```sh
cf_api "workers/scripts/$SYNDICORD_WORKER_NAME/schedules" \
  --request PUT --header 'Content-Type: application/json' \
  --data-binary @cron-backup.json
```

Read back the schedules before resuming deployment. This needs Workers Scripts
Write permission. For the dashboard alternative, open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
select your Worker, then open **Settings → Triggers → Cron Triggers**.
[Schedules API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/)
·
[Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Create a Discord webhook

If you already have a Discord bot installed in the destination server with
**Manage Webhooks** permission in the channel, you can create a webhook from the
terminal. An existing webhook URL alone cannot create another webhook.
Otherwise, use Discord's **Edit Channel → Integrations → Webhooks** page; the
API alternative requires the bot credentials.

The following Bash snippet creates one webhook and saves its URL under the
`updates` key in a new `.webhooks.json`. This mapping format is used when one
admin role can edit every feed and destination. The snippet refuses to overwrite
an existing file. Bot tokens are entered without echo; the credential response
is kept in a private temporary file and deleted afterwards:

```bash
(
  set -euo pipefail
  set +x
  umask 077
  test ! -e .webhooks.json
  read -r -p 'Discord channel ID: ' discord_channel
  [[ "$discord_channel" =~ ^[0-9]+$ ]]
  IFS= read -r -s -p 'Discord bot token: ' discord_token
  printf '\n'
  discord_response="$(mktemp)"
  trap 'rm -f "$discord_response"' EXIT
  printf 'header = "Authorization: Bot %s"\n' "$discord_token" |
    curl --disable --config - --fail --silent --show-error --max-time 30 \
      --request POST --header 'Content-Type: application/json' \
      --data '{"name":"syndicord"}' --output "$discord_response" \
      "https://discord.com/api/v10/channels/$discord_channel/webhooks"
  discord_mapping="$(jq -e 'if .id and .token then {updates: ("https://discord.com/api/webhooks/" + .id + "/" + .token)} else error("Webhook response missing credentials") end' \
    "$discord_response")"
  set -C
  printf '%s\n' "$discord_mapping" > .webhooks.json
)
```

This creates a webhook but sends no Discord message. If creation has an
uncertain outcome, inspect the channel's webhooks before repeating it. Save the
URL in your password manager, then choose your installation's access model:

- **One admin role** (members can edit every feed and destination):
  [Configure the destination](FEEDS.md#add-or-change-webhooks) with
  `npm run syndicord -- webhooks set --file .webhooks.json`, or enter the URL in
  the web interface.
- **Separate feed and channel permissions** (roles manage the shared feed
  catalog, specified channels, or both): Copy the URL from the file's `updates`
  value and [register a destination](FEEDS.md#2-register-a-destination) in the
  web interface or with `destinations register`. That command takes a label and
  `webhookUrl`; this access model rejects the whole-configuration mapping and
  `webhooks set` command.

Delete the temporary `.webhooks.json` afterwards.
[Discord webhook API](https://docs.discord.com/developers/resources/webhook#create-webhook)
