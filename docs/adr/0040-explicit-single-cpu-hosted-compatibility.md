# ADR-0040: Explicit single-CPU hosted compatibility

- Status: accepted for implementation; deployment-host activation remains gated
- Date: 2026-10-09

## Context

A Linux host may expose cgroup v2 `cpuset`, `memory` and `pids` while its `cpu`
controller remains attached to a host security service's v1 hierarchy. Rootless
Docker cannot apply the existing `--cpus` CFS quotas there. Removing those
arguments silently or disabling the host security service is not a compatible
deployment procedure.

## Decision

Keep the original quota path by default. Add a private, explicit operator choice
of one canonical online logical CPU index, with host concurrency one. That mode
uses `--cpuset-cpus` and a new required image entrypoint, not a Docker wrapper or
automatic retry. Before starting the harness, resolve the process's actual v2
cgroup and verify its effective singleton CPU range, finite memory and PID caps,
and zero swap. Missing or weaker controls refuse execution before model use.
Old images lacking this entrypoint cannot run in the new mode.

The host must retain a root-controlled common ancestor covering the application,
entire dedicated user manager, rootless daemon and all container scopes. Its
aggregate memory/PID budget and singleton CPU range remain outside delegated
control. The source's container guard does not certify this separate topology;
host acceptance must inspect actual membership and limits. Operational steps and
the narrow enforcement fixture are owned by
[the operator guide](../HOSTED_AGENT.md#single-cpu-cpuset-compatibility).

## Consequences

Cpuset limits execution width, not CFS time allocation or fairness; a task can
consume one logical CPU continuously. It does not create an exclusive core or
prove unchanged production responsiveness. CPU hotplug can change the effective
range and requires deployment monitoring. Existing memory/swap/PID/time limits,
private mounts, credential boundaries, accounting, cleanup and public APIs stay
unchanged. A reduced-capacity failure remains explicit, with no quota removal,
automatic resource expansion or provider replay. This local source candidate
does not install Docker, modify host services or activate a public cloud runner.

The strategy uses the documented
[systemd AllowedCPUs control](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml#L249)
and [hierarchical kernel cpuset constraint](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpuset).
It is not a replacement claim for Docker's unsupported CFS settings.
