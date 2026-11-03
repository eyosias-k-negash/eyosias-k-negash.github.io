---
layout: post
title: The packet that knew the wrong address
chapter_title: wrong-address
show_contact_card: true
no_nav_bar: false
live: true
date: 2026-10-29
tldr: Pod traffic between the nodes of a three-node kubeadm cluster died while Calico's BGP sessions stayed Established. Two nodes had several addresses. Calico announced one, the kernel sent IPIP from another, and Felix dropped the tunnel packets as coming from a non-Calico host. Pinning IP_AUTODETECTION_METHOD fixed the tunnel.
tags:
  - tag: Kubernetes
  - tag: Calico
  - tag: kubeadm
  - tag: Networking
  - tag: DevOps
  - tag: Claude Code
---

## TL;DR
- **Symptom:** on a three-node kubeadm cluster, pod traffic between nodes died. Every Calico health signal stayed green, and moving Traefik to another node changed nothing.
- **Cause:** two nodes had more than one address. Calico announced one, the kernel sent tunnel packets from another, and Felix dropped them as coming from a host it didn't know.
- **Fix:** pin Calico's address detection to the route the kernel actually uses (`IP_AUTODETECTION_METHOD=can-reach=…`), and give each node one stable address.

*The app had just moved onto three machines at home, with its pods pinned to the control plane (chapter: Onto real hardware). It took three separate outages to understand this one.*

If you only want the mechanism, skip to [Root cause](#root-cause).

## Setup
- **Control plane:** an Arch laptop in a USB-C dock. It had Wi-Fi (`192.168.0.167`), a USB ethernet adapter in the dock (`.180`, with the lower route metric) and a direct cable to the Pi (`10.10.10.10`).
- **Raspberry Pi:** Wi-Fi on the LAN (`.104`, and at times `.105` as well), plus the other end of the cable (`10.10.10.11`).
- **WSL2 desktop:** one address, `.128`.
- **Calico v3.25.0** in IPIP mode (IP-in-IP, its tunnel between nodes) with a BGP full mesh. The DaemonSet said `IP=autodetect` and set no detection method.
- **App pods are pinned to the control plane.** Traefik can land on any node, so most requests cross a tunnel.

## Act 1, Oct 2: everything green, nothing works

The deploy script finished, and the URL timed out. I noticed Traefik's external IP was `<pending>`. That was the first dead end: with a NodePort Service and no load balancer, `<pending>` is expected.

Claude Code tested one hop at a time from the control plane. The `web-dashboard` pod on the same node returned 200. The Traefik pod, on the Pi, timed out, and so did NodePort 30080 on every node.

The first theory came from comparing two records of the Pi's address:

```
--- kubectl node IP for raspberrypi ---
InternalIP=192.168.0.104
--- calico's recorded IP for raspberrypi ---
"projectcalico.org/IPv4Address":"192.168.0.105/24"
```

`.104` didn't answer pings. `.105` did, from a MAC address starting `b8:27:eb`, a Raspberry Pi prefix. The agent concluded that the Pi's DHCP lease had changed and the Node object was stale. That was incomplete. The Pi dropped off and came back (its Calico pod restarted at 12:08), and the mismatch survived the restart. A stale lease doesn't survive a restart. Two addresses do.

The agent then tried to cordon the Pi, and then to patch Traefik's node affinity to move it off. Claude Code's permission check blocked both: changes to nodes and shared resources on a live cluster need my approval. I moved Traefik to the WSL node myself. It still timed out.

I also noticed that nothing was listening on port 30080, and a port-forward to Traefik hung. That turned out to be a side road. kube-proxy forwards a NodePort with DNAT (destination rewriting) rules in the kernel, so traffic doesn't depend on a process reading from that port.

The wider test settled the scope. From a test pod on the Pi to Traefik on the WSL node, a path that never touches the control plane:

```
wget: download timed out
```

No node could reach another node's pods. At the same moment, Calico on the control plane reported `Number of node(s) with BGP peering established = 2`. BGP said Established. The packets disagreed.

Two dead ends followed, both the agent's guesses. First, that WSL2's virtual network drops IPIP. A request from the control plane to a pod on the Pi, two bare-metal machines, failed the same way, so that was out. Second, a host firewall or the home router filtering IP protocol 4. The agent asked for sudo to check. I answered with two observations instead, and they moved it forward. `kubectl exec` worked into pods on both other nodes. The agent explained why that proves less than it seems. Exec travels from the API server to the kubelet on port 10250, over the host network and outside the pod overlay. And a Service's ClusterIP worked from one place but not another. Tested with a backend known to be healthy, that gave a clean rule:

```
-- same-node: hostname curling web-dashboard ClusterIP --
status:200 time:0.000533
-- cross-node: pod on raspberrypi curling web-dashboard ClusterIP (backend is on hostname) --
wget: download timed out
```

A ClusterIP worked exactly when the caller and the backend shared a node. Services weren't the problem. Anything that crossed the tunnel was.

The break came from kube-proxy's log on the control plane:

```
"NodeIPs changed for the node" node="hostname" newNodeIPs=["10.10.10.10"] oldNodeIPs=["192.168.0.180"]
```

The control plane had more than one address too. The agent compared what Calico and Kubernetes believed for each node:

```
hostname: calico=192.168.0.167/24 k8s-internal=192.168.0.180
raspberrypi: calico=192.168.0.105/24 k8s-internal=192.168.0.104
wsl-desktop: calico=192.168.0.128/24 k8s-internal=192.168.0.128
```

And what the control plane's kernel actually used:

```
default via 192.168.0.1 dev enp4s0f4u1 proto dhcp src 192.168.0.180 metric 100
default via 192.168.0.1 dev wlp2s0 proto static metric 600
$ ip route get 192.168.0.104
192.168.0.104 dev enp4s0f4u1 src 192.168.0.180
```

Calico had told the other nodes that the control plane was `.167`, its Wi-Fi address. The kernel sent everything from `.180`, the dock's adapter, because that route had the lower metric. The only machine with a single address, the WSL desktop, was the only one whose records agreed.

The agent proposed pinning Calico's address detection and asked to apply it. Nothing was applied that day.

## Act 2, Oct 6: the roles flip

Four days later, a port-forward to Traefik returned 504 Gateway Timeout on every path. Traefik was healthy. Every backend it tried to reach was on another node.

The mismatch was back, the other way round:

```
calico=192.168.0.180/24 k8s=192.168.0.167     # control plane
calico=192.168.0.104/24 k8s=192.168.0.105     # Pi
```

The agent looked at the Pi through its `calico-node` pod, which runs on the host network:

```
wlan0            UP             192.168.0.104/24 192.168.0.105/24 …
$ ip route get 192.168.0.180
192.168.0.180 dev wlan0 src 192.168.0.105
```

The Pi had two addresses on one interface. Every time a component restarted, the kubelet and Calico each picked one of the two, independently. That explained the flip-flopping between sessions.

I removed the extra address on the Pi. Still 504. Calico's record for the Pi still said `.105`, the address I had just removed, and BGP to the Pi had stalled:

```
Mesh_192_168_0_128 BGP      master   up     11:01:49    Established
Mesh_192_168_0_105 BGP      master   start  11:18:17    Connect       Socket: No route to host
```

With that session down, the route to the Pi's pod subnet had been withdrawn. Nothing was being filtered any more. There was no route at all.

The agent said Calico detects its address only once, at startup, and asked to delete the Pi's `calico-node` pod. I said yes. Sixty-five seconds later the record said `.104`, BGP to `.104` was Established, the route was back, and the full path through Traefik's Service worked:

```
via traefik svc: 200 (0.020977s)
```

The "only at startup" claim was wrong, as the next day's logs showed. More on that under Root cause.

Then I drew the obvious conclusion: "this means I have to set a static IP for all nodes in the cluster." The agent disagreed, and it was right. A DHCP reservation would stop the Pi collecting a second lease. It wouldn't touch the control plane's problem: a machine with several interfaces, where each component decides on its own which one is "mine". Static addresses don't choose for Calico. A pinned detection method does.

## Act 3, Oct 7: "Try to understand the root cause"

The next afternoon the app was unreachable again. I had already moved Traefik, and it hadn't helped. So I asked the agent to "try to understand the root cause of this issue", because it kept happening.

This time it read counters. Felix, Calico's agent on each node, guards the tunnel with two iptables rules. On the Pi:

```
[0:0] -A cali-INPUT -p ipv4 … "Allow IPIP packets from Calico hosts" -m set --match-set cali40all-hosts-net src … -j ACCEPT
[62655:5016866] -A cali-INPUT -p ipv4 … "Drop IPIP packets from non-Calico hosts" -j DROP
```

`-p ipv4` here means IP protocol 4, which is IPIP, not IPv4 in general. Zero packets allowed, 62,655 dropped. Three test requests to Traefik moved the drop counter from 62,774 to 62,815. The allow-list is an ipset holding the address each node had registered:

```
Members:
192.168.0.128
192.168.0.105
10.10.10.10
```

The control plane was registered as `10.10.10.10`, its end of the direct cable, and it sent to the Pi from `.180`. The control plane's own counter showed the other direction: 14,551 dropped tunnel packets. The Pi sent them over the cable from `10.10.10.11`, an address it had never registered.

| Direction | Tunnel packets came from | Registered as | Result |
|---|---|---|---|
| control plane → Pi | `192.168.0.180` (dock adapter) | `10.10.10.10` | dropped, 62,655 |
| Pi → control plane | `10.10.10.11` (direct cable) | `192.168.0.105` | dropped, 14,551 |
| WSL desktop ↔ control plane | n/a | `10.10.10.10` | BGP can't connect: `Network is unreachable` |

The fallout reached the cluster's own plumbing. Traefik logged `no route to host` to the API server's Service IP, and `calico-kube-controllers` had restarted 197 times.

The full picture was that every component picked its own address:

| Component | Control plane | Pi |
|---|---|---|
| kubelet | `.167` | `.104` |
| API server, etcd, kubeconfigs | `.180` | n/a |
| Calico (auto-detected) | `10.10.10.10` | `.105` |
| The kernel's actual source address | `.180` | `.105` to the LAN, `10.10.10.11` over the cable |

One correction to the agent's version of that table. It said the control plane's kubelet address was "set by flag", because it had read `--node-ip=192.168.0.167` in `/etc/default/kubelet`. A later investigation found that Arch's kubelet unit never reads that file, so the flag never applied. That one gets its own post.

## Root cause

- **Calico's default detection is `first-found`.** Its docs describe it as the first valid address on the first interface, skipping local ones such as the Docker bridge. On a machine with several interfaces, that is whichever one it meets first, not the one the kernel routes through. The docs list hosts with several interfaces, and interfaces with several addresses, as cases for choosing the address yourself.
- **Each node publishes the address it chose,** and Felix on every node builds its IPIP allow-list from the published addresses.
- **The kernel picks a packet's source address from its route table.** On the control plane, the dock's adapter had the lowest metric, so tunnel packets left from `.180` whatever Calico had published.
- **When the two disagree, the receiving Felix sees IPIP from an unknown host and drops it.** Nothing is logged. Only a counter moves.
- **BGP stays green** because it is an ordinary TCP session between the published addresses, and the drop rule matches IP protocol 4 only. As long as two nodes can reach each other's published addresses, BGP stays Established while every tunnel packet between them dies.

**Why it kept coming back:** Calico doesn't detect once. Its logs show a `monitor-addresses` loop re-running detection about once a minute:

```
monitor-addresses/autodetection_methods.go 103: Using autodetected IPv4 address on interface wlan0: 192.168.0.105/24
```

So a Wi-Fi reconnect, a cable plugged in or a new DHCP lease can change which address wins, and some pair of nodes breaks again. Moving Traefik only changed which broken pair I was hitting, because the backends were pinned to the control plane.

That log also contradicts the Oct 6 claim that detection runs only at startup. Yet on Oct 6 the record stayed on a deleted address until the pod restarted. A later investigation found a bug in Calico v3.25.0 that lets only one node-address change through per pod lifetime. That fits what happened on Oct 6, but I didn't prove it for that day.

## Fix

**The quick fix (Oct 6):** remove the Pi's extra address, then delete its `calico-node` pod so it detects again. Traffic comes back until the next address change.

**The pin**, proposed on Oct 2, 6 and 7:

```
kubectl -n kube-system set env daemonset/calico-node IP_AUTODETECTION_METHOD=can-reach=192.168.0.1
```

With `can-reach`, Calico uses the address the node would use to reach the given destination, here the router. That turns the guess into a question for the kernel's route table. A dry run of the lookup chose `.180`, `.105` and `.128`, the addresses each kernel really sent from. It was in place by Oct 13. <!-- TODO author: when did you apply it, and did you run it yourself? One sentence. -->

**The permanent fixes** were proposed on Oct 7 and not applied that day:

- one fixed LAN address per node;
- one DHCP client on the Pi (two default routes, with metrics 600 and 3003, suggested two were running);
- the kubelet's `--node-ip` pinned to the same address Calico uses;
- Docker's bridge moved off `172.17.0.0/16`, which overlapped the pod network.

There's no repo commit for this one. Every change in the story was on the cluster or the hosts.

The pin fixed the tunnel. It didn't fix the address the control plane itself depended on, and that is a later post.

## Takeaways
- **"BGP Established" describes the control plane.** Test the data plane: pod to pod, across every pair of nodes.
- **On a node with several interfaces, never leave Calico on `first-found`.** Pin `IP_AUTODETECTION_METHOD`, and give the kubelet the same address.
- **Counters on drop rules beat guessing.** Read them, send a test request, read them again.
- **Moving a pod is a workaround, not a diagnosis.**

---

Back to the story: *Onto real hardware*. The previous interlude is *nginx can't read its own config*, and the next chapter is *The real backup*.
