<p align="center">
  <img src="assets/syndicord.svg" width="112" height="112" alt="syndicord — a feed signal inside a message bubble">
</p>

<h1 align="center">syndicord</h1>

<p align="center"><strong>Your feeds. In the conversation.</strong><br>RSS and Atom updates, delivered to Discord.</p>

<p align="center">
  <a href="docs/SETUP.md">Set up syndicord</a> ·
  <a href="docs/BEHAVIOR.md">How delivery works</a> ·
  <a href="docs/DEVELOPMENT.md">Development</a>
</p>

syndicord is an RSS-to-Discord relay that runs on Cloudflare Workers. It polls
feeds on a schedule and posts new entries to Discord through one or more
webhooks.

Each feed is mapped to its destinations: send a feed to a single channel, share
it across several channels, or bring multiple feeds together in one channel.
syndicord tracks delivered entries for each feed and destination to pick up new
posts on the next poll.

Messages carry titles, links, and descriptions from the feeds themselves, so
readers can follow updates in Discord and open the original posts for the full
story.

The first poll records a baseline without posting a backlog. Delivery state is
stored in D1, so destinations can retry independently. Each scheduled run checks
one feed and sends a bounded batch of pending entries.

Use the [password-protected web interface](docs/WEB.md) to add feeds and
webhooks and choose where each feed goes. Feeds and routing live in Cloudflare
D1; web-saved webhook URLs are encrypted with a separate Worker secret. Run the
CLI directly from the repository or install it through npm to manage an
installation without a checkout. The same code can serve separate accounts or
Workers, each with its own database and configuration.

Start with [setup](docs/SETUP.md), then [enable the web interface](docs/WEB.md).
For CLI changes, [add or change feeds](docs/OPERATIONS.md#add-or-change-a-feed)
or
[update webhooks without deploying](docs/OPERATIONS.md#update-webhooks-without-deploying).
See [optional automatic deployment](docs/DEPLOYMENT.md) for GitHub Actions and
[relay behavior](docs/BEHAVIOR.md) for delivery semantics.

Use the [operational status command](docs/STATUS.md) to inspect feed health,
pending deliveries, and suspended destinations.

## Development

See the [development guide](docs/DEVELOPMENT.md) for local setup, project
layout, and checks.

## License

[MIT](LICENSE) © 2026 Jonathan Hitchcock.
