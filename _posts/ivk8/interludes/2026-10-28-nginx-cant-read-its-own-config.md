---
layout: post
title: nginx can't read its own config
chapter_title: nginx-config
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-10-28
tldr: 'A non-root nginx container crashed with open() "/etc/nginx/conf.d/default.conf" failed (13: Permission denied). The file was mode 600 on the build machine, Docker''s COPY kept the mode, and nginx runs as uid 101. The first fix failed because nginx-unprivileged already runs as uid 101.'
tags:
  - tag: Docker
  - tag: nginx
  - tag: Kubernetes
  - tag: DevOps
  - tag: Claude Code
---

## TL;DR
- **Symptom:** the `web-dashboard` pod crashed at startup with `open() "/etc/nginx/conf.d/default.conf" failed (13: Permission denied)`.
- **Cause:** the file was `600` on the build machine. Docker's `COPY` kept that mode and made root the owner, and the container runs nginx as uid 101.
- **Fix:** set the mode in the Dockerfile. The first attempt, a `RUN chmod`, failed too, because the base image already runs as uid 101.

*The app had just moved from a local k3d cluster onto three machines at home (chapter: Onto real hardware). This was the first thing to break.*

## Setup
- `web-dashboard` is a static React app. A `node:22-alpine` stage builds it, and `nginxinc/nginx-unprivileged:stable-alpine` serves it.
- The Deployment runs the container as uid 101, with `runAsNonRoot`, `readOnlyRootFilesystem: true` and every capability dropped.
- The images were built on the control plane with `docker build`, from my working tree, and imported into its containerd.

## The symptom

I ran the deploy script, and the dashboard pods crashed in a loop. The log said:

```
[emerg] 1#1: open() "/etc/nginx/conf.d/default.conf" failed (13: Permission denied) in /etc/nginx/nginx.conf:36
```

Error 13 is `EACCES`: the file exists, but this process may not open it. nginx couldn't read the one file the Dockerfile had put there on purpose.

## The file on disk

I pasted the error to Claude Code. It started from the source tree, not the cluster:

```
$ ls -la services/web-dashboard/
drwx------ 3 user user 4096 Oct  1 22:12 .
-rw------- 1 user user  843 Oct  1 15:29 Dockerfile
-rw------- 1 user user  302 Oct  1 15:29 index.html
-rw------- 1 user user  871 Oct  1 15:29 nginx.conf
…
```

Every file was `600`, readable by its owner and nobody else. The Dockerfile copied `nginx.conf` straight into the image:

```dockerfile
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY services/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/web-dashboard/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
```

`COPY` from the build context keeps a file's permission bits. Without `--chown`, it also makes root the owner. So the image held `/etc/nginx/conf.d/default.conf` as `root:root`, mode `600`, and nginx runs as uid 101. Only root could read the file.

## Fix 1: chmod, but as which user?

The agent's first fix added a `RUN chmod 644` after the copies. Its note said the stage "still runs as root". The build failed:

```
chmod: /etc/nginx/conf.d/default.conf: Operation not permitted
```

The base image's name was the hint. `nginx-unprivileged` sets `USER 101` itself, so every `RUN` in my stage already ran as uid 101. The `USER 101` at the end of my Dockerfile only restated the default. A uid that doesn't own a file can't change its mode, and `COPY` had made root the owner.

## Fix 2: root for the copy, then back

```dockerfile
FROM nginxinc/nginx-unprivileged:stable-alpine
USER root
COPY services/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/web-dashboard/dist /usr/share/nginx/html
RUN chmod 644 /etc/nginx/conf.d/default.conf && \
    find /usr/share/nginx/html -type f -exec chmod 644 {} + && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} +
EXPOSE 8080
USER 101
```

The build passed and the pods started. A request straight to a dashboard pod returned 200. It took two rounds, six minutes apart. I brought each error back from the build or the cluster, and the agent read the files and wrote both fixes.

## Why was the file 600?

At the time, the agent blamed this machine's umask. That was a guess, and it doesn't hold up. My shell's umask is `022`. In the repo today, 106 tracked files are `600`, and every one of them arrived in the first two commits, on Oct 1 and 2. Every file added since is `644`. So whatever wrote that first scaffold set the modes, not the umask. The project was initally scafolded by claude code client in a different program.

There's a sharper point underneath. Git records only whether a file is executable: `nginx.conf` is stored as `100644`, like every other file in the repo. A fresh clone gets its modes from the cloning machine's umask, usually `644`. So a build from a clean checkout would have produced a working image. Only my working tree produced a broken one. The image depended on which disk built it.

## What I'd write today

`COPY --chmod` sets the mode in the copy itself, with no root step:

```dockerfile
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY --chmod=644 services/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
```

It needs BuildKit, which has been Docker's default builder on Linux since Engine 23; this machine runs Docker 29. The file stays owned by root and read-only to nginx, which is right for a config file. The repo still has the `USER root` version, and I haven't tried this one yet.

Whichever version you use, check the built image rather than the source tree:

```
docker run --rm --entrypoint ls ivy/web-dashboard:kubeadm -l /etc/nginx/conf.d
```

That shows the file the way nginx will see it.

## Takeaways
- **Don't let an image inherit the build machine's file modes.** Set them in the Dockerfile, so every checkout builds the same image.
- **Know which `USER` your base image leaves you.** A non-root base image changes what `RUN` can do.
- **Check the artifact, not the source.** `ls -l` inside the built image answers the question in one line.

---

Back to the story: *Onto real hardware*. 
The next interlude, from the same week, is *The packet that knew the wrong address*.

Commit: [`a194cca`](https://github.com/eyosias-k-negash/ivk8/commit/a194cca) (the Dockerfile fix, with the kubeadm overlay).