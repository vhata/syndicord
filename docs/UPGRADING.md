# Move an installation with bundled feeds

For an installation whose Worker still bundles `feeds.json`, copy its active
feed configuration into D1 before deploying code that reads configuration there.
Use the feed list from the version actually deployed, including the same URL and
destination names. Historical ledger rows can include removed routes and cannot
reconstruct that configuration.

Install the new [CLI package](SETUP.md#install-the-cli), select the existing
installation, and apply its additive migrations:

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
syndicord migrate
```

Save the deployed feed list as `.feeds.json`, then upload it and update the Worker:

```sh
syndicord feeds set --file .feeds.json
syndicord feeds get
syndicord deploy
```

Keep the existing database and `WEBHOOKS` secret. Importing the same routes does
not reset baselines, pending deliveries, sent identities, or health history.
The older Worker continues using its bundled list until the new code is deployed.
Deployment refuses to upload if the D1 configuration is missing; migrations never
silently replace it with an empty list. Use `[]` only when you intend to pause.

After a scheduled poll, run `syndicord status` and verify delivery as described in
[setup](SETUP.md#verify-delivery). Delete the temporary file. Future feed changes
use [the CLI](OPERATIONS.md), independently of code deployments.
