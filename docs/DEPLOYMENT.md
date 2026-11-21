# Automatic deployment

The repository includes the CI workflow in `.github/workflows/check.yml`. It
checks pull requests and pushes to `main`. For pushes to `main`, it also applies
D1 migrations and deploys using the GitHub `production` environment.

GitHub deploys code; the service reads its live configuration from Cloudflare.
Complete [the first deployment](SETUP.md), then configure that environment using
the steps below.

Install the GitHub CLI (`gh`) using its
[official installation instructions](https://github.com/cli/cli#installation)
before following this guide.

Run commands from your checkout with `CLOUDFLARE_ACCOUNT_ID`,
`SYNDICORD_DATABASE_ID`, and `SYNDICORD_WORKER_NAME` exported from setup. The
[npm-installed CLI](SETUP.md#optional-npm-installation) uses the same commands
with `npx --no-install syndicord` in place of `npm run syndicord --`.

## Create the GitHub environment

Sign in with repository administration access. Set `GH_REPO` to the GitHub
repository for your installation, such as your fork, so every `gh` command
targets it explicitly. Then create `production` and allow deployments from the
`main` branch:

```sh
gh auth login
export GH_REPO='YOUR_OWNER/YOUR_REPOSITORY'
gh api --method PUT 'repos/{owner}/{repo}/environments/production' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api --method POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
  -f name=main -f type=branch
gh variable set CLOUDFLARE_ACCOUNT_ID --env production --body "$CLOUDFLARE_ACCOUNT_ID"
gh variable set SYNDICORD_DATABASE_ID --env production --body "$SYNDICORD_DATABASE_ID"
gh variable set SYNDICORD_WORKER_NAME --env production --body "$SYNDICORD_WORKER_NAME"
```

`{owner}` and `{repo}` are filled in from `GH_REPO`. For an existing
environment, inspect its settings instead of recreating the branch rule:

```sh
gh api 'repos/{owner}/{repo}/environments/production'
gh api 'repos/{owner}/{repo}/environments/production/deployment-branch-policies'
```

It should allow only `main`. Required reviewers pause deployments; leave that
rule unset for automatic deployment. Environment support depends on your GitHub
plan for private repositories.
[GitHub environment reference](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Create the Cloudflare token

Your account membership needs **API Token Provisioning** (or Super
Administrator), with the product permissions you want to grant.
[Account token requirements](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

Choose one path:

| Creation method                            | Worker permission         | Scope of Worker access                                          |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------- |
| [Dashboard](#create-through-the-dashboard) | **Workers Editor**        | Update and deploy existing Workers.                             |
| [CLI](#create-through-the-cli)             | **Workers Scripts Write** | Manage Worker scripts, including creating and deleting Workers. |

### Create through the dashboard

Open **Manage account → Account API tokens → Create Token**, select Workers
**Editor** and D1 **Edit**, and limit the token to the deployment account.
Create the token, copy its complete value, then continue to
[store the token in GitHub](#store-the-token-in-github).

### Create through the CLI

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

## Store the token in GitHub

Whichever creation method you chose, save the token as the GitHub environment
secret:

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production
```

Paste the complete token into the hidden prompt and press Enter. Cloudflare
shows the token only at creation; keep the same complete string in the shared
password manager.

## Run and inspect deployment

CI builds GitHub's `main` and targets the account, Worker, and database selected
by the environment. Feed and webhook changes use [the CLI](OPERATIONS.md) or
[web interface](WEB.md) and do not require GitHub changes.

Enable the workflow and start a run to verify the setup:

```sh
gh workflow enable check.yml
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --event workflow_dispatch --limit 5
```

Find the run you just started in the list. Replace `RUN_ID` with its numeric ID:

```sh
gh run watch RUN_ID --exit-status
gh run view RUN_ID --log
```

The second command prints the logs. Confirm that **Check** and **Deploy
production** succeed and the deployment log identifies the expected commit and
Worker version. For the browser summary, use `gh run view RUN_ID --web`; its
**Deployed commit** and **Worker version** fields show the same values. If it
says **Skipped** because `main` has advanced, inspect the newer run instead.

Subsequent pushes to `main` run the same checks, migrations, and deployment
automatically; use the command above whenever you need another manual run. For a
failed run:

```sh
gh run view RUN_ID --log-failed
```

Missing credentials or IDs stop deployment with setup guidance. GitHub stores
the deployment token; Cloudflare keeps Discord OAuth settings and the encryption
key. Configuration remains in D1. No local secrets file is used by CI.
[Change feeds or webhooks](OPERATIONS.md) independently of these credentials.

## Deployment and migration behavior

Only the checked commit on `main` can deploy. The job builds for the configured
database, validates the build, then applies outstanding migrations and verifies
that none remain before upload. A fresh installation starts with no feeds;
configuration can be added after deployment. Only that final step receives
Cloudflare credentials. It preserves hosted secrets, provisions no missing
database, and checks the active Worker's commit annotation after upload.
Verification retries reads briefly to allow for stale Cloudflare metadata;
[recovery](RECOVERY.md#failed-deployment) describes the retry limit and how to
inspect a failure.

Migration and deployment are serialized. A newer push does not cancel work
already running; stale pending revisions are skipped. A push during an upload is
handled by the next deployment.

Add new numbered SQL migrations; never edit ones already applied. Test them
against both a fresh and an existing schema. They must be additive and
compatible with the running Worker, which keeps polling until deployment
completes. Migration failure stops upload. An upload failure leaves completed
migrations in place; the next attempt applies only outstanding ones. CI never
rolls back the database automatically. See [recovery](RECOVERY.md) for failed
deployments.
