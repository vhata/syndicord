# Advanced provider operations

Use [setup](SETUP.md) for the normal dashboard and CLI instructions. Routine
feed and webhook edits use the [web interface](WEB.md) or
[syndicord CLI](OPERATIONS.md).

Use this optional reference for account-token policies and provider API tasks.
Normal setup uses [dashboard steps and native CLI commands](SETUP.md). The API
recipes below use Bash, `curl`, and `jq`; they operate on your selected hosted
installation.

- [Create a deployment token with the CLI](#create-a-deployment-token-with-the-cli)
- [Find the Worker address](#find-the-worker-address)
- [Pause and restore cron triggers](#pause-and-restore-cron-triggers)
- [Create a Discord webhook](#create-a-discord-webhook)

## Create a deployment token with the CLI

First
[select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation).
Your membership needs **API Token Provisioning** (or Super Administrator), with
the product permissions you want to grant. This creates an account-owned token
for [GitHub deployment](DEPLOYMENT.md).

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
[storing the token in GitHub](DEPLOYMENT.md#store-the-token-in-github).
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

With `CLOUDFLARE_ACCOUNT_ID` and `SYNDICORD_WORKER_NAME` set for the
installation:

```sh
cf_api workers/subdomain |
  jq -er --arg worker "$SYNDICORD_WORKER_NAME" \
    'if .success then "https://\($worker).\(.result.subdomain).workers.dev/admin" else error("Subdomain lookup failed") end'
```

This needs Workers Scripts Read or Write permission and prints the default
address. Alternatively, the Worker's Cloudflare overview shows its configured
addresses.
[Subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)

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
Write permission. The dashboard alternative is the Worker's **Settings →
Triggers → Cron Triggers**.
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
`updates` key in a new `.webhooks.json`, using the single-role mapping format.
It refuses to overwrite an existing file. Bot tokens are entered without echo;
the credential response is kept in a private temporary file and deleted
afterwards:

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

- **Single-role:**
  [Configure the destination](OPERATIONS.md#add-or-change-webhooks) with
  `npm run syndicord -- webhooks set --file .webhooks.json`, or enter the URL in
  the web interface.
- **Scoped:** Copy the URL from the file's `updates` value and
  [register a destination](OPERATIONS.md#2-register-a-destination) in the web
  interface or with `destinations register`. That command takes a label and
  `webhookUrl`; scoped installations reject the single-role mapping and
  `webhooks set` command.

Delete the temporary `.webhooks.json` afterwards.
[Discord webhook API](https://docs.discord.com/developers/resources/webhook#create-webhook)
