---
layout: post
title: "Rollout history said <none>"
chapter_title: change-cause
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-11-03
tldr: "Every deploy made a new revision, but kubectl rollout history showed CHANGE-CAUSE <none> for all of them. The column comes from the kubernetes.io/change-cause annotation, which the Deployment controller copies onto each ReplicaSet. The deploy script now sets it from a make variable or the git commit before restarting. The controller also re-copies annotations onto the current ReplicaSet, which leaves a race worth checking."
tags:
  - tag: Kubernetes
  - tag: kubeadm
  - tag: DevOps
  - tag: Claude Code
---

## TL;DR
- **Symptom:** every deploy created a new revision, but `kubectl rollout history` showed `CHANGE-CAUSE <none>` for all of them.
- **Cause:** that column is the `kubernetes.io/change-cause` annotation, and nothing set it. The deprecated `--record` flag used to.
- **Fix:** the deploy script annotates each Deployment before it restarts it: `make up-kubeadm CAUSE="…"`, or `deploy <commit>` by default. The Deployment controller copies the annotation onto the new ReplicaSet.

*The app runs on a home cluster with images built on the control plane and a fixed tag (chapter: Onto real hardware). This came up between two dashboard features, late on Oct 7.*

## Setup
- `make up-kubeadm` runs `scripts/kubeadm-up.sh`. It builds three images, imports them into the control plane's containerd and applies the kustomize overlay.
- The images always carry the tag `kubeadm`. An unchanged manifest means `kubectl apply` changes nothing, so the script ends with `kubectl rollout restart deployment` to pick up the new images.
- A restart changes the pod template (it sets a `restartedAt` annotation on it), so each deploy makes a new ReplicaSet, and each ReplicaSet is a revision.

## The symptom

My request to Claude Code was that the script "does not create deployment rollout history entries". That was half right. `kubectl rollout history` listed one revision per deploy, and every one had `<none>` in the `CHANGE-CAUSE` column.


With a fixed tag, the revision doesn't name an image either. The history counted deploys and said nothing about them.

## Where CHANGE-CAUSE comes from

The Kubernetes docs say it in one line:

> `CHANGE-CAUSE` is copied from the Deployment annotation `kubernetes.io/change-cause` to its revisions upon creation.

A revision is a ReplicaSet. "A Deployment's revision history is stored in the ReplicaSets it controls." So the message has to be on the Deployment when the controller creates the new ReplicaSet. `kubectl apply --record` used to set it automatically. That flag is deprecated, and the script never used it.

## The change

The agent read the script and the Makefile, then made two edits. A default message near the top:

```bash
# CHANGE-CAUSE shown by `kubectl rollout history` (make up-kubeadm CAUSE="..."); defaults to the git commit.
if [[ -z "${CAUSE:-}" ]]; then
  CAUSE="deploy $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git diff --quiet HEAD 2>/dev/null || CAUSE+=" (dirty)"
fi
```

And one line before the restart:

```bash
# The change-cause annotation is copied onto the ReplicaSet the restart creates.
kubectl -n "$NAMESPACE" annotate deployment --all --overwrite "kubernetes.io/change-cause=$CAUSE" >/dev/null
kubectl -n "$NAMESPACE" rollout restart deployment >/dev/null
```

Usage:

```bash
make up-kubeadm CAUSE="fix drive-sync backup extraction"
```

The Makefile recipe didn't change. A variable given on make's command line is exported to the recipe's environment, so the script sees `$CAUSE`. The `(dirty)` suffix marks a deploy built from uncommitted changes, so the commit in the message isn't the whole story.

## Testing make's quoting, in a scratch folder

Before relying on make to pass the message through, the agent wrote a two-line Makefile in its scratch folder and fed it a hostile message:

```
$ make -s t CAUSE='fix "quotes" & $stuff'
[fix "quotes" & tuff]
```

Quotes and `&` survive. A `$` doesn't: make expands `$s` as a variable before the shell sees it. Write `$$` for a literal dollar sign. That went into the summary as a warning rather than into the code as a workaround.

## Two caveats the agent named, and one it didn't

The agent said plainly that it had only syntax-checked the script, not run it against the cluster. It listed two things to watch:

- **The `$` above.**
- **Two revisions for one deploy.** If the manifests changed too, `kubectl apply` creates its own revision before the restart creates another. The second one is the one running, and it always has the message.

While I was writing this post, Claude Code read the Deployment controller's source and found a third. In `getNewReplicaSet` (`pkg/controller/deployment/sync.go`), the controller re-syncs annotations onto the ReplicaSet that matches the current template, not only onto new ones:

```go
// Latest replica set exists. We need to sync its annotations (includes copying all but
// annotationsToSkip from the parent deployment, and update revision, desiredReplicas,
// and maxReplicas) and also update the revision annotation in the deployment with the
// latest revision.
if existingNewRS != nil {
```

The script annotates first and restarts second, as two separate commands. If the controller syncs in between, it copies the new message onto the revision that's still running, the previous deploy. Then the restart creates a new revision with the same message, and the previous deploy's message is gone.

I haven't seen this happen, and it depends on timing. If it is real, the fix is to make both changes in one update, so the template changes in the same write as the message:

```bash
kubectl -n ivy patch deployment drive-sync-service --type merge -p "{
  \"metadata\": {\"annotations\": {\"kubernetes.io/change-cause\": \"$CAUSE\"}},
  \"spec\": {\"template\": {\"metadata\": {\"annotations\": {\"kubectl.kubernetes.io/restartedAt\": \"$(date -Iseconds)\"}}}}}"
```

The controller then sees a changed template and a new message together, and creates the new ReplicaSet with it. That's untested too.

## The deeper fix

The annotation is only needed because the tag never changes. If each build were tagged with its git commit, say `drive-sync-service:1ded273`, then `kubectl apply` would change the pod template by itself. No restart step, and `kubectl rollout history deploy/<name> --revision=N` would show the image, which is the real answer to "what was running?".

The fixed tag was a shortcut from the first day on real hardware, when there was no registry and the images went straight into containerd. Moving to commit tags is a small change to the script and the overlay, and I haven't made it yet.

## Takeaways
- **Rollout history is an audit log only if something writes to it.** Set `kubernetes.io/change-cause` on the Deployment before the change that creates the revision.
- **Make the image tag the record.** A tag per commit makes `apply` roll the pods, and the history then names what ran.
- **Test the quoting of anything you pass through make.** A two-line Makefile showed that `$` disappears.
- **Ask what else the controller does with your annotation.** Copying it onto new ReplicaSets is documented, and re-syncing the current one is in the source.

---

Back to the story: *Making the numbers readable*. The next chapter is *Budgets, and rates that stick*.

Commit: [`ade798f`](https://github.com/eyosias-k-negash/ivk8/commit/ade798f) (change-cause in `make up-kubeadm`).
