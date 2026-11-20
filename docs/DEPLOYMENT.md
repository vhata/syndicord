# Automatic deployment

Complete [the first deployment](SETUP.md) first. These steps connect the working
installation to GitHub Actions; afterwards, pushes to `main` check the code,
apply D1 migrations, and deploy. Pull requests only run checks.

Install the GitHub CLI (`gh`) using its
[official installation instructions](https://github.com/cli/cli#installation)
before following this guide.

Run commands from your repository with `CLOUDFLARE_ACCOUNT_ID` and
`SYNDICORD_DATABASE_ID` exported from setup.

## Create the GitHub environment

Sign in with repository administration access. Create `production` and allow
deployments from the `main` branch:

```sh
gh auth login
gh api --method PUT 'repos/{owner}/{repo}/environments/production' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api --method POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
  -f name=main -f type=branch
gh variable set CLOUDFLARE_ACCOUNT_ID --env production --body "$CLOUDFLARE_ACCOUNT_ID"
gh variable set SYNDICORD_DATABASE_ID --env production --body "$SYNDICORD_DATABASE_ID"
```

`{owner}` and `{repo}` are filled in by `gh`. For an existing environment, check
its settings instead of recreating the branch rule: it should allow only
`main`. Required reviewers pause deployments; leave that rule unset for
automatic deployment. Environment support depends on your GitHub plan for
private repositories. [GitHub environment reference](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Create the Cloudflare token

Your account membership needs **API Token Provisioning** (or Super
Administrator), with the product permissions you want to grant. Choose one path:

| Creation method  | Worker permission         | Scope of Worker access                                          |
| ---------------- | ------------------------- | --------------------------------------------------------------- |
| Dashboard        | **Workers Editor**        | Update and deploy existing Workers.                             |
| CLI recipe below | **Workers Scripts Write** | Manage Worker scripts, including creating and deleting Workers. |

For **Workers Editor**, open **Manage account → Account API tokens → Create
Token**, select Workers **Editor** and D1 **Edit**, and limit the token to the
deployment account. Save it with `gh secret set CLOUDFLARE_API_TOKEN --env production`,
then continue to [run deployment](#run-and-inspect-deployment).

The pinned `cf` 1.0.0-rc.1 can create tokens with **Workers Scripts Write**.
It cannot request `workers-scripts.edit`, the OAuth scope needed to grant
**Workers Editor**. These are different permissions; another login does not
make the Editor policy work with this CLI version.
[Workers permission reference](https://developers.cloudflare.com/workers/authorization/workers/)

### Create through the CLI

Check the saved login before creating the token:

```sh
npx cf auth scopes --filter account_api_tokens
npx cf auth scopes --filter workers-scripts.write
npx cf auth scopes --filter d1.write
```

These must show `account_api_tokens:create`, `workers-scripts.write`, and
`d1.write`. If a grant is missing, run
`npx cf auth login --force`. On the browser authorization page, open
**Additional access → Sensitive scopes** and enable **Account API Token
Provisioning**. **API Tokens Write** manages user-owned tokens and can remain
off; it is not needed to create this account-owned token. Keep Workers and D1
access enabled, complete authorization, then check the scopes again.

This login consent is separate from your account role. An existing login can
deploy Workers yet lack token-creation consent, even for a Super Administrator.

Create `ci-token-policy.json` with the permission IDs for **Workers Scripts Write**
and **D1 Write** below. Replace only `ACCOUNT_ID` with your Cloudflare account ID:

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

This grants Worker script management and D1 migration access across that account;
no zone permissions are needed. The policy uses the supported legacy Workers
permission that matches the CLI's `workers-scripts.write` OAuth grant. To inspect
permission IDs, run `npx cf user tokens permission-groups list`.

Create the token and save it as the GitHub environment secret:

```sh
npx cf accounts tokens create --name syndicord-github --policies @ci-token-policy.json
gh secret set CLOUDFLARE_API_TOKEN --env production
```

In the JSON printed by `cf`, copy the complete `value` string (beginning with
`cfat_`), without the surrounding quotes. Paste it into the hidden `gh` prompt
and press Enter. Cloudflare shows this value only at creation; keep the same
complete string in the shared password manager. The policy file contains IDs
and permissions, not the token. Do not give the deployment token permission to
create more tokens.

If creation still returns 403 with the required scope, check `npx cf auth whoami`:
an API token from `CLOUDFLARE_API_TOKEN` or a dotenv file overrides the OAuth
login. Confirm the selected account has the required role and product access;
an administrator can grant missing permissions. Tokens can also be created at
**Manage account → Account API tokens → Create Token** in the selected account.
[Account token reference](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

Error 1001 naming **Workers Editor** means the policy asks for a permission that
this CLI cannot obtain through OAuth. If the broader CLI permission is acceptable,
replace the Workers Editor ID `d7ba8d4dce414197a3efab21b2f87eb8` in your policy
with the Workers Scripts Write ID `e086da7e2179491d91ee5f35b3ca210a`. Keep the
D1 Write entry `09b2857d1c31407795e75e3fed8617a1` and your account ID unchanged.
Alternatively, create the Editor token through the dashboard. Enabling
**API Tokens Write** does not resolve this mismatch.

## Run and inspect deployment

Once the workflow is on `main`, start it and select its run ID from the list:

```sh
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --event workflow_dispatch --limit 5
gh run watch RUN_ID --exit-status
```

The run summary records the commit and active Worker version. For a failed run:

```sh
gh run view RUN_ID --log-failed
```

Configure the environment before merging changes that use it. Missing
credentials or IDs stop deployment with setup guidance. GitHub stores the
deployment token; Cloudflare keeps `WEBHOOKS`. No local secrets file is used
by CI. [Change feeds or webhooks](OPERATIONS.md) independently of these credentials.

## Deployment and migration behavior

Only the checked commit on `main` can deploy. The job builds for the configured
database, validates the build, then applies outstanding migrations and verifies
that none remain before upload. Only that final step receives Cloudflare
credentials. It preserves hosted secrets, provisions no missing database, and
checks the active Worker's commit annotation after upload.

Migration and deployment are serialized. A newer push does not cancel work
already running; stale pending revisions are skipped. A push during an upload
is handled by the next deployment.

Add new numbered SQL migrations; never edit ones already applied. Test them
against both a fresh and an existing schema. They must be additive and compatible
with the running Worker, which keeps polling until deployment completes.
Migration failure stops upload. An upload failure leaves completed migrations
in place; the next attempt applies only outstanding ones. CI never rolls back
the database automatically. See [recovery](RECOVERY.md) for failed deployments.
