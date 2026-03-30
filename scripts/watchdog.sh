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

STARTUP_DELAY="${STARTUP_DELAY:-120}"
echo "Watchdog waiting ${STARTUP_DELAY}s for containers to start..."
sleep "$STARTUP_DELAY"

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

# Debug: show what containers we can see
all_containers=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
echo "Visible containers: $all_containers"

send_slack ":white_check_mark: *Manus Watchdog* is online — checking every ${CHECK_INTERVAL}s"

while true; do
  alerts=""

  # --- Container health using docker ps directly -----------------------------
  running=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | strip_ansi || true)

  for svc in backend worker postgres redis; do
    svc_line=$(echo "$running" | grep -i "$svc" | grep -v "watchdog" | head -1 || true)
    if [ -z "$svc_line" ]; then
      if should_alert "down-${svc}"; then
        alerts="${alerts}:skull: *${svc}* container is not running\n"
      fi
      continue
    fi

    if echo "$svc_line" | grep -qi "unhealthy"; then
      if should_alert "health-${svc}"; then
        alerts="${alerts}:red_circle: *${svc}* is unhealthy\n"
      fi
    fi
  done

  # --- Resource usage (only manus project containers) -------------------------
  stats=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' 2>/dev/null | strip_ansi | grep -v "watchdog" || true)
  if [ -n "$stats" ]; then
    echo "$stats" | grep -i "manus" | while IFS= read -r line; do
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

  # --- Disk usage (via Docker system info) ------------------------------------
  disk_usage=$(docker system df 2>/dev/null | grep "Images" | grep -oE '[0-9]+%' | tail -1 | tr -d '%' || echo "0")
  # Fallback: check the container's own root partition
  if [ "$disk_usage" = "0" ] || [ -z "$disk_usage" ]; then
    disk_usage=$(df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%' || echo "0")
  fi
  if [ "$disk_usage" -gt "$DISK_THRESHOLD" ] 2>/dev/null; then
    if should_alert "disk"; then
      alerts="${alerts}:floppy_disk: Disk at ${disk_usage}% (threshold: ${DISK_THRESHOLD}%)\n"
    fi
  fi

  # --- Send consolidated alert ------------------------------------------------
  if [ -n "$alerts" ]; then
    message=":rotating_light: *Manus Watchdog Alert*\n\n${alerts}"
    send_slack "$message"
    echo "[$(date)] Alerts sent to Slack"
  else
    echo "[$(date)] All clear"
  fi

  sleep "$CHECK_INTERVAL"
done
