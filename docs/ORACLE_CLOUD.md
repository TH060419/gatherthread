# Experimental Oracle Always Free deployment

This legacy alternative is retained for reference only. The current invitation-only Alpha runs on Alibaba Cloud ECS at `https://gatherthread.cn`; public registration and public Beta are not open. If this Oracle path is revived later, it keeps the GatherThread process on `127.0.0.1:18787` and places Caddy in front on public ports 80/443. It does **not** create an anonymous public service: GatherThread device credentials, one-use invitations, project roles, exact browser origins, secure cookies, one-use WebSocket tickets, and application rate limits still apply.

Direct Internet ingress expands the supported private Tailscale alpha threat boundary. The installer therefore requires an explicit `--acknowledge-experimental-public-ingress` flag. Do not use this path for sensitive or regulated data until the deployment has completed an external security review, restore drill, and multi-user field test.

## 1. Create the Oracle resources

In the Oracle Cloud Console, choose the home region carefully and create:

- One Ubuntu 24.04 Ampere A1 VM. Start with 1 OCPU and 6 GB memory; GatherThread itself is light, while source builds benefit from the memory.
- A 50 GB boot volume and one instance public IPv4 address. An ephemeral address remains attached while the instance exists; use a reserved address only after the Console cost estimate still shows zero for the intended account and region.
- A public subnet with an Internet gateway.
- Stateful ingress rules for TCP 80 and 443 from `0.0.0.0/0`, plus TCP 22 only from the administrator's current public IP. Do not add port 18787.
- An SSH public key generated and retained locally.

Always Free compute is available only in the tenancy's home region and capacity can be temporarily unavailable. Confirm that every selected resource is labelled **Always Free eligible**, the estimated monthly cost is zero, and billing alerts are enabled before creation. For testers in mainland China, compare reachability and latency to candidate nearby regions before committing the tenancy's home region; routes vary by ISP and the home-region choice controls where Always Free compute can be created. Oracle may reclaim idle Always Free compute, so this evaluation is not an SLA-backed production deployment.

Create a DNS `A` record such as `gatherthread.example.com` pointing to the instance public IPv4 address. Wait until the record resolves publicly. Caddy needs the public DNS name and inbound ports 80/443 to obtain and renew a trusted certificate.

## 2. Install GatherThread

Connect as the Ubuntu image's `ubuntu` account, install Git, and clone the exact release or reviewed commit into the fixed deployment path:

```bash
sudo apt-get update
sudo apt-get install -y git
sudo mkdir -p /opt/gatherthread
sudo git clone https://github.com/TH060419/gatherthread.git /opt/gatherthread/app
cd /opt/gatherthread/app
git rev-parse HEAD
sudo deploy/oracle-free/install.sh \
  --domain gatherthread.example.com \
  --acknowledge-experimental-public-ingress
```

The installer supports Ubuntu 22.04/24.04 on ARM64 or x86-64. It installs a checksum-verified pinned Node.js 24 binary and the official Caddy package, builds the lockfile-pinned application, creates a non-login `gatherthread` service account, writes a root-owned production environment, starts hardened systemd services, and enables a daily SQLite online-backup timer. Re-running it preserves the existing environment and authentication pepper; it refuses a different domain instead of silently invalidating credentials.

## 3. Verify before creating the owner

Run the complete host and public-path check:

```bash
sudo /opt/gatherthread/app/deploy/oracle-free/preflight.sh gatherthread.example.com
```

The preflight must show that the app listens only on loopback, local and public `/health` return SQLite `wal`, Caddy and the backup timer are active, and private paths have restrictive permissions. Also test from a second network that `https://gatherthread.example.com` opens while `http://PUBLIC_IP:18787` does not connect.

## 4. Create the first owner

Bootstrap writes directly to SQLite; there is no public bootstrap endpoint. The following command prints the first device credential once:

```bash
cd /opt/gatherthread/app
sudo -u gatherthread /usr/local/bin/node \
  --env-file=/etc/gatherthread/gatherthread.env \
  apps/server/dist/src/cli.js bootstrap \
  --display-name "Owner name" \
  --device-name "Owner device"
```

Store the credential in a password manager and enter it only on the exact HTTPS origin. Never put it in a URL, command argument, screenshot, log, or shared message.

## 5. Backups, updates, and rollback

The timer writes online SQLite backups to `/var/backups/gatherthread` on the VM. That protects against database-level failure but not loss of the Oracle account, region, instance, or boot volume. Copy encrypted backups off the VM and protect the matching `/etc/gatherthread/gatherthread.env` pepper separately. Verify and restore a backup before inviting testers.

Before an update, take and export a backup, record the current Git commit, then stop the service, check out a reviewed release, run `npm ci && npm run build`, and restart. Roll back by restoring the prior commit and, only when a schema change requires it, the matching verified database backup. Never overwrite the live database with a raw copy while WAL writes are active.

Useful checks:

```bash
sudo systemctl status gatherthread caddy gatherthread-backup.timer
sudo journalctl -u gatherthread -n 100 --no-pager
sudo systemctl start gatherthread-backup.service
sudo ls -l /var/backups/gatherthread
```

Oracle security lists and the instance firewall are separate layers. Keep both minimal, retain an SSH recovery path before changing either, and never publish the application port 18787.
