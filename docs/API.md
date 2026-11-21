# Terminal alternatives for provider settings

Routine feed and webhook edits use the [syndicord CLI](OPERATIONS.md). These
optional API commands cover provider settings not exposed by the pinned
Cloudflare CLI, and Discord webhook creation. They use Bash, `curl`, and `jq`.
They operate on your selected hosted installation.

## Cloudflare API access

Use an existing account API token with the permissions required by the
operation. The saved `cf auth login` session does not populate
`CLOUDFLARE_API_TOKEN`. [Token creation](DEPLOYMENT.md#create-through-the-cli)
has a CLI option.

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
`updates` destination in a new `.webhooks.json`. It refuses to overwrite an
existing file. Bot tokens are entered without echo; the credential response is
kept in a private temporary file and deleted afterwards:

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
URL in your password manager, then
[configure the destination](OPERATIONS.md#add-or-change-webhooks) with
`npm run syndicord -- webhooks set --file .webhooks.json`, or enter its URL in
the web interface. Delete the temporary `.webhooks.json` afterwards.
[Discord webhook API](https://docs.discord.com/developers/resources/webhook#create-webhook)
