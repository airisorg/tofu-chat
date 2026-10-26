# Tofu Chat

A lightweight team messenger for groups of up to 30 people, with direct messages, spaces, threads and file sharing.

## Deployed on Tofu

[![Deployed on Tofu](docs/media/deployed-on-tofu.svg)](https://trytofu.ai/)
[![Quality](https://github.com/airisorg/tofu-chat/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/airisorg/tofu-chat/actions/workflows/quality.yml)

[Try the live app](https://chat-84bee5accbbd.trytofu.app/) — sign in with Google and start a conversation.

Tofu Chat runs on [Tofu](https://trytofu.ai/), which brings hosting, a managed database and Google sign-in together for apps built with a coding agent. Have an app ready to share? [Take it online with Tofu](https://trytofu.ai/).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/team-chat-desktop-dark.png">
  <img src="docs/media/team-chat-desktop.png" alt="Tofu Chat desktop workspace with team messages, spaces and reactions" width="1280">
</picture>

_Sample conversations from the local demo._

## See it in action

Try a message and a reaction in the landing page's interactive preview, or open the app on your phone.

<p>
  <img src="docs/media/landing-demo.gif" alt="Typing and sending a sample message, then adding a reaction in Tofu Chat's local preview" width="450">
  <img src="docs/media/team-chat-mobile.png" alt="Tofu Chat mobile Home screen showing sample direct messages and spaces" width="260">
</p>

_These captures use synthetic local data. The interactive preview does not send messages to other accounts._

## Start a conversation

Choose **New chat**, add a friend's Google email, and share the conversation's invitation link. They join by signing in with that verified email. Use spaces for a team or topic, and threads to keep replies together.

You can send images, files and voice messages; edit or delete your messages; add reactions; and find conversations through search, mentions and stars. Drafts stay on your device when enabled. Files can be up to 5 MiB each, with three attachments per message; voice recordings can be up to two minutes.

On iPhone, open the app in Safari, tap **Share → Add to Home Screen**, and enable **Open as Web App** if offered. You can also use the app in an ordinary browser.

Tofu Chat is an independent messenger. Google sign-in does not connect it to Google Chat or import existing conversations. Video and voice calls, background push notifications and automatic offline sending are not included.

## Deploy your own with Tofu

Fork the repository, follow [Tofu's agent setup](https://trytofu.ai/agent), and ask your coding agent:

> Deploy this app on Tofu with a database and Google sign-in.

Tofu connects the hosting and services; your agent builds and checks the app. The app has no service address built in: Tofu provides the database and its certificate (`DATABASE_URL`, `SUPABASE_CA_CERT`), the identity service (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and where Google sign-in starts (`TOFU_SIGN_IN_URL`), so the same code runs on whichever backend Tofu connects. This is a server app with a database; see [current plans](https://trytofu.ai/pricing) before deploying.

## Run locally

Use Node.js 22.13 or newer:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000> and choose **Explore demo** to try synthetic conversations without an account. The demo is enabled by default in development; its data stays in that browser. Production disables it unless explicitly enabled for testing.

A connected workspace needs PostgreSQL and Supabase identity settings. Tofu supplies these for the hosted app; [.env.example](.env.example) lists the settings for your own deployment. Self-hosted Google sign-in also needs an authorized Tofu OAuth broker setup; setting `TOFU_SIGN_IN_URL` alone does not configure it, and without it the Google button stays off. Keep populated environment files and credentials out of Git. See [runtime and data handling](docs/runtime.md) for authorization, limits and retry behavior.

## Development

Built with Next.js, React and TypeScript, with PostgreSQL for conversations and Supabase for identity.

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

The test suite includes unit tests, embedded SQL checks, native PostgreSQL and API integration, browser flows, failure injection and screenshot regressions. See [the testing guide](docs/testing.md) for coverage, CI, browser setup and source-bound integration checks. Screenshots detect changes in this app; they do not establish that it matches another product pixel for pixel.

- [Contributing](CONTRIBUTING.md)
- [Database performance and benchmarks](docs/database-performance.md)
- [Feature scope and gaps](docs/feature-gap-analysis.md)
- [Security and private vulnerability reports](SECURITY.md)

## License

The project is available under the [MIT license](LICENSE). Bundled fonts, icons and emoji data retain their own licenses, listed in [third-party notices](THIRD_PARTY_NOTICES.md).

Tofu Chat is not affiliated with or endorsed by Google. Google names and the Google sign-in mark identify their respective services; the app icon and project identity are separate.
