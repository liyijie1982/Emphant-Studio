---
name: linux-server-ops
description: Inspect and manage multiple Linux servers through SSH or controlled terminal commands. Use when asked to perform Linux operations, fleet health checks, incident triage, service/log inspection, capacity analysis, package/configuration planning, or any task involving multiple remote servers.
---

# Linux Server Ops

## Core Workflow

1. Identify the target hosts, access method, environment, and objective from the user request. For single-host read-only questions, do not over-ask; run a fail-fast probe when the runtime supports it.
2. Default to read-only inspection commands. Treat read-only commands such as `docker ps`, `systemctl status`, `df -h`, `uptime`, and SSH reachability probes as low risk that do not need extra confirmation. Treat all state-changing commands as gated changes.
3. For each host, record command intent, command text, exit code, key output, and observed risk.
4. Summarize by severity: critical outages, capacity risks, security exposure, degraded services, and unknowns.
5. Before any change, provide the exact command plan, impact, rollback, and verification steps. Wait for explicit user approval.

## Connection Pattern

Prefer a user-provided inventory or host list. If the user supplied a host but not a username, first try or suggest the minimum non-interactive SSH probe using the host as given; if that cannot work, ask only for the SSH username or configured host alias.

Use SSH options that fail fast and avoid interactive hangs:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 user@host 'hostname && uptime'
```

Never print or store passwords, private keys, tokens, or cloud credentials. If the runtime provides a controlled SSH tool that accepts a password for the current request, use it for read-only checks and redact the credential from all output.

Do not delegate to another agent. Do not create scripts, PDFs, checklists, or other files unless the user explicitly asks for an artifact.

## Read-Only Checks

For fleet health, cover these areas when relevant:

- Identity and reachability: `hostname`, `whoami`, `uptime`, SSH exit code.
- OS and kernel: `/etc/os-release`, `uname -a`.
- Load and CPU: `uptime`, `top -bn1`, `mpstat` when available.
- Memory: `free -h`, `vmstat 1 5`.
- Disk and inode pressure: `df -h`, `df -ih`, `lsblk`.
- Services: `systemctl --failed`, `systemctl status <service> --no-pager`.
- Logs: `journalctl -p warning..alert --since "2 hours ago" --no-pager`.
- Network: `ss -tulpn`, `ip addr`, `ip route`, DNS checks when relevant.
- Security posture: logged-in users, recent auth failures, open ports, pending updates.

Load detailed command examples only when needed: [references/checklists.md](references/checklists.md).

## Change Safety

Classify a command as state-changing if it uses `sudo`, writes files, edits configs, restarts services, installs packages, changes firewall rules, deletes data, modifies databases, rotates certificates, or changes users/permissions.

For state-changing work, respond with:

- Goal and affected hosts.
- Exact commands to run.
- Expected impact and downtime risk.
- Backup or rollback plan.
- Verification commands.
- A clear approval request.

After approval, execute in batches when multiple hosts are involved. Start with one canary host unless the user explicitly asks for all hosts at once.

## Output Format

Keep operational reports compact and evidence-based:

```text
Fleet status: OK / Degraded / Critical

Host: app-01
Risk: High
Evidence:
- load average 18.2 on 4 vCPU
- /var at 94%
Actions:
- inspect top processes
- rotate or clean application logs after approval
```

When a command fails, include the exit code and the smallest useful stderr excerpt.

Avoid filler: do not restate the user's goal, explain tool availability, ask confirmation for read-only checks, offer PDFs/scripts/checklists, or include generic security disclaimers unless directly relevant to a failure or user request.
