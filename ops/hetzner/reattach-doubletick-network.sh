#!/bin/bash
# Re-attach the openclaw container to its extra docker networks after every (re)start.
# systemd ExecStartPre recreates the container and `docker run` only joins the default bridge, so without this:
#   - Caddy proxy (doubletick.viannejewels.com -> openclaw:8788) 502s, and
#   - openclaw can't reach self-hosted SearXNG (http://searxng:8080).
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' openclaw 2>/dev/null)" = "true" ] && break
  sleep 1
done
docker network connect openclaw-public openclaw 2>/dev/null || true
docker network connect searxng-net  openclaw 2>/dev/null || true
exit 0
