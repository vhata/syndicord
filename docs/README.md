# Documentation

syndicord sends new RSS and Atom entries to Discord channels. If you only read
those messages, there is nothing to install. Start with the row that matches
what you do:

| You want to                                    | Start with                               | You need                                                                         |
| ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Add feeds or choose what reaches your channels | [Manage feeds and channels](FEEDS.md)    | The web-editor link from your host and an authorized Discord account             |
| Host syndicord for a community                 | [Set up an installation](SETUP.md)       | A Cloudflare account, Discord server administration, Git, Node.js 26, and npm 11 |
| Work on syndicord itself                       | [Develop and contribute](DEVELOPMENT.md) | Git, the pinned Node.js version, and npm; no cloud credentials for tests         |

The guides refer to three kinds of user. A **feed administrator** adds shared
sources. A **channel administrator** chooses what reaches their channels. The
**installation owner** hosts syndicord, manages its Cloudflare resources, and
decides which Discord roles get which permissions. Feed and channel
administrators never need Cloudflare access, and a small installation can give
one Discord role every editing permission. See
[access models](PERMISSIONS.md#access-models).

## Manage feeds and channels

| Task                                                    | Guide                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sign in with the web editor or CLI                      | [Sign in](FEEDS.md#sign-in)                                                                 |
| Find out which editing mode your installation uses      | [Choose the section matching your editor](FEEDS.md#choose-the-section-matching-your-editor) |
| Add a feed, register a channel, and subscribe it        | [Separate feed and channel permissions](FEEDS.md#separate-feed-and-channel-permissions)     |
| Add feeds and webhooks when one role manages everything | [One admin role](FEEDS.md#one-admin-role)                                                   |
| Rename, rotate, unsubscribe, or delete                  | [Change or remove something](FEEDS.md#change-or-remove-something)                           |
| Understand why a new feed posts nothing at first        | [Baselines and entry identity](DELIVERY.md#baselines-and-entry-identity)                    |

## Host an installation

For a new installation, follow [Set up an installation](SETUP.md) from start to
finish. It sends you to the sign-in and permissions guides at the right points
and brings you back to verify delivery.

| Task                                             | Guide                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Deploy a new installation                        | [Set up an installation](SETUP.md)                                     |
| Connect Discord sign-in and choose who can edit  | [Discord sign-in and access](DISCORD_SIGN_IN.md#enable-administration) |
| Give roles separate feed and channel permissions | [Feed and channel permissions](PERMISSIONS.md#configure-access)        |
| Deploy automatically from your GitHub repository | [Automatic deployment from GitHub](GITHUB_DEPLOYMENT.md)               |

## Operate an installation

| Task                                                        | Guide                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Point a terminal at the right Cloudflare installation       | [Select a Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation) |
| Update the deployed code                                    | [Update the installation](SETUP.md#update-the-installation)                        |
| Grant or revoke someone's editing access                    | [Grant and revoke access](DISCORD_SIGN_IN.md#grant-and-revoke-access)              |
| Change the editor's name or colour                          | [Installation name and colour](OPERATIONS.md#installation-name-and-colour)         |
| Check health and pending deliveries                         | [Operational status](STATUS.md)                                                    |
| Find out why messages stopped or a destination is suspended | [Troubleshooting and recovery](RECOVERY.md)                                        |
| Pause delivery or roll back the code                        | [Pause and roll back](RECOVERY.md#pause-and-roll-back)                             |
| Restore the database                                        | [Restore D1](RECOVERY.md#restore-d1)                                               |
| Script provider tasks                                       | [Advanced provider operations](PROVIDER_API.md)                                    |

## Reference

[How delivery works](DELIVERY.md) describes message formatting, baselines,
retries, polling limits, and storage growth. It applies to every installation.

## Contribute

| Reference                                                               | What it contains                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Develop and contribute](DEVELOPMENT.md)                                | Local setup, contribution steps, and source layout               |
| [Quality and tooling reference](QUALITY.md)                             | Checks, hooks, package verification, and evidence limits         |
| [Website](WEBSITE.md)                                                   | Preview, content and theme changes, and GitHub Pages publication |
| [Docket contract](../docket/CONTRACT.md)                                | Branch, worktree, review, and landing rules                      |
| [Work queue](../TODO.md)                                                | Deferred work and ideas                                          |
| [Review index](../review/README.md) and [backlog](../review/BACKLOG.md) | Dated review evidence and follow-up work                         |
| [Permission design](specs/2026-11-22-discord-permissions.md)            | Design rationale and original acceptance requirements            |
| [Artwork](../assets/README.md)                                          | Branding assets and their use                                    |

The guides describe the current software. Design documents and review snapshots
record decisions and evidence at their stated revisions.
