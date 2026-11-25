# Install the CLI

**For anyone who wants to work from a terminal.** Feed and channel
administrators can use the CLI instead of the web editor; the web editor needs
nothing installed. The installation owner needs the CLI to deploy.

You need Git, Node.js 26.12 or newer in the 26.x line, and npm 11. Installing
the CLI does not create Cloudflare resources or change any installation.

## From a checkout

```sh
git clone https://github.com/vhata/syndicord.git
cd syndicord
npm ci
npm run syndicord -- --help
```

These commands build the CLI and Worker locally. The guides' examples use this
checkout form: `npm run syndicord -- COMMAND`. The checkout's `.npmrc`
suppresses npm script banners so command output stays usable as JSON. For local
checks and code contributions, see [Develop and contribute](DEVELOPMENT.md).

## npm installation

To use syndicord from any directory without keeping a source checkout, first
build its installable package:

```sh
npm pack github:vhata/syndicord
```

Install the `.tgz` file named in the output, replacing `FILENAME.tgz` below:

```sh
npm install --global ./FILENAME.tgz
npx syndicord --help
```

Packing builds the CLI and Worker in npm's temporary checkout before the global
install, which avoids npm 11's
[global Git preparation bug](https://github.com/npm/cli/issues/8440). After a
successful installation you can delete the `.tgz` file. The installed CLI
deploys its bundled Worker.

With this installation, substitute these commands wherever the guides show the
checkout form:

| From the checkout                | npm-installed CLI         |
| -------------------------------- | ------------------------- |
| `npm run syndicord -- feeds get` | `npx syndicord feeds get` |
| `npm run deploy`                 | `npx syndicord deploy`    |

Files supplied with `--file` are resolved from your current directory.

## Update the CLI

- **Checkout:** pull the revision you want, then run `npm ci`.
- **npm installation:** repeat the packing and install steps above. To install a
  particular revision, pack `github:vhata/syndicord#COMMIT_OR_TAG`.

Updating the CLI does not change a hosted installation. To deploy the new code,
see [Update the installation](OPERATIONS.md#update-the-installation).

## Next

- To edit feeds from the terminal, continue with
  [Select an installation](FEEDS.md#select-an-installation).
- To host a new installation, return to
  [Set up an installation](SETUP.md#choose-the-cloudflare-account).
