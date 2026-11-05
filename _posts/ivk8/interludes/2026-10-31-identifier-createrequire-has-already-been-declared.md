---
layout: post
title: "Identifier 'createRequire' has already been declared"
chapter_title: create-require
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-10-31
tldr: "A Node service bundled by esbuild crashed at startup with SyntaxError: Identifier 'createRequire' has already been declared, right after adding fflate. The build's --banner imported createRequire, and so did fflate's ESM build. esbuild renames clashes between the modules it bundles, but the banner is plain text it never parses. Renaming the banner's import fixed it."
tags:
  - tag: esbuild
  - tag: Node.js
  - tag: TypeScript
  - tag: DevOps
  - tag: Claude Code
---

<!-- Draft from blog/INTERLUDES.md entry C. Search for TODO before posting; delete this comment too. File: _posts/ivyk8/2026-10-31-identifier-createrequire-has-already-been-declared.md. Sorts after chapter `real-backup` (Oct 30) and before Interlude D (Nov 1). -->

## TL;DR
- **Symptom:** after a zip library was added, the `drive-sync-service` container died at startup with `SyntaxError: Identifier 'createRequire' has already been declared`. All 20 tests and the typecheck had passed.
- **Cause:** the build's esbuild `--banner` declares `createRequire` at the top of the bundle. The new library, fflate, imports `createRequire` too. esbuild renames clashes between modules it bundles, but it never parses the banner, so it couldn't rename around it.
- **Fix:** give the banner's import a name nothing else will use: `import { createRequire as __bannerCreateRequire } from 'module'`.

*That day, drive-sync had learned to open the zip files my phone writes to Google Drive (chapter: The real backup). This was the first deploy of that change.*

## Setup
- `drive-sync-service` is a small Fastify server written in TypeScript. esbuild bundles it into one ESM file, `dist/server.mjs`, and that one file is what the container runs.
- Some dependencies inside the bundle are CommonJS and call `require`. An ESM file has no `require`, so the build script adds one with a banner:

  ```
  esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm \
    --outfile=dist/server.mjs \
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
  ```

- The new feature added **fflate** 0.8.3, a zip library with no dependencies of its own, to unpack the backup.
- The tests (vitest) and the typecheck both run against the TypeScript source. Neither runs the bundle.

## The symptom

I deployed the new image to the home cluster, and the drive-sync pods crashed in a loop. I pasted the log to Claude Code:

```
file:///app/server.mjs:39140
import { createRequire } from "module";
         ^^^^^^^^^^^^^

SyntaxError: Identifier 'createRequire' has already been declared
    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)
    …
```

Line 39,140 of a bundle is not a line anyone wrote. The question was who else had declared `createRequire`.

## Two declarations, one scope

The agent rebuilt the bundle locally and searched it:

```
$ grep -n "createRequire" dist/server.mjs | head
1:import{createRequire}from'module';const require=createRequire(import.meta.url);
9120:    var { createRequire: createRequire2 } = __require("module");
9323:            fixTarget2 = createRequire2(context).resolve(origin);
39140:import { createRequire } from "module";
39141:var require2 = createRequire("/");
```

Line 1 is the banner. Line 39,140 is fflate, whose ESM build starts like this:

```js
import { createRequire } from 'module';
var require = createRequire('/');
```

fflate uses that `require` to load `worker_threads` for its asynchronous functions. It's a reasonable thing for a library to do, and it's the same trick the banner uses.

In an ES module, every `import` binding belongs to the module's top-level scope. A bundle is one module. Two imports of the same name in one scope is a syntax error, and Node refuses to load the file at all.

## Why esbuild didn't rename it

esbuild normally handles exactly this. Line 9,120 shows it: another dependency's `createRequire` was renamed to `createRequire2` on its way into the bundle. fflate's own `require` became `require2` on line 39,141. Only `createRequire` on line 39,140 kept its name.

The difference is the banner. esbuild writes it into the output as text, without parsing it. So the renamer never learns that line 1 already took the name.

I checked this again for this post with a two-line entry file that imports fflate and also imports `createRequire` itself:

```
# without the banner: esbuild sees both imports and renames one
import { createRequire } from "module";
…
import { createRequire as createRequire2 } from "module";

# with the banner: the banner's import goes in untouched
$ node a.mjs
SyntaxError: Identifier 'createRequire' has already been declared
```

Two modules that clash get renamed. A banner that clashes with a module doesn't.

## The fix

One rename in `package.json`:

```diff
- --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
+ --banner:js="import{createRequire as __bannerCreateRequire}from'module';const require=__bannerCreateRequire(import.meta.url);"
```

The banner still defines `require` for the CommonJS code. Its import now has a name no library will pick.

This time the agent didn't stop at the tests. It rebuilt and started the bundle itself, first with no settings:

```
Error: Missing required env var SESSION_SECRET
```

That error is progress: the file parsed, and the config check ran. Then it started the bundle with placeholder settings:

```
{"level":30,…,"msg":"Server listening at http://127.0.0.1:18099"}
```

From my pasted log to the agent's summary took 43 seconds.

## Why the tests were green

The tests import the TypeScript source, and vitest resolves fflate the way Node would, as a separate module. There is no banner and no single scope, so there is no clash. The bug only exists in `dist/server.mjs`, and nothing in the local checks ever loaded that file.

The CI pipeline would have caught it. It builds the images, deploys them to a throwaway k3d cluster and runs a smoke test that calls drive-sync through the ingress. But I had deployed from my laptop with `make up-kubeadm` before pushing, so the cluster at home found it first.

## Still open

`analytics-service` has the same build line, with the un-renamed banner:

```
"build": "esbuild src/main.ts … --banner:js=\"import{createRequire}from'module';const require=createRequire(import.meta.url);\""
```

The agent left it alone on purpose, because analytics doesn't use fflate. That's true, and it's also a trap waiting for the next dependency that imports `createRequire` at the top of its ESM build. It's a one-line change I haven't made yet. <!-- TODO author: make it, or keep this sentence. -->

## Takeaways
- **Namespace anything you inject into a bundle.** A banner is outside the bundler's view, so it can't rename it for you. Pick names no library will use.
- **Start the built artifact, not only the source.** `node dist/server.mjs` with dummy settings takes a second and tests what the container runs.
- **A config error can be good news.** "Missing required env var" means the file parsed and the code ran.

---

Back to the story: *The real backup*. The next interlude is *The backup that spoke UTF-16*, which broke the same feature nine hours later.

*Built with Claude Code as a pair. What I directed, checked and changed is in the story.*

Commit: [`fb809ba`](https://github.com/eyosias-k-negash/ivk8/commit/fb809ba) (zip support and the banner fix).
