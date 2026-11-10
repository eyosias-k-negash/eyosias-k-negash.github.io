---
layout: post
title: The real backup
chapter_title: real-backup
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-10-30
tldr: The first real backup from my phone broke the app twice, and neither break was where the plan expected. This chapter covers reading zip backups, where the unzipping lives, what counts as a valid file, and where the cache sits.
tags:
  - tag: TypeScript
  - tag: Node.js
  - tag: Software Architecture
  - tag: DevOps
  - tag: Claude Code
---

*Last time: the app moved from a throwaway k3d cluster onto three machines at home. It had still never opened a backup my phone actually wrote. This chapter is the first time it did.*

## TL;DR
- Ivy Wallet+ writes its backups to Google Drive as zip files. Ivyk8 was looking for `.json`. It now lists the zips newest first, lets the user pick one, and unzips it in `drive-sync-service`.
- The plan expected a real backup to break the schema. The schema passed on the first real backup it saw. What broke was the packaging: a name clash in the bundled server, and JSON written in UTF-16.
- Both failures have their own posts. This one covers the decisions: where unzipping belongs, what counts as a valid backup, and where the cache lives.

## The goal: one real file, end to end

Until Oct 6, the app had never opened a real backup. The tests ran on a small made-up one, and the analytics plan said so in its status table on Oct 2:

> Sanity check + golden test on a real backup: not started

The same plan had a risk table, and one row guessed how the real file would hurt:

> Schema validation stricter than real backups (e.g. `format: uuid` on optional ids). The 1h sanity check on a real backup will show this; relax the validator if needed.

That was a reasonable guess. Real data is usually messier than the schema that describes it. It was also wrong about where the trouble would be, and that is the story of this chapter.

## A backup is a zip

The first problem showed up before any parsing. drive-sync listed `.json` files in the chosen Drive folder. Ivy Wallet+ writes zips, one per backup, each holding a single JSON file.

So I asked for three things: list the zips, sort them newest first, and leave the choice of which one to open to the user. The newest backup is the default guess, not a decision the app makes for you.

Claude Code read the code before changing it. The listing change was small: the Drive query now asks for zip files instead of JSON, still ordered by `modifiedTime desc`. The third requirement needed no code at all. The backup page already rendered every file as a link, and "latest" was a badge on the first row, not an automatic selection. The agent said so instead of building a picker that already existed.

## The part of the request I left out

Then the agent flagged something I hadn't asked about. Listing zips was only half the change. When a user opened one, drive-sync downloaded the raw bytes and sent them to analytics labelled `application/json`. Analytics would have run schema validation on a zip archive.

It stopped and asked before widening the job: add an unzip step, or leave the pipeline alone for now? Its proposal was to unzip in drive-sync and leave analytics unchanged. I agreed.

The boundary was already written down. The report route in drive-sync opens with a comment from the first week: *drive-sync owns "which bytes"; analytics owns "what they mean".*

A zip is a fact about how the phone stores the file in Drive. It says nothing about money. Unwrapping it is "which bytes", so it belongs in drive-sync. Analytics stays a service that accepts JSON and knows nothing about Drive, zips or phones, and none of its code or tests changed.

## What counts as a valid backup

The new module, `backupZip.ts`, is 17 lines. It uses fflate, a small zip library with no dependencies of its own, and it is strict about the shape:

- **The bytes must be a zip.** Anything else is rejected.
- **There must be exactly one `.json` entry.** Directory entries are skipped and the extension check ignores case. A zip with no JSON, or with two, is rejected rather than guessed at.

A rejection is `422 INVALID_BACKUP_ZIP`, with a message that names the file. The status code is a choice. A 500 says the server broke, and a 404 says the file isn't there. 422 is the nearest standard code for "the request was fine, but the file it names can't be used". It points the user at the backup, not the app.

Adding that code failed the typecheck before anything ran. Error codes are a closed union in the shared `packages/contracts` package, and the new one wasn't in it:

```
src/server.ts(110,66): error TS2345: Argument of type '"INVALID_BACKUP_ZIP"' is not
assignable to parameter of type '"BACKUP_TOO_LARGE" | "BAD_REQUEST" | … | "UNAUTHENTICATED"'.
```

That is the contracts package from two chapters ago doing its job. A service can't send an error code until it is declared where the dashboard can see it too.

Four tests covered the new module, the existing fixtures became zip files, and the service's suite went from 16 tests to 20. All passed, and both drive-sync and the dashboard typechecked clean. The agent's summary ended: "Everything passes clean."

## Green tests, dead container

It did pass, and it wasn't enough. I deployed the new image and the drive-sync container died at startup:

```
file:///app/server.mjs:39140
import { createRequire } from "module";
         ^^^^^^^^^^^^^
SyntaxError: Identifier 'createRequire' has already been declared
```

The tests and the typecheck both ran against the TypeScript source. The container runs a single file that esbuild bundles from it, and the bundle had a name clash the source didn't. I pasted the log back, and the fix was one rename in the build script. This time the agent proved it by starting the bundle with placeholder settings, not by running the tests again.

The same build line in analytics was left alone, because analytics doesn't use fflate. The trap is still set there, waiting for a dependency that does the same thing.

→ *Interlude: [Identifier 'createRequire' has already been declared](/2026/10/31/identifier-createrequire-has-already-been-declared.html)*

## Every tab: Internal server error

With drive-sync running again, the backup list loaded and a backup opened. Every report tab then said "Internal server error".

The cause was the JSON inside the zip. It isn't UTF-8. Ivy Wallet+ writes it as UTF-16 with a byte-order mark, and analytics reads JSON bodies as UTF-8. Every upload was rejected before validation began, and a catch-all error handler reported a bad request body as a server crash.

→ *Interlude: [The backup that spoke UTF-16](/2026/11/01/the-backup-that-spoke-utf-16.html)*

The fix converts the entry to UTF-8 in drive-sync, right after the unzip. It is the same boundary as before: the encoding is a fact about the file, not about the money.

The check that closed it was the one the plan had postponed. The agent pushed my real backup through analytics' real ingest route: 500 before the fix, 201 after. The 201 came back with warnings and no errors, which is how the loader reports oddities it can work around. The schema the risk table worried about passed on its first real input. Both failures were in the packaging, a layer the risk table never mentioned.

## Does it download the backup every time?

Two days later, with real data on screen, I asked a performance question. Does drive-sync fetch the backup from Drive on every request? And could a backup that's used often be cached?

It doesn't, and the answer is a good tour of the design. Here is a report request after this chapter's changes:

```
GET /api/backups/:fileId/:report
 │
 ├─ drive-sync: Drive metadata call         every request (folder check, md5)
 ├─ key = sha256(user id, file id, md5)
 ├─ analytics: report(key) ── 200 ──► done  cache hit, no download
 │        │
 │       404  (never loaded, idle, evicted, or pod restarted)
 │        ▼
 ├─ drive-sync: download the zip (size-capped)
 │             unzip → exactly one .json → UTF-16 to UTF-8
 ├─ analytics: ingest(key) → validate → index → cache
 └─ analytics: report(key), once more
```

- **One metadata call per request is the floor.** It's the check that the file is in your folder, and it returns the md5 the key needs.
- **The cache lives in analytics, and it holds parsed datasets.** A hit skips the download, the unzip, the transcode, the parse and the validation in one go.
- **It's an LRU (least recently used) cache** of 8 datasets by default (`DATASET_CACHE_SIZE`). Each entry expires after 30 idle minutes (`DATASET_TTL_MS`), and every hit restarts the clock.
- **The md5 in the key means it can be cold but never stale.** If the file changes, its md5 changes, and so does the key. There is no invalidation code because none is needed.

A backup is downloaded again when its entry sat idle past 30 minutes, got pushed out by newer ones, or the analytics pod restarted. With more than one analytics replica, a request could also land on a replica that never loaded it. That is why, as the last chapter mentioned, analytics runs a single replica.

The agent offered three options if re-downloads ever became a problem:

1. **Raise the TTL and the cache size.** The cheapest change.
2. **Cache the zip or the extracted JSON on disk in drive-sync,** on a volume, keyed the same way. It survives analytics restarts, but every user's financial data then sits on a disk that needs sizing and cleanup.
3. **Sticky routing, or a shared store such as Redis,** if analytics ever runs more than one replica.

It also said to measure first: add a log line and count how often the re-download path runs, before changing anything.

I changed nothing. Option 3 is the Redis the first critique took out of the design. Option 2 is a database by another name: state on disk, with my transaction history in it. A cold cache costs one download from Drive, which is a fair price for a dashboard one person opens.

I didn't add the log line either. So "misses are rare" is a guess, not a measurement, and the counter is still a good idea.

## Takeaways
- **Open the real artifact on day one.** The risk table guessed which layer a real backup would break and named the wrong one. A golden test against a sanitized real backup is still on the list.
- **Test what you ship.** The tests ran the source, and the container ran a bundle. A CI step that starts the built bundle with dummy settings takes seconds.
- **Absorb format quirks at the edge that knows the format.** The zip and the UTF-16 are facts about the file, so drive-sync handles both and analytics only ever sees plain JSON.
- **Put the source's checksum in the cache key.** The cache can then be cold but never wrong, and you never write invalidation code.

## What's next

With a real backup loading, the charts finally had real data, and real data has more categories than a chart has colors. The next chapter is the first feature built for the data rather than for the plan.

*The story continues as the work does.*

---


Source: [github.com/eyosias-k-negash/ivk8](https://github.com/eyosias-k-negash/ivk8). Commits: [`fb809ba`](https://github.com/eyosias-k-negash/ivk8/commit/fb809ba) (zip listing and unzip), [`1ded273`](https://github.com/eyosias-k-negash/ivk8/commit/1ded273) (UTF-16 to UTF-8).
