<p align="center">
  <img src="assets/syndicord.svg" width="112" height="112" alt="syndicord — a feed signal inside a message bubble">
</p>

<h1 align="center">syndicord</h1>

<p align="center"><strong>Your feeds. In the conversation.</strong><br>RSS and Atom updates, delivered to Discord.</p>

<p align="center">
  <a href="docs/USAGE.md">Use syndicord</a> ·
  <a href="docs/SETUP.md">Host an installation</a> ·
  <a href="docs/DEVELOPMENT.md">Development</a>
</p>

syndicord brings RSS and Atom updates into Discord. It runs on Cloudflare
Workers, checks feeds on a schedule, and posts new entries to the channels you
choose. Messages include the feed name, title, link, and a short excerpt.

- **No bot to invite or authorize.** Create a webhook for each destination
  channel. syndicord uses those webhooks to post feed updates, with no bot
  installation on your server.
- **Discord roles control access.** Editors sign in with Discord. The host
  selects the roles that can edit; grant or revoke access through those roles.
  No separate accounts or per-person permission lists. See
  [sign-in and access](docs/WEB.md).
- **Use the web editor or CLI.** Readers just follow the Discord channel, with
  no extra account or software. Editors manage feeds and channels from either
  client; changes need no code deployment.

## Start here

| I want to…                                      | Read                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Add feeds or choose which channels receive them | [Manage feeds and channels](docs/USAGE.md)                                              |
| Host syndicord for my community                 | [First deployment](docs/SETUP.md)                                                       |
| Give people access to manage it                 | [Sign-in and access](docs/WEB.md) · [Feed and channel permissions](docs/PERMISSIONS.md) |
| Check why updates have stopped                  | [Status](docs/STATUS.md) · [Troubleshooting](docs/RECOVERY.md)                          |
| Work on the code                                | [Development](docs/DEVELOPMENT.md)                                                      |

## How it fits together

A **feed** is an RSS or Atom source. A **destination** is a Discord webhook that
posts to a channel. A **route** (or **subscription**) connects the two: one feed
can reach several channels, and one channel can receive several feeds.

Each installation has a Cloudflare Worker and a D1 database. D1 holds
configuration and delivery history; webhook URLs are encrypted with a separate
Worker secret. Discord roles control who can edit feeds and destinations.
Hosting access is separate from editing access.

The first successful check of a new route quietly records existing entries; **it
does not post the old backlog**. Subsequent checks send new entries. By default,
one feed is checked each minute and destinations retry independently. See
[delivery behavior](docs/BEHAVIOR.md) for timing, limits, and retry details.

See the [documentation index](docs/README.md) for hosting references, optional
GitHub deployment, architecture, and contribution guidance.

## License

[MIT](LICENSE) © 2026 Jonathan Hitchcock.
