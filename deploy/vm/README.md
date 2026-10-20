# A throwaway VM lab

Real separate hosts, with separate clocks, on your own machine — which is the
only way to test the things that only go wrong across hosts: roster sharding,
takeover after a host dies, hardening that could lock you out.

`deploy/vm/vmlab.sh` is a thin wrapper. The lab itself is the `vmlab` module of
[LytronHQ/ops](https://github.com/LytronHQ/ops), which is **not** in this repo: the
wrapper fetches it into `deploy/.ops/` from the release pinned in
[`../ops.lock`](../ops.lock), verifies its SHA256, and hands over. So the command
above works from a fresh clone, and the first run needs a network.

Do not edit the fetched copy — `deploy/ops-fetch.sh` replaces anything whose hash
does not match. Send the change to ops, cut a release, and bump the lock.

Every option is documented by `deploy/vm/vmlab.sh --help` and in the module's
own README. The rest of this file is the nabz-specific part.

## The usual run

```bash
deploy/vm/vmlab.sh create     # db, app1, app2, app3 — boots them, prints addresses
deploy/vm/vmlab.sh ips        # name -> address
deploy/vm/vmlab.sh status
deploy/vm/vmlab.sh destroy --all
```

Point a `NODES` block at the printed addresses and run `deploy/remote-deploy.sh`.
The guests need nothing pre-installed — `setup-worker.sh` installs Docker itself.
Two `worker` lines with the **same zone** is the multi-worker case, on genuinely
separate hosts with separate clocks:

```
pocketbase 192.168.122.231
worker     192.168.122.44  eu
worker     192.168.122.221 eu
evaluator  192.168.122.229 eu
```

Costs about 700 MB of disk for the whole lab (thin overlays on one shared base)
and roughly 6 GB of RAM.

## Which script for which job

| If you want | Then |
|---|---|
| a lab to deploy the fleet onto and then throw away | `vmlab.sh create` |
| one VM that stays | `vmlab.sh create --name <name> --memory … --disk …` |
| a real cloud node | [`../hetzner/provision.sh`](../hetzner/provision.sh) — same shape, against Hetzner |

There is no `sudo` anywhere in `vmlab.sh`, and that is deliberate rather than
tidy: `sudo` is interactive, so a script — or an agent — cannot use it
unattended at all. An unprivileged account in the `libvirt` group, with an ACL
on `/dev/kvm` and libvirt's `default` network up, can build VMs without it. That
is why this repo does not use `virt-install`.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `create` fails on permissions | your account is not in `libvirt`, or `/dev/kvm` has no ACL | `sudo usermod -aG libvirt $USER` then log out and in; `sudo setfacl -m u:$USER:rw /dev/kvm` |
| VMs boot but `ips` prints nothing | libvirt's `default` network is down | `virsh net-start default` |
| SSH offers a changed host key | an address was reused by a new lab | `create` clears the keys it knows about; for a stray one, `ssh-keygen -R <address>` |
| a VM is left behind after `destroy` | it was made with a different `--prefix` | `virsh list --all`, then `vmlab.sh destroy --name <name> --prefix <p>` |
