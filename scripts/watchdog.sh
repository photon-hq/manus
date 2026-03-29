#!/usr/bin/env sh
set -eu

SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"
CPU_THRESHOLD="${CPU_THRESHOLD:-80}"
MEM_THRESHOLD="${MEM_THRESHOLD:-80}"
DISK_THRESHOLD="${DISK_THRESHOLD:-85}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-300}"
COOLDOWN_FILE="/tmp/watchdog-cooldown"

if [ -z "$SLACK_WEBHOOK_URL" ]; then
  echo "SLACK_WEBHOOK_URL not set — exiting"
  exit 1
fi

apk add --no-cache ca-certificates > /dev/null 2>&1 || true

echo "Watchdog started — checking every ${CHECK_INTERVAL}s"
echo "Thresholds: CPU=${CPU_THRESHOLD}% MEM=${MEM_THRESHOLD}% DISK=${DISK_THRESHOLD}%"

should_alert() {
  key="$1"
  now=$(date +%s)
  if [ -f "$COOLDOWN_FILE" ] && grep -q "^${key}=" "$COOLDOWN_FILE" 2>/dev/null; then
    last=$(grep "^${key}=" "$COOLDOWN_FILE" | head -1 | cut -d= -f2)
    elapsed=$((now - last))
    if [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
      return 1
    fi
  fi
  sed -i "/^${key}=/d" "$COOLDOWN_FILE" 2>/dev/null || true
  echo "${key}=${now}" >> "$COOLDOWN_FILE"
  return 0
}

send_slack() {
  text="$1"
  response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"text\": \"$text\"}" 2>&1) || true
  if [ "$response" != "200" ]; then
    echo "  [warn] Slack post failed (HTTP $response)"
  fi
}

strip_ansi() {
  sed 's/\x1b\[[0-9;]*m//g'
}

send_slack ":white_check_mark: *Manus Watchdog* is online — checking every ${CHECK_INTERVAL}s"

while true; do
  alerts=""

  # --- Container health via Docker socket (matches partial names) -------------
  containers_json=$(curl -sf --unix-socket /var/run/docker.sock \
    "http://localhost/containers/json?all=true" 2>/dev/null || echo "[]")

  for svc in backend worker postgres redis; do
    found=$(echo "$containers_json" | grep -i "$svc" | grep -v "watchdog" || true)
    if [ -z "$found" ]; then
      if should_alert "down-${svc}"; then
        alerts="${alerts}:skull: *${svc}* container is not running\n"
      fi
      continue
    fi

    unhealthy=$(echo "$found" | grep -i "unhealthy" || true)
    if [ -n "$unhealthy" ]; then
      if should_alert "health-${svc}"; then
        alerts="${alerts}:red_circle: *${svc}* is unhealthy\n"
      fi
    fi
  done

  # --- Resource usage via docker stats ----------------------------------------
  stats=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' 2>/dev/null | strip_ansi | grep -v "watchdog" || true)
  if [ -n "$stats" ]; then
    echo "$stats" | while IFS= read -r line; do
      [ -z "$line" ] && continue
      name=$(echo "$line" | awk '{print $1}')
      cpu_raw=$(echo "$line" | awk '{print $2}' | tr -d '%')
      mem_raw=$(echo "$line" | awk '{print $3}' | tr -d '%')

      cpu=${cpu_raw%%.*}
      mem=${mem_raw%%.*}

      if [ "$cpu" -gt "$CPU_THRESHOLD" ] 2>/dev/null; then
        if should_alert "cpu-${name}"; then
          send_slack ":fire: *${name}* CPU at ${cpu_raw}% (threshold: ${CPU_THRESHOLD}%)"
        fi
      fi

      if [ "$mem" -gt "$MEM_THRESHOLD" ] 2>/dev/null; then
        if should_alert "mem-${name}"; then
          send_slack ":warning: *${name}* memory at ${mem_raw}% (threshold: ${MEM_THRESHOLD}%)"
        fi
      fi
    done
  fi

  # --- Disk usage -------------------------------------------------------------
  disk_usage=$(df /host-root 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%' || echo "0")
  if [ "$disk_usage" -gt "$DISK_THRESHOLD" ] 2>/dev/null; then
    if should_alert "disk"; then
      alerts="${alerts}:floppy_disk: Disk at ${disk_usage}% (threshold: ${DISK_THRESHOLD}%)\n"
    fi
  fi

  # --- Send consolidated alert for health/disk --------------------------------
  if [ -n "$alerts" ]; then
    message=":rotating_light: *Manus Watchdog Alert*\n\n${alerts}"
    send_slack "$message"
    echo "[$(date)] Alerts sent to Slack"
  else
    echo "[$(date)] All clear"
  fi

  sleep "$CHECK_INTERVAL"
done
