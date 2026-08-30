# Creating VMs

Scripts to spin up throwaway/dev VMs without clicking through a GUI each time.

## Naming convention

```
create-vm.<provider>.<ext>
```

The **provider is in the filename** — you run the file for the hypervisor you have,
no flags to remember and no dispatcher to think about. Each script is written in
that provider's natural language: **bash** for the Linux-only ones, **PowerShell**
(`.ps1`) for providers that also run on Windows.

| Script | Provider | Runs on | Status |
|---|---|---|---|
| `create-vm.virt-manager.sh` | libvirt / KVM (what virt-manager drives) | Linux | ✅ |
| `create-vm.gnome-boxes.sh` | GNOME Boxes (libvirt) | Linux | planned |
| `create-vm.virtualbox.ps1` | Oracle VirtualBox (`VBoxManage`) | Windows / Linux / macOS | planned |

All variants aim to take the **same arguments** (`--name --user --image --cpu --ram
--disk`) and produce the same thing: a minimal, unmodified Ubuntu cloud image with
your Launchpad SSH keys imported and nothing else installed — a clean base to
`deploy/remote-deploy.sh` onto.

## create-vm.virt-manager.sh

Minimal Ubuntu **cloud image** under libvirt/KVM. cloud-init only creates the login
user, imports its SSH keys from Launchpad (`lp:<id>`), sets the hostname, and
disables password SSH — no package updates, no extra installs.

```bash
deploy/vm/create-vm.virt-manager.sh \
  --name mon-eu --user dev \
  --image https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img \
  --cpu 2 --ram 2048 --disk 20
```

- **Required:** `--name`, `--user`, `--image` (a local path *or* an `https` URL to
  an Ubuntu **cloud** image — the `-cloudimg-amd64.img`, not the installer ISO;
  URLs are downloaded once and cached under `~/.cache/monitors-vm/`).
- **Optional:** `--launchpad <id>` (SSH-key source, default `--user`), `--cpu` (2),
  `--ram` MB (2048), `--disk` GB (20), `--os-variant` (`ubuntu24.04`; see
  `osinfo-query os`).
- **Env overrides:** `IMAGES_DIR` (default `/var/lib/libvirt/images`),
  `LIBVIRT_NETWORK` (default `default`).

It prints the DHCP-assigned IP and the exact `dev.env` lines to deploy onto it.

### Prerequisites (one-time)

```bash
sudo apt install -y virtinst qemu-utils libvirt-clients cloud-image-utils genisoimage
sudo usermod -aG libvirt,kvm "$USER"   # then log out/in
```

`sudo` is used only to place the VM disk in the libvirt images pool; `virt-install`
itself runs as you (via the `libvirt` group). Your **public** SSH key must be on
your Launchpad account (Launchpad → *SSH keys*) so `lp:<id>` can fetch it.

### Gotchas

- **`--launchpad` must be your real Launchpad id, not your local username.** The VM
  is key-only; if `lp:<id>` has no keys, the login user has no way in and you're
  locked out. The script pre-checks `https://launchpad.net/~<id>/+sshkeys` and
  refuses to build if it's empty. Your public key must be on your Launchpad account.
- **"Too many authentication failures" on SSH** even with the right keys imported:
  your SSH client is offering many keys and the server cuts you off (`MaxAuthTries`)
  before the right one. Pin it — the script prints this line for you:
  `ssh -o IdentitiesOnly=yes -i ~/.ssh/<key> <user>@<ip>`.
- **Black graphical console in virt-manager is normal** — the VM is headless
  (`--graphics none`). Use `virsh console <name>` (Ctrl-] to exit) for a terminal.

### Manage / tear down

```bash
virsh list --all                       # see VMs
virsh domifaddr <name> --source lease  # its IP
virsh console <name>                    # console (Ctrl-] to exit)

deploy/vm/destroy-vm.virt-manager.sh <name>          # force off + undefine + delete disks
deploy/vm/destroy-vm.virt-manager.sh <name> --yes    # no confirmation prompt
```

### Power the whole set on/off (free their RAM)

`vms.virt-manager.sh` acts on every VM whose name starts with `mon-` (leaving
other VMs alone), so you can suspend the dev stack when you're not using it:

```
deploy/vm/vms.virt-manager.sh up        # start them all (PocketBase first)
deploy/vm/vms.virt-manager.sh down      # graceful shutdown of the running ones
deploy/vm/vms.virt-manager.sh status    # name · state · RAM (+ running total)
```

