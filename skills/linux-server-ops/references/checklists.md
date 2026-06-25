# Linux Operations Checklists

## Fleet Health

Use this sequence for read-only fleet checks:

```bash
hostname
date -Is
uptime
cat /etc/os-release | sed -n '1,6p'
uname -a
df -h
df -ih
free -h
systemctl --failed --no-pager
journalctl -p warning..alert --since "2 hours ago" --no-pager | tail -120
ss -tulpn
```

## Service Incident

For a named service:

```bash
systemctl status SERVICE --no-pager
systemctl is-enabled SERVICE
journalctl -u SERVICE --since "2 hours ago" --no-pager | tail -200
ps aux --sort=-%cpu | head -15
ps aux --sort=-%mem | head -15
```

Restarting a service is state-changing and requires approval.

## Disk Pressure

Read-only diagnosis:

```bash
df -h
df -ih
du -xhd1 /var 2>/dev/null | sort -h
find /var/log -type f -size +100M -printf '%s %p\n' 2>/dev/null | sort -n | tail -20
```

Deletion, truncation, log rotation, package cleanup, and filesystem resizing require approval.

## Security Quick Look

Read-only checks:

```bash
who
last -n 20
lastb -n 20 2>/dev/null || true
ss -tulpn
sudo -n true 2>/dev/null; echo "sudo_noninteractive=$?"
```

Do not expose secrets from shell history, environment files, process args, or application config. Mask suspected secret values before reporting.
