# Hetzner host ops (production OpenClaw box: 5.78.224.100)

Canonical copies of the host-side scripts and systemd units that run the production
OpenClaw deployment on the Hetzner box. The box is the runtime; THIS REPO is the
source of truth. If you change a file on the box, commit it here.

| File | Lives on box at | Purpose |
|---|---|---|
| update.sh | /opt/openclaw/update.sh | Manual version update: build, swap, health-gate, auto-rollback. NOTE: same-version rebuilds overwrite the rollback tag — `docker tag` the running image first. |
| oc-version-notify.sh | /opt/openclaw/ | Daily upstream-version Telegram notifier (04:30). |
| reattach-doubletick-network.sh | /opt/openclaw/ | ExecStartPost: re-attaches container to openclaw-public + searxng-net. |
| restart-openclaw-request.sh | /opt/openclaw/ | Gated restart helper. |
| crm-stale-notify.sh / crm-snapshot-rotate.sh | /opt/openclaw/ | CRM staleness alerter + snapshot rotation (14-day). |
| systemd/openclaw.service (+ drop-ins) | /etc/systemd/system/ | The unit: docker run, Restart=always, pids uncapped, loopback-only port. |

`ops/gati-direct/` is a repo snapshot of /data/workspace/scripts/gati-direct/ (the
@vjgati_bot fast-lookup patch the entrypoint re-applies at boot, fail-open).

Operational rules (hard-won, 2026-06-10): after ANY openclaw.json edit run
`systemctl restart openclaw` immediately (the config-watcher's in-place reload is
broken under the wrapper); `docker exec` heredocs need `-i`; finite cron toolsAllow
lists are fail-closed for codex runs (omit the list or use command-kind jobs).
