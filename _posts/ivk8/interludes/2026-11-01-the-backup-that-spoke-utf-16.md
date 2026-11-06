---
layout: post
title: The backup that spoke UTF-16
chapter_title: utf-16
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-11-01
tldr: "Every report failed with 500 Internal server error, and analytics logged FastifyError: Request body size did not match Content-Length. The JSON inside the phone's backup zip is UTF-16 big-endian with a byte-order mark. Fastify decodes JSON bodies as UTF-8 and compares the decoded size with Content-Length, which fails with a 400, and our own error handler turned the 400 into a 500. drive-sync now converts the file to UTF-8."
tags:
  - tag: Node.js
  - tag: Fastify
  - tag: TypeScript
  - tag: Debugging
  - tag: Claude Code
---

<!-- Draft from blog/INTERLUDES.md entry D. Search for TODO before posting; delete this comment too. File: _posts/ivyk8/2026-11-01-the-backup-that-spoke-utf-16.md. Sorts after Interlude C (Oct 31) and before chapter `trends` (Nov 2). -->

## TL;DR
- **Symptom:** the backup list loaded and a backup opened, but every report tab said "Internal server error". In analytics' log: `Request body size did not match Content-Length`.
- **Cause:** the JSON inside the phone's backup zip is UTF-16 big-endian with a byte-order mark (BOM). Fastify reads JSON bodies as UTF-8 and checks the decoded size against `Content-Length`. They didn't match, so it rejected the body with a 400. Our catch-all error handler reported that 400 as a 500.
- **Fix:** drive-sync converts the file to UTF-8 right after unzipping it. The error handler still turns unknown 4xx errors into 500s.

*That day, drive-sync had learned to open zip backups and survived a crash at startup (chapter: The real backup). This was the first time a real backup went all the way through.*

## Setup
- **`drive-sync-service`** downloads the chosen backup zip from Google Drive, extracts its one JSON file and sends it to analytics with `PUT /datasets/<key>`, labelled `application/json`.
- **`analytics-service`** is a Fastify 5 server. It parses the body, validates it against the backup schema and caches the result in memory.
- **The dashboard** asks drive-sync for a report. On a cache miss, drive-sync uploads the backup to analytics first, then asks again.
- Until that day, every test had used a backup written as plain UTF-8 JSON.

## The symptom

I picked a backup, the tabs loaded, and every one of them showed the same error. I asked Claude Code to debug it. The browser said the `/api/backups/<id>/<report>` calls returned 500, so drive-sync was the first suspect.

drive-sync's logs had nothing at warning level or above. They were full of something else:

```
{"level":30,…,"req":{"method":"GET","url":"/healthz",…},"msg":"incoming request"}
```

The kubelet probes every pod every few seconds, and each probe writes two lines. The agent filtered them out, along with every 200 and 304:

```
kubectl -n ivy logs $p --since=12h | grep -vE 'healthz|readyz' | grep -vE '"statusCode":(200|304)'
```

What remained in drive-sync was a row of 500s, each taking about two seconds. The cause wasn't there. A second pass over all the pods, looking for error-level lines, found it in analytics:

```
{"level":50,…,"err":{"message":"Request body size did not match Content-Length",
 "stack":"FastifyError: Request body size did not match Content-Length\n    at IncomingMessage.onEnd (file:///app/server.mjs:13980:16)…"},"msg":"unhandled"}
```

drive-sync wasn't failing. It was relaying a failure from the service behind it.

## Where Fastify raises it

The client that sends the upload looked right: a `Buffer`, a JSON content type, and `fetch` sets `Content-Length` from the bytes. So the agent read the part of Fastify that raises this error. In Fastify 5.12.5, `lib/content-type-parser.js`, the body reader for a JSON request does three things:

```js
if (asString) {
  payload.setEncoding('utf8')                                          // line 260
}
…
receivedLength += asString ? Buffer.byteLength(chunk) : chunk.length   // line 269
…
if (!Number.isNaN(contentLength) && (payload.receivedEncodedLength || receivedLength) !== contentLength) {
  done(new FST_ERR_CTP_INVALID_CONTENT_LENGTH(), undefined)            // line 302
```

It decodes the incoming bytes as UTF-8 into a string. It then measures that string in UTF-8 bytes and compares the total with `Content-Length`. For valid UTF-8, decoding and re-encoding gives back the same bytes, so the counts agree. For anything else, they don't.

## The bytes

The agent unpacked one of my backups and printed the first bytes of the JSON inside:

```
fe ff 00 7b 00 22 …
```

`fe ff` is the byte-order mark for UTF-16 big-endian. `00 7b` is `{` and `00 22` is `"`. Ivy Wallet writes its backup JSON in UTF-16. Every test so far had used a made-up backup written as UTF-8, so nothing had met this before.

## Why the size was only a little off

UTF-16 big-endian stores every ASCII character as a zero byte followed by the character. Both bytes are below `0x80`, so a UTF-8 decoder accepts them: a NUL, then the character, at the same byte count. JSON is mostly ASCII, so most of the file decodes to garbage of exactly the right size.

The bytes that aren't valid UTF-8 are each replaced with U+FFFD, the replacement character, which takes three bytes in UTF-8. The BOM's `fe` and `ff` are never valid UTF-8, so even an all-ASCII backup grows by four bytes. Each non-ASCII character can add a couple more.

Here's the same thing on the synthetic backup the tests use, converted to UTF-16 big-endian with a BOM and sent through analytics' real ingest route:

| Backup | `Content-Length` | UTF-8 bytes after decoding | U+FFFD | Status |
|---|---|---|---|---|
| ASCII only | 1,276 | 1,280 | 2 | 500 |
| One category renamed to "Café" | 1,276 | 1,282 | 3 | 500 |
| Converted to UTF-8 first | 637 | 637 | 0 | 201 |

A size check is a strange place to discover an encoding problem. But it is the first thing that looks at every byte.

## The second bug: a 400 that became a 500

Fastify defines that error with a status code:

```js
FST_ERR_CTP_INVALID_CONTENT_LENGTH: createError(
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
  'Request body size did not match Content-Length',
  400,
```

A 400 means "your request was bad", which was true. But analytics has its own error handler, and it only knows a few errors by name:

```ts
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof BadRequest || err instanceof RangeTooLarge) return fail(reply, 400, 'BAD_REQUEST', err.message);
  if (err instanceof IngestError) return fail(reply, 422, err.code, err.message, err.details);
  if ((err as { statusCode?: number }).statusCode === 413)
    return fail(reply, 413, 'BACKUP_TOO_LARGE', 'Backup exceeds the size limit');
  …
  return fail(reply, 500, 'INTERNAL', 'Internal error');
});
```

It passes a 413 through and turns everything else into a 500. drive-sync relayed the 500, and the dashboard showed "Internal server error". A file in an unexpected encoding was reported as a crashed server, which pointed the first search at the wrong service.

## The fix

The conversion belongs in drive-sync, next to the unzip. The encoding is a fact about the file the phone wrote, like the zip itself. Analytics should only ever see plain UTF-8 JSON.

```ts
function toUtf8(bytes: Buffer): Buffer {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const le = Buffer.from(bytes.subarray(2)); // copy: swap16 mutates in place
    if (le.length % 2 !== 0) throw new InvalidBackupZip('backup JSON is truncated UTF-16');
    return Buffer.from(le.swap16().toString('utf16le'), 'utf8');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2).toString('utf16le'), 'utf8');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3);
  return bytes;
}
```

Node's `Buffer` can decode UTF-16 little-endian but not big-endian. So the big-endian case swaps each pair of bytes first, then decodes. The function also handles little-endian and drops a UTF-8 BOM, since JSON parsers don't expect one either. Three tests cover the three cases, including a non-ASCII string ("Café €") that has to come back intact.

The proof was the check the plan had postponed. The agent loaded analytics' real Fastify app in a script and pushed one of my real backups through its ingest route, once raw and once converted. The raw entry got a 500, and the converted one got a 201. The trace, the fix, the tests and that proof took two minutes from my message.

To find a real backup to test with, the agent searched my home folder and used the zips it found there. It ran them on my machine and printed sizes, record counts and the first bytes. I'd still rather have been asked first. <!-- TODO author: keep or cut this paragraph. -->

## Still open

The error handler still maps every error it doesn't know to a 500. The fix is small: if Fastify has already set a 4xx `statusCode`, pass it through. Until then, the next client error will also look like a crash.

## Takeaways
- **Look at the first bytes.** `xxd file | head -1` shows a BOM, a zip header or a gzip header in one line.
- **Convert at the edge that knows the format.** drive-sync knows the phone writes UTF-16, so analytics never has to.
- **Don't let a catch-all handler drop the framework's status code.** A 400 reported as a 500 sends you looking in the wrong service.
- **Filter the probes out of your logs before you read them.** Health checks write most of the lines and none of the answers.

---

Back to the story: *The real backup*. The previous interlude is *Identifier 'createRequire' has already been declared*, and the next chapter is *Making the numbers readable*.

*Built with Claude Code as a pair. What I directed, checked and changed is in the story.*

Commit: [`1ded273`](https://github.com/eyosias-k-negash/ivk8/commit/1ded273) (UTF-16 to UTF-8 in drive-sync).
