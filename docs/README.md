# Documentation

syndicord sends new RSS and Atom entries to Discord channels. If you only read
those messages, there is nothing to install. To change what gets posted, ask the
person who hosts syndicord for a link to the web editor and which Discord role
you need.

## Choose your starting point

| Your job                       | Start here                                           | You need                                                                 |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Manage feeds and channels      | [Using syndicord](USAGE.md)                          | A link to the web editor and an authorized Discord account               |
| Host an installation           | [First deployment](SETUP.md)                         | Cloudflare access, a Discord application, and a place to run the CLI     |
| Grant or remove editing access | [Sign-in and access](WEB.md#grant-and-revoke-access) | Discord server administration; Cloudflare access to change the policy    |
| Develop or contribute          | [Developer quick start](DEVELOPMENT.md)              | Git, the pinned Node.js version, and npm; no cloud credentials for tests |

A feed administrator adds shared sources; a channel administrator chooses what
reaches their channels. The **installation owner** is the person who hosts
syndicord, manages its Cloudflare resources, and sets up access. A feed or
channel administrator does not need Cloudflare access. A small installation can
give one Discord role all editing permissions, or assign roles
[separate feed and channel permissions](PERMISSIONS.md#access-models): managing
the shared list of feeds, specified channels, or both.

## Run an installation

Follow [setup](SETUP.md) once, then use [the everyday guide](USAGE.md) to manage
content. [Running an installation](OPERATIONS.md) covers selecting its
Cloudflare resources and finding maintenance tasks. These references cover the
other common jobs:

| Task                                                            | Guide                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Configure Discord login or maintain editing access              | [Sign-in and access](WEB.md)                                          |
| Change the editor’s name or colour                              | [Installation appearance](OPERATIONS.md#installation-name-and-colour) |
| Delegate feeds and particular channels across servers           | [Permission policy](PERMISSIONS.md)                                   |
| Inspect health and pending deliveries                           | [Operational status](STATUS.md)                                       |
| Diagnose failures, pause delivery, roll back, or restore D1     | [Troubleshooting and recovery](RECOVERY.md)                           |
| Deploy automatically from your GitHub repository                | [Automatic deployment](DEPLOYMENT.md)                                 |
| Understand baselines, retries, message formatting, and capacity | [Relay behavior](BEHAVIOR.md)                                         |

## Go deeper

| Reference                                                               | What it contains                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Development](DEVELOPMENT.md)                                           | Local setup, contribution steps, and source layout                                     |
| [Website](WEBSITE.md)                                                   | Preview, content and theme changes, and GitHub Pages publication                       |
| [Quality and validation](QUALITY.md)                                    | Checks, hooks, package verification, and evidence limits                               |
| [Provider API recipes](API.md)                                          | Optional advanced automation when dashboard or direct CLI commands do not cover a task |
| [Docket contract](../docket/CONTRACT.md)                                | Branch, worktree, review, and landing rules                                            |
| [Work queue](../TODO.md)                                                | Deferred work and ideas                                                                |
| [Review index](../review/README.md) and [backlog](../review/BACKLOG.md) | Dated review evidence and follow-up work                                               |
| [Permission design](specs/2026-11-22-discord-permissions.md)            | Design rationale and original acceptance requirements                                  |
| [Artwork](../assets/README.md)                                          | Branding assets and their use                                                          |

The guides describe the current software. Design documents and review snapshots
record decisions and evidence at their stated revisions.
