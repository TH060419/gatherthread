# Alibaba Cloud ECS deployment: 0.1.0-alpha.8 preview

This unreleased source profile keeps the application on `127.0.0.1:18787` and Caddy on public 80/443. Never open 18787. User signup requires approved verified-email providers and remains closed by default. The live Alpha has not switched to this branch. These commands are for a reviewed future deployment, not a reinstall of the running host.

## 1. Prerequisites

- An Alibaba Cloud mainland-China ECS instance with a fixed public IPv4 address and Ubuntu 22.04 or 24.04. The supported starting profile is at least 2 vCPU and 2 GiB memory, with separate capacity headroom for the database and backups.
- A verified domain with an A record for the ECS public IP.
- Complete the required ICP filing before opening a Web service on a mainland-China instance. Alibaba Cloud states that a domain pointing to a mainland server must be filed through the actual access provider regardless of port or use; follow the current [Alibaba Cloud filing guide](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview) and the rules for the filing owner's province.
- Security-group ingress: TCP 22 from fixed administrator addresses only, TCP 80/443 for intended users, and no rule for 18787. See the [Alibaba Cloud ECS security-group guide](https://help.aliyun.com/zh/ecs/user-guide/start-using-security-groups).
- A local `v0.1.0-alpha.8` preview commit or archive that has passed `npm run release:verify`.

Before filing approval, system installation and loopback checks may be prepared, but do not point the domain at the instance or open public Web ingress.

## 2. Upload the candidate

Upload the candidate archive as `/tmp/gatherthread-0.1.0-alpha.8.tar.gz`, then run on the ECS host:

```sh
sudo install -d -m 0755 /opt/gatherthread/releases/0.1.0-alpha.8
sudo tar -xzf /tmp/gatherthread-0.1.0-alpha.8.tar.gz \
  -C /opt/gatherthread/releases/0.1.0-alpha.8 --strip-components=1
cd /opt/gatherthread/releases/0.1.0-alpha.8
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

## 4. Configure email registration and password recovery

User accounts register with a verified email address and a self-set password, then sign in with email and password. All new accounts can create projects under the current Alpha roles and resource rules. Registration is closed by default; existing email/password login remains available while signup is disabled or paused. Email-code password recovery is implemented but stays closed by default behind the independent `GATHERTHREAD_PASSWORD_RECOVERY` switch. Follow the [password recovery preflight](OPERATIONS.md#password-recovery-preflight-unreleased) for provider configuration and rollout validation before enabling it; registration may remain closed. A completed reset retains projects and roles but revokes all signed-in devices and Agent authorizations, so users must sign in and authorize their Agents again. No user access token is displayed or saved. Follow [OPERATIONS](OPERATIONS.md) for provider setup and enablement gates. A project owner creates a single-use `gti_` invitation granting `participant` or `viewer` membership. Recipients register or sign in first, then accept it from the workspace. Acceptance does not create an account, issue a user credential or change project-creation capability. Owners choose one hour, 24 hours or seven days, with 24 hours as the default. Each additional Agent/device uses its own short-lived authorization or browser-approved DSH pairing; connector/device tokens, Cookie sessions and independent revocation remain supported. This unreleased branch replaces user token login, test qualification activation and invitation-created guest accounts. Their HTTP endpoints return `410 account_flow_retired`; local bootstrap/qualification issuance commands and the public application template are removed. Historical database rows are retained without account inheritance, merging or password enrollment. Old user Cookies cannot authenticate the Web app; independently authorized native Agent/device credentials remain separate and revocable. This source change performs no production cleanup or deployment.

## 5. Preflight and smoke test

```sh
sudo deploy/aliyun-ecs/preflight.sh gatherthread.example.com
sudo systemctl start gatherthread-backup.service
sudo journalctl -u gatherthread -n 100 --no-pager
```

Every preflight check must pass: candidate version, systemd, Caddy, loopback liveness, SQLite WAL/foreign-key/write readiness, public HTTPS, HSTS, listener boundary, private permissions, and database integrity. Then use two independent browsers to create a project, issue and claim an invitation, chat in Multi, request a local Agent, disconnect, reconnect, and replay the missing history.

## 6. Operations

```sh
sudo systemctl status gatherthread caddy gatherthread-backup.timer gatherthread-retention.timer gatherthread-code-retention.timer gatherthread-log-retention.timer
sudo journalctl -u gatherthread -f
sudo ls -lh /var/backups/gatherthread
curl -fsS http://127.0.0.1:18787/health/ready
```

The database is `/var/lib/gatherthread/collaboration.sqlite`; configuration and the credential pepper are in `/etc/gatherthread/gatherthread.env`. Independent retention timers prune backup sets and unreachable/deleted cloud Git after 13 days, and rotate/vacuum host journals after 29 days. These margins target the published 14/30-day maxima; verify actual timer success and alert on failures. If cloud Git repositories exist, each SQLite backup has a matching `.db.code` companion: verify, move off-host, restore, and rotate them together. Apply the same expiry to off-host copies, restore drills, provider snapshots, Caddy access logs, and any log exports. Copy encrypted backup sets and the pepper separately to another failure domain, or device credentials cannot be verified after total host loss. Before restoring an older backup, reapply subsequent account/content deletions from an independent restricted deletion register; never resurrect deleted accounts.

## 7. Upgrade and rollback

Use a new `/opt/gatherthread/releases/<version>` for every upgrade; never overwrite an old release:

1. Run current preflight and create a verified online backup.
2. Upload and verify the new candidate, then run its reviewed installer. Check backup, backup-retention, code-retention, and log-retention units and timers, and confirm `systemctl daemon-reload` completed; a release symlink switch alone does not refresh installed units.
3. Repeat preflight and the two-browser smoke test.
4. Repoint `/opt/gatherthread/current` to old code only if it supports the resulting database schema. Otherwise stop the service and restore the verified pre-upgrade backup to a new database path.

Restore is an operator-approved destructive procedure. Follow [OPERATIONS.md](OPERATIONS.md), preserving the original database, WAL, and SHM as restricted evidence rather than overwriting them.

## Alpha limitations

This is one Node.js process with one SQLite database. It has no automatic failover, horizontal scaling, public registration, attachment storage, automated content-retention worker, or token-level Agent streaming. Keep any later preview small and invitation-only, and alert on ECS disk/memory pressure, certificate expiry, service exit, backup failure, and database-integrity failure.
