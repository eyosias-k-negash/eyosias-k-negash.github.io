---
layout: post
title: From a phone app to a cluster
chapter_title: origin
series_title: "Ivyk8: a desktop view of a phone app"
series_tldr: A serialized account of building Ivyk8, a read-only desktop dashboard for an Android money manager's backups, on Kubernetes. One post per feature, plus short posts when the cluster misbehaves.
show_contact_card: true
no_nav_bar: false
live: true
tldr: The first Ivyk8 blueprint was a flagship platform that a critique sized at 18 months of work for a team. This chapter covers the Android fork it grew from, the critique, and the cut to three stateless services.
tags:
  - tag: Kubernetes
  - tag: DevOps
  - tag: Software Architecture
  - tag: Claude Code
---


## TL;DR
- **Ivyk8** is Ivy + k8s: a read-only desktop dashboard for the backups my phone app writes to Google Drive.
- The first blueprint was a flagship platform: Postgres with replicas, Redis, a service mesh, GitOps, canaries. A critique of it said it was about 18 months of work for a team.
- On Oct 1 I cut it to three stateless TypeScript services, Kubernetes for delivery, and five written decisions (ADRs).
- This is part 1 of a series. Parts about each feature and each outage follow.

## Where it starts: a phone app I couldn't leave alone

Ivy Wallet is an open-source money manager for Android. Its owner archived it on Nov 5, 2024.  I wanted to keep using it, so I forked it as [Ivy Wallet+](https://github.com/eyosias-k-negash/ivy-wallet-plus) and added what I was missing.

The additions, in the order I made them in late August:

- **Photo and audio attachments** on transactions.
- **Transaction location:** coordinates and a place name, a Room (Android's SQLite layer) migration, and a button that opens the place in a maps app.
- **Balance at day:** tap a date in the history and see each account's balance on that day.
- **SMS auto-fill.** The app listens for bank SMS on a chosen SIM, parses the amount, balance, date and description with per-bank regex rules, and raises a notification that opens a pre-filled transaction. Rules import as JSON. I wrote rule sets for four banks and a mobile-money wallet.
- **A wrapped reports filter** in place of horizontal scrolling, and a rebrand to Ivy Wallet+ with its own package name and logo.

None of that is this blog's subject. It matters because of what it did to the data. The phone now captured more than before, and a phone screen is a poor place to study years of transactions.

## The gap

Ivy Wallet+ already writes its backups to Google Drive. That file is the whole interface between the phone and anything else. So the idea was small: read the backup, show it on a desktop screen with charts the app can't draw, and see trends, averages, and projections of expenses and incomes.

## The first blueprint was too big

I started where an ambitious person starts, with a prompt for a "top 1% flagship project". The first blueprint had:

- a Kotlin sync client and a Go sync API;
- a currency service and a report worker;
- Postgres with read replicas, and Redis as both cache and queue;
- Istio, Argo CD, Argo Rollouts, KEDA, SOPS and a full observability stack.

I asked Claude Code to critique it before building anything. This is where the pair worked well: the critique was blunt and I kept it.

> "Roughly 18 months of work for a team."

It also found specific faults:

- **Redis as cache and queue is a contradiction.** A cache wants `allkeys-lru` (evict anything under memory pressure). A queue needs `noeviction` (never lose a job). One instance can't be both.
- **Read replicas break read-your-writes.** A sync client that uploads and then reads back can see old data.
- **A hand-rolled Postgres StatefulSet "signals junior K8s judgment".** Use an operator, or don't run a database.
- **No identity layer.** Nothing said who the user was.
- **"Cosign signing without admission verification is security theater."** Signed images mean little if the cluster never checks the signatures.

The last point is worth a dry aside. It's still partly true of this project today: the release workflow signs images, and nothing in the cluster verifies them yet. The critique named the gap before I built it. Closing it is on the list.

## The cut

I cut in two stages.

**The MVP prompt** kept core Kubernetes and a basic CI pipeline with static scanning. GitOps, canaries, observability, KEDA and signing went on hold.

**The final cut, Oct 1,** went further. I wrote it down as five architecture decision records (ADRs), short files that say what was decided and what it replaced:

| ADR | Decision |
|---|---|
| 0001 | Three stateless TypeScript services: `web-dashboard`, `drive-sync-service` (the public back end for the dashboard) and `analytics-service` (internal). No Postgres, no Redis. It supersedes the earlier scaffold. |
| 0002 | Sessions live in an encrypted cookie, so the services hold no session store. |
| 0003 | Google Drive access is limited to the `drive.readonly` scope. The app can't change a backup even if it were compromised. |
| 0004 | Kubernetes is the only delivery path: k3d (Kubernetes in Docker) locally and in CI, no docker-compose. |
| 0005 | Exchange rates come from the ECB, with a fallback source for currencies the ECB doesn't publish. |

The reasoning behind 0001 is the part to keep. The analytics are computed in memory from one file. Timezone and rate overrides are request parameters. Nothing needs to persist between requests, so nothing gets a database. On a cache miss, drive-sync re-uploads the backup to analytics. That is a feature, not a shortcut: stateless services can be killed, replicated and rolled without ceremony. I did not know yet how much I would lean on that.

## The goal

One sentence in the repo says what I was after: **built, secured, tested and delivered the way a production product would be.** The product is a personal dashboard for one user. The practice around it is the point: tests that gate merges, image scanning, signed releases, rollouts on a real cluster.

That decides how the series is told. Features are chapters. The cluster misbehaving is its own kind of story, and those get shorter posts of their own.

## What it taught me

- **Ask for the critique before the code.** An hour of being told the plan is theater was cheaper than 18 months of finding out.
- **Statelessness is a decision you pay for once.** Dropping the database removed whole classes of work: migrations, backups, replicas, failover.
- **Write the decision down while it is fresh.** The ADRs are why I can still explain, weeks later, why there is no Redis.

## What's next

The next parts cover the dashboard's first real features and the move from a local k3d cluster onto three machines at home. That second move did not go smoothly, and it is the source of the stranger posts.

*The story continues as the work does.*

---

*Built with Claude Code as a pair. What I directed, checked and changed is in the story.*

Source: [github.com/eyosias-k-negash/ivk8](https://github.com/eyosias-k-negash/ivk8). Decisions: `docs/adr/0001`–`0005`.
