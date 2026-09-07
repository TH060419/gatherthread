# Alibaba Cloud ECS deployment: 0.1.0-alpha.2 preview

This profile prepares the private `0.1.0-alpha.2` preview for later server deployment. The official GatherThread service is not open yet. The application always listens on `127.0.0.1:8787`; Caddy is the only public listener on ports 80/443 and manages HTTPS. Never open port 8787 in the Alibaba Cloud security group. Anonymous registration is not implemented: create the first owner on the host and invite every later user with a single-use project invitation.

## 1. Prerequisites

- An Alibaba Cloud mainland-China ECS instance with a fixed public IPv4 address and Ubuntu 22.04 or 24.04. The supported starting profile is at least 2 vCPU and 2 GiB memory, with separate capacity headroom for the database and backups.
- A verified domain with an A record for the ECS public IP.
- Complete the required ICP filing before opening a Web service on a mainland-China instance. Alibaba Cloud states that a domain pointing to a mainland server must be filed through the actual access provider regardless of port or use; follow the current [Alibaba Cloud filing guide](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview) and the rules for the filing owner's province.
- Security-group ingress: TCP 22 from fixed administrator addresses only, TCP 80/443 for intended users, and no rule for 8787. See the [Alibaba Cloud ECS security-group guide](https://help.aliyun.com/zh/ecs/user-guide/start-using-security-groups).
- A local `v0.1.0-alpha.2` preview commit or archive that has passed `npm run release:verify`.

Before filing approval, system installation and loopback checks may be prepared, but do not point the domain at the instance or open public Web ingress.

## 2. Upload the candidate

Upload the candidate archive as `/tmp/gatherthread-0.1.0-alpha.2.tar.gz`, then run on the ECS host:

```sh
sudo install -d -m 0755 /opt/gatherthread/releases/0.1.0-alpha.2
sudo tar -xzf /tmp/gatherthread-0.1.0-alpha.2.tar.gz \
  -C /opt/gatherthread/releases/0.1.0-alpha.2 --strip-components=1
cd /opt/gatherthread/releases/0.1.0-alpha.2
```

After a Git tag exists, the exact tag may instead be cloned into the same path. The installer deliberately rejects temporary source paths and mismatched release metadata.

## 3. Install and start

After filing, DNS, and security-group readiness:

```sh
sudo deploy/aliyun-ecs/install.sh \
  --domain gatherthread.example.com \
  --acknowledge-private-alpha \
  --acknowledge-mainland-icp-ready
```

The installer downloads and checksum-verifies Node.js 24.16.0, installs Caddy, creates a non-login `gatherthread` user, builds with `npm ci`, writes a service-readable environment file, installs systemd/Caddy/daily SQLite-backup units, and atomically points `/opt/gatherthread/current` at this release. It never overwrites an existing `/etc/gatherthread/gatherthread.env`; a domain mismatch fails closed.

## 4. Create the first owner

Run once on the first deployment:

```sh
sudo deploy/aliyun-ecs/create-owner.sh \
  --display-name "Your display name" \
  --device-name "Server bootstrap"
```

The device token is shown once. Save it immediately in a password manager; never place it in chat, an issue, logs, or a URL. On first browser login, the owner may remember the device and later rename it in settings.

## 5. Preflight and smoke test

```sh
sudo deploy/aliyun-ecs/preflight.sh gatherthread.example.com
sudo systemctl start gatherthread-backup.service
sudo journalctl -u gatherthread -n 100 --no-pager
```

Every preflight check must pass: candidate version, systemd, Caddy, loopback liveness, SQLite WAL/foreign-key/write readiness, public HTTPS, HSTS, listener boundary, private permissions, and database integrity. Then use two independent browsers to create a project, issue and claim an invitation, chat in Multi, request a local Agent, disconnect, reconnect, and replay the missing history.

## 6. Operations

```sh
sudo systemctl status gatherthread caddy gatherthread-backup.timer
sudo journalctl -u gatherthread -f
sudo ls -lh /var/backups/gatherthread
curl -fsS http://127.0.0.1:8787/health/ready
```

The database is `/var/lib/gatherthread/collaboration.sqlite`; configuration and the credential pepper are in `/etc/gatherthread/gatherthread.env`. Daily backups are retained for 14 days. Copy encrypted database backups and the pepper separately to another failure domain, or device credentials cannot be verified after total host loss.

## 7. Upgrade and rollback

Use a new `/opt/gatherthread/releases/<version>` for every upgrade; never overwrite an old release:

1. Run current preflight and create a verified online backup.
2. Upload and verify the new candidate, then run its installer.
3. Repeat preflight and the two-browser smoke test.
4. Repoint `/opt/gatherthread/current` to old code only if it supports the resulting database schema. Otherwise stop the service and restore the verified pre-upgrade backup to a new database path.

Restore is an operator-approved destructive procedure. Follow [OPERATIONS.md](OPERATIONS.md), preserving the original database, WAL, and SHM as restricted evidence rather than overwriting them.

## Alpha limitations

This is one Node.js process with one SQLite database. It has no automatic failover, horizontal scaling, public registration, attachment storage, automated content-retention worker, token-level Agent streaming, or abandoned-claim recovery. Keep any later preview small and invitation-only, and alert on ECS disk/memory pressure, certificate expiry, service exit, backup failure, and database-integrity failure.
