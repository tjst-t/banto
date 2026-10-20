# banto

**English** | [日本語](README.ja.md)

A self-hosted workspace for running many AI coding agents in parallel — without having to remember what each one is doing.

**Website & docs: [banto.tjst-t.dev](https://banto.tjst-t.dev)**

![banto: projects and threads in the sidebar, an AI thread waiting for approval to run a command](site/src/assets/screens/hero.png)

## Why

When you hand work to an AI agent, you wait. While you wait, you start another task, then another project. The more work runs in parallel, the harder it gets to keep track of which task is where and which one is waiting for you.

banto's goal is not to run more things at once. It is to make sure **the number of things you have to remember stays the same, no matter how much runs in parallel.**

## What it does

- **See every task's state at a glance.** Projects and threads are listed in the sidebar; threads where the AI is working or has unread replies stand out. Approval requests and finished work land in the **Inbox**, where you can read, answer, and send the next instruction.
- **Fork a thread to try several approaches.** Branch a conversation to compare implementations, or split off an investigation without stopping the main thread. Decisions are kept in the project's **Memory** and carried into every fork.
- **Built-in tools shared by the AI and you.** Shell, file system, browser, secrets (Vault), dev servers and publishing, backlog, and more are provided as **modules** — tools for the AI, screens for you. Modules speak MCP.
- **Automate the routine flow.** Give a backlog task to **Factory** and it creates a worktree, implements, tests, reviews, and merges into `main`. You step in only when it stops.
- **Delegate safely.** The AI works inside a per-project container. Operations you want to check can require approval first, and secret values are never handed to the AI.
- **Use it from your phone.** Answer approvals and check the inbox from a mobile browser.

| Fork a thread | Modules on a Canvas |
|---|---|
| ![A forked thread comparing payment providers](site/src/assets/screens/fork.png) | ![The Backlog module opened next to the conversation](site/src/assets/screens/module.png) |

| Inbox card | Mobile |
|---|---|
| ![An inbox card with a summary and choices to answer](site/src/assets/screens/inbox-card.png) | <img src="site/src/assets/screens/mobile-inbox.png" alt="The inbox on a phone" width="280"> |

The screenshots show the Japanese UI.

## Requirements

| | |
|---|---|
| Server | Ubuntu 24.04 or 26.04 (amd64 / arm64). A virtual machine is fine |
| User | A regular user with sudo (not root) |
| Domain | A domain name for banto (e.g. `banto.example.com`) |
| AI | A Claude account (used through Claude Code) |
| Client | A recent browser on a PC or smartphone |

banto is currently designed for a single user.

## Install

```sh
curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- --domain banto.example.com
```

The installer asks for your sudo password and, optionally, a Cloudflare API token to set up DNS and certificates automatically. When it finishes, it prints the URL and a one-time login link; after logging in, register a passkey under Settings → Login.

See the [Quickstart](https://banto.tjst-t.dev/docs/quickstart/) and [Installation](https://banto.tjst-t.dev/docs/install/) guides for details and options.

## Repository layout

| Path | Contents |
|---|---|
| `banto/` | The application (npm workspaces): `packages/core` (host), `packages/modules/*` (built-in modules), `apps/frontend` (Next.js UI), `e2e/` |
| `docs/specs/` | Design specifications (what has been decided) |
| `docs/notes/` | Design notes and measurements (how it was decided) |
| `site/` | The website and documentation (Astro Starlight) |
| `install.sh` | The installer |
