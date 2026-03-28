#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Manus container watchdog — alerts to Slack when resource usage is excessive
# Runs via cron, zero dependencies beyond docker + curl
# ---------------------------------------------------------------------------

SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-manus}"

# Thresholds (override via env)
CPU_THRESHOLD="${CPU_THRESHOLD:-80}"       # percent per container
MEM_THRESHOLD="${MEM_THRESHOLD:-80}"       # percent per container
DISK_THRESHOLD="${DISK_THRESHOLD:-85}"     # percent for docker root dir

COOLDOWN_FILE="/tmp/manus-watchdog-cooldown"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-300}" # 5 min between repeated alerts

if [[ -z "$SLACK_WEBHOOK_URL" ]]; then
  echo "SLACK_WEBHOOK_URL not set — exiting"
  exit 1
fi

# Rate-limit: don't spam the same alert within cooldown window
should_alert() {
  local key="$1"
  local now
  now=$(date +%s)
  if [[ -f "$COOLDOWN_FILE" ]] && grep -q "^${key}:" "$COOLDOWN_FILE" 2>/dev/null; then
    local last
    last=$(grep "^${key}:" "$COOLDOWN_FILE" | cut -d: -f2)
    if (( now - last < COOLDOWN_SECONDS )); then
      return 1
    fi
  fi
  grep -v "^${key}:" "$COOLDOWN_FILE" 2>/dev/null > "${COOLDOWN_FILE}.tmp" || true
  echo "${key}:${now}" >> "${COOLDOWN_FILE}.tmp"
  mv "${COOLDOWN_FILE}.tmp" "$COOLDOWN_FILE"
  return 0
}

send_slack() {
  local text="$1"
  curl -sf -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"text\": \"$text\"}" > /dev/null 2>&1 || true
}

alerts=""

# --- Check container health status -------------------------------------------
while IFS= read -r line; do
  name=$(echo "$line" | awk '{print $1}')
  status=$(echo "$line" | awk '{print $2}')
  if [[ "$status" == "unhealthy" ]]; then
    if should_alert "health-${name}"; then
      alerts+=":red_circle: *${name}* is unhealthy\n"
    fi
  fi
done < <(docker ps --filter "name=${COMPOSE_PROJECT}" --format '{{.Names}} {{.Status}}' | \
  awk '{
    name=$1;
    status="running";
    if ($0 ~ /unhealthy/) status="unhealthy";
    print name, status
  }')

# Check for expected containers that are missing entirely
expected_containers=("backend" "worker" "postgres" "redis")
running_containers=$(docker ps --filter "name=${COMPOSE_PROJECT}" --format '{{.Names}}' 2>/dev/null || true)
for svc in "${expected_containers[@]}"; do
  if ! echo "$running_containers" | grep -q "$svc"; then
    if should_alert "down-${svc}"; then
      alerts+=":skull: *${svc}* container is not running\n"
    fi
  fi
done

# --- Check resource usage ----------------------------------------------------
while IFS= read -r line; do
  name=$(echo "$line" | awk '{print $1}')
  cpu_raw=$(echo "$line" | awk '{print $2}' | tr -d '%')
  mem_raw=$(echo "$line" | awk '{print $3}' | tr -d '%')

  cpu=${cpu_raw%.*}
  mem=${mem_raw%.*}

  if (( cpu > CPU_THRESHOLD )); then
    if should_alert "cpu-${name}"; then
      alerts+=":fire: *${name}* CPU at ${cpu_raw}% (threshold: ${CPU_THRESHOLD}%)\n"
    fi
  fi

  if (( mem > MEM_THRESHOLD )); then
    if should_alert "mem-${name}"; then
      alerts+=":warning: *${name}* memory at ${mem_raw}% (threshold: ${MEM_THRESHOLD}%)\n"
    fi
  fi
done < <(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' 2>/dev/null | \
  grep "${COMPOSE_PROJECT}" || true)

# --- Check disk usage for Docker ---------------------------------------------
docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo "/var/lib/docker")
disk_usage=$(df "$docker_root" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
if [[ -n "$disk_usage" ]] && (( disk_usage > DISK_THRESHOLD )); then
  if should_alert "disk"; then
    alerts+=":floppy_disk: Docker disk at ${disk_usage}% (threshold: ${DISK_THRESHOLD}%)\n"
  fi
fi

# --- Send consolidated alert -------------------------------------------------
if [[ -n "$alerts" ]]; then
  message=":rotating_light: *Manus Watchdog Alert*\n\n${alerts}"
  send_slack "$message"
  echo "[$(date)] Alerts sent to Slack"
else
  echo "[$(date)] All clear"
fi
