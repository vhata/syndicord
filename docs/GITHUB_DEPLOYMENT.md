# Automatic deployment from GitHub

**For the installation owner. Optional.** Use this when you want pushes to your
repository's `main` branch to update the running service. Complete
[Set up an installation](SETUP.md) first. Feed and webhook edits use
[Manage feeds and channels](FEEDS.md) and never need a GitHub change.

> **Once configured, pushes to `main` deploy automatically after checks pass.**
> Merging a pull request into `main` therefore updates the running Worker;
> subsequent updates need no separate manual deployment command.

The included **CI** workflow (`.github/workflows/check.yml`) checks pull
requests and deploys checked `main` commits using a GitHub environment named
`production`. These runs consume GitHub Actions and Cloudflare usage under your
plans.

## Create the GitHub environment

Use your own repository, such as a fork, with repository administration access.
Have the account, database, and Worker identifiers from setup ready.

**GitHub Dashboard:** In **your repository → Settings → Environments**, create
`production`. Under **Deployment branches and tags**, choose **Selected branches
and tags** and add a **Branch** rule for `main`. Leave **Required reviewers**
unset if you want automatic deployment. Under **Environment variables**, add:

| Name                    | Value                                 |
| ----------------------- | ------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID            |
| `SYNDICORD_DATABASE_ID` | The existing D1 database UUID         |
| `SYNDICORD_WORKER_NAME` | Your Worker name, such as `syndicord` |

**CLI:** Install [GitHub CLI](https://github.com/cli/cli#installation), then run
these commands with the three installation values exported from setup:

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

`GH_REPO` selects the target for every `gh` command and fills `{owner}` and
`{repo}`. For an existing environment, inspect it instead of recreating its
branch rule:

```sh
gh api 'repos/{owner}/{repo}/environments/production'
gh api 'repos/{owner}/{repo}/environments/production/deployment-branch-policies'
```

Allow only `main`. Private-repository environment support depends on your
[GitHub plan](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Create the Cloudflare token

Your Cloudflare membership needs **API Token Provisioning** (or Super
Administrator), plus the product permissions you will grant. Choose one path:

### Create through the dashboard

In the **Cloudflare Dashboard**, open
[**Account API tokens**](https://dash.cloudflare.com/?to=/:account/api-tokens)
and choose **Create Token**. Select Workers **Editor** and D1 **Edit**, and
limit the token to the deployment account. Create it and copy its complete
value.

### Create through the CLI

Follow the
[account-token CLI recipe](PROVIDER_API.md#create-a-deployment-token-with-the-cli).
It uses native `cf` commands and a JSON policy file. The pinned CLI grants
**Workers Scripts Write** (including creation/deletion); use the dashboard for
**Workers Editor**, which updates and deploys existing Workers.

[Account token requirements](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
·
[Worker permissions](https://developers.cloudflare.com/workers/authorization/workers/)

## Store the token in GitHub

- **GitHub Dashboard:** In your repository, under **Settings → Environments →
  production → Environment secrets → Add secret**, name it
  `CLOUDFLARE_API_TOKEN` and paste its value.
- **CLI:** With `GH_REPO` set to your repository, use the hidden value prompt:

  ```sh
  gh secret set CLOUDFLARE_API_TOKEN --env production
  ```

Cloudflare displays the complete token only at creation. Keep that same string
in your password manager. GitHub needs the deployment token; Discord OAuth
settings and the encryption key stay in Cloudflare, with configuration in D1. CI
uses no local secrets file.

## Run and inspect deployment

**GitHub Dashboard:** Open **Actions → CI** in your repository. Enable workflows
if prompted, choose **Run workflow**, select `main`, and run it. Open that run
to see its job logs and summary.

**CLI:** With `GH_REPO` set to your repository:

```sh
gh workflow enable check.yml
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --event workflow_dispatch --limit 5
```

Use the new run's numeric ID:

```sh
gh run watch RUN_ID --exit-status
gh run view RUN_ID --web
```

Confirm **Check**, **Queue and PR hygiene**, and **Deploy production** succeed.
The summary's **Deployed commit** and **Worker version** should identify the
expected deployment. If the summary says **Skipped** because `main` advanced,
inspect the newer run.

For terminal logs, use `gh run view RUN_ID --log`, or `--log-failed` for a
failed run. Missing credentials or identifiers stop deployment with setup
guidance. Use [recovery](RECOVERY.md#failed-deployment) for failed or ambiguous
uploads.
[GitHub workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

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
deployments. To deploy by hand instead, see
[Update the installation](OPERATIONS.md#update-the-installation).
