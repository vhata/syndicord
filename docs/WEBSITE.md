# Website

The product website is built from this repository's README, documentation, and
artwork. Edit those files once to update the content available locally, on
GitHub, and on the next website build. The website is static and needs no
Cloudflare or Discord credentials.

## Preview locally

After [setting up the checkout](DEVELOPMENT.md#check-the-project), run:

```sh
npm run site:dev
```

Open the local URL printed by VitePress. Changes to the Markdown and theme
appear in the preview. To inspect the production build instead:

```sh
npm run site:check
npm run site:preview
```

`site:check` builds the site and checks generated page links, anchors, and
assets. `site:build` builds without the additional output check. Generated HTML
and search data live in ignored `.vitepress/dist/`; do not commit them.

## Edit content and appearance

- Edit `README.md` for the homepage and `docs/*.md` for the guides. Keep them
  readable as ordinary Markdown on GitHub, including relative file links.
- Reuse the artwork in `assets/`. See [artwork](../assets/README.md) for its
  source files and colours.
- Change the published page list, navigation, and site settings in
  `.vitepress/config.mjs`. The theme lives under `.vitepress/theme/`.

The build converts links between published Markdown pages into website links.
Links to repository files that are not published pages lead to GitHub. Review
records, work queues, and design specs remain repository references. There is no
separate copy of the documentation to synchronize.

Before opening a PR, run the [complete project checks](QUALITY.md#gates).
`scripts/check.sh` checks the website at both `/` and `/syndicord/`, covering
domain-root and GitHub project-site paths. The **Website** workflow also builds
and checks the configured publication path on pull requests and pushes to
`main`.

## Publish with GitHub Pages

Publishing is opt-in. The **Website** workflow builds and uploads its checked
site artifact even while publishing is disabled. Only a push or manual run on
`main` can publish, and only when the repository variable `PAGES_ENABLED` is
`true`. It publishes the static website; it does not deploy a syndicord Worker.

After merging the website workflow, a repository administrator can enable it:

1. Open **Settings → Pages → Build and deployment** and choose **GitHub
   Actions** as the source.
2. Open **Settings → Secrets and variables → Actions → Variables**. Create a
   repository variable named `PAGES_ENABLED` with value `true`.
3. Open **Actions → Website → Run workflow**, select `main`, and run it. After
   **Publish website** succeeds, follow its deployment URL or the URL under
   **Settings → Pages**.

GitHub CLI can set the variable and start the same workflow after selecting the
Pages source in the dashboard:

```sh
gh variable set PAGES_ENABLED --body true
gh workflow run pages.yml --ref main
```

Run those commands from the intended repository checkout. Future pushes to
`main` publish the updated content automatically. The workflow uses GitHub's own
token; it needs no personal access token or Cloudflare secret. See
[GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
for hosting availability and environment protection.

### Custom domains and paths

The workflow defaults to `https://OWNER.github.io/REPOSITORY/`. For syndicord
this is `https://vhata.github.io/syndicord/`. Local commands default to `/`.

To use an existing custom domain, configure it in **Settings → Pages → Custom
domain**, follow GitHub's DNS instructions, and enable **Enforce HTTPS** when
available. Then set these repository variables in the same **Actions →
Variables** screen:

| Variable         | Example                    | Meaning                                |
| ---------------- | -------------------------- | -------------------------------------- |
| `SITE_BASE_PATH` | `/`                        | Site path, with leading/trailing slash |
| `SITE_URL`       | `https://docs.example.org` | Public origin for page metadata        |

The equivalent variable commands are:

```sh
gh variable set SITE_BASE_PATH --body /
gh variable set SITE_URL --body https://docs.example.org
gh workflow run pages.yml --ref main
```

Use `/` for an owner site named `OWNER.github.io` as well. For another subpath,
set that path with leading and trailing slashes. Match a hosted path locally by
passing it to both build and preview:

```sh
SITE_BASE_PATH=/syndicord/ npm run site:check
SITE_BASE_PATH=/syndicord/ npm run site:preview
```

See
[GitHub's custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
for DNS and domain verification.

### Stop publishing

Set `PAGES_ENABLED` to `false` in repository variables, or run:

```sh
gh variable set PAGES_ENABLED --body false
```

This stops future deployments. To take the existing site offline too, use
**Settings → Pages → Unpublish site** and cancel any deployment already running
under **Actions → Website**.
