#!/usr/bin/env bash
#
# Restart the pi host process inside its tmux pane so it reloads the pinet
# extension, then bring the same session back with `pi --continue`.
#
# Safe to launch from *inside* the pi process being restarted, as long as it is
# detached — otherwise pi's death takes the script with it:
#
#   setsid nohup /root/pinet/scripts/restart-host.sh \
#     >>/var/log/pinet-host-restart.log 2>&1 </dev/null &
#
# It waits for the current turn to stop writing, stops the old pi, then types
# the resume command into the same pane (keeping that pane's env and TTY), and
# verifies both the new process and its coordinator registration.
#
# Overrides: TMUX_TARGET OLD_PID CWD RESUME_CMD GRACE_SECONDS SETTLE_SECONDS
#            MAX_WAIT_SECONDS PANE_PID PINET_SERVICE
# Flags:     --dry-run   resolve and report everything, change nothing
set -uo pipefail

TMUX_TARGET="${TMUX_TARGET:-}"
PANE_PID="${PANE_PID:-}"
OLD_PID="${OLD_PID:-}"
CWD_OVERRIDE="${CWD:-}"
RESUME_CMD="${RESUME_CMD:-pi --continue}"
GRACE_SECONDS="${GRACE_SECONDS:-12}"
SETTLE_SECONDS="${SETTLE_SECONDS:-3}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-60}"
PINET_SERVICE="${PINET_SERVICE:-pinet-coordinator}"
LOG_FILE="${LOG_FILE:-/var/log/pinet-host-restart.log}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '[pinet-restart %s] %s\n' "$(date -Is)" "$*"; }
die() { log "FATAL: $*"; exit 1; }
tmuxq() { tmux "$@" 2>/dev/null; }

exec 9>/tmp/pinet-restart.lock
flock -n 9 || die "another host restart is already in progress"
: >>"$LOG_FILE" 2>/dev/null || true

for tool in tmux pgrep flock; do command -v "$tool" >/dev/null || die "'$tool' not found"; done

# --- resolve and verify the tmux pane ---------------------------------------
if [ -z "$TMUX_TARGET" ]; then
  [ -n "${TMUX:-}" ] || die "TMUX_TARGET is unset and TMUX is not available"
  TMUX_TARGET="$(tmuxq display-message -p '#{session_name}:#{window_index}.#{pane_index}')"
fi
[ -n "$TMUX_TARGET" ] || die "could not determine the tmux target"

pane_pid="$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_pid}')"
[ -n "$pane_pid" ] || die "tmux target '$TMUX_TARGET' not found"
pane_cwd="$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_current_path}')"
pane_cmd="$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_current_command}')"
log "pane $TMUX_TARGET: pid=$pane_pid cmd=$pane_cmd cwd=$pane_cwd"

if [ -n "$PANE_PID" ] && [ "$pane_pid" != "$PANE_PID" ]; then
  die "pane pid $pane_pid does not match expected $PANE_PID"
fi
CWD="${CWD_OVERRIDE:-$pane_cwd}"
[ -d "$CWD" ] || die "working directory '$CWD' does not exist"

# --- resolve and verify the pi process --------------------------------------
pane_pi() { pgrep -P "$pane_pid" -x pi 2>/dev/null | head -n1; }

if [ -z "$OLD_PID" ]; then
  OLD_PID="$(pane_pi)"
fi
[ -n "$OLD_PID" ] || die "no 'pi' process found in pane $TMUX_TARGET (foreground: $pane_cmd)"
[ -r "/proc/$OLD_PID/comm" ] || die "pid $OLD_PID is not running"
[ "$(cat "/proc/$OLD_PID/comm")" = "pi" ] || die "pid $OLD_PID is '$(cat "/proc/$OLD_PID/comm" 2>/dev/null)', not pi"
[ "$(pane_pi)" = "$OLD_PID" ] || die "pid $OLD_PID is not the pi process of pane $TMUX_TARGET"
log "pi process to restart: pid=$OLD_PID"

# --- wait for the current turn to stop writing ------------------------------
session_file="${PI_SESSION_FILE:-}"
if [ -z "$session_file" ] || [ ! -f "$session_file" ]; then
  session_file="$(ls -1t "$HOME"/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -n1)"
fi
if [ -n "$session_file" ] && [ -f "$session_file" ]; then
  log "waiting for session to settle: $session_file"
  started=$(date +%s)
  while :; do
    now=$(date +%s)
    elapsed=$((now - started))
    mtime=$(stat -c %Y "$session_file" 2>/dev/null || echo "$now")
    idle=$((now - mtime))
    if [ "$elapsed" -ge "$GRACE_SECONDS" ] && [ "$idle" -ge "$SETTLE_SECONDS" ]; then
      log "session settled (elapsed ${elapsed}s, idle ${idle}s)"
      break
    fi
    if [ "$elapsed" -ge "$MAX_WAIT_SECONDS" ]; then
      log "settle wait capped at ${MAX_WAIT_SECONDS}s (idle ${idle}s); continuing"
      break
    fi
    sleep 1
  done
else
  log "no session file found; applying a fixed ${GRACE_SECONDS}s grace"
  sleep "$GRACE_SECONDS"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: would SIGTERM $OLD_PID, wait for pane $TMUX_TARGET to return to $pane_cmd-pane shell,"
  log "DRY RUN: then send '$RESUME_CMD' (cwd $CWD) and verify a new pi registers with $PINET_SERVICE"
  log "DRY RUN ok — nothing changed"
  exit 0
fi

restart_epoch=$(date +%s)

# --- stop the old host -------------------------------------------------------
log "sending SIGTERM to $OLD_PID"
kill -TERM "$OLD_PID" 2>/dev/null || log "warn: SIGTERM returned non-zero (already exiting?)"
for _ in $(seq 1 40); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$OLD_PID" 2>/dev/null; then
  log "still alive after 20s; escalating to SIGKILL"
  kill -KILL "$OLD_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.5; done
fi
kill -0 "$OLD_PID" 2>/dev/null && die "could not stop pid $OLD_PID"
log "old pi stopped"

# --- make sure the pane shell owns the foreground again ----------------------
fg="$pane_cmd"
for _ in $(seq 1 40); do
  fg="$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_current_command}')"
  if [ -n "$fg" ] && [ "$fg" != "pi" ]; then break; fi
  sleep 0.5
done
[ "$fg" != "pi" ] && [ -n "$fg" ] || die "pane $TMUX_TARGET did not return to its shell (foreground still '$fg')"
log "pane foreground is '$fg'"

# --- start the new host in the same pane ------------------------------------
tmuxq send-keys -t "$TMUX_TARGET" C-u
sleep 0.3
tmuxq send-keys -t "$TMUX_TARGET" -- "$RESUME_CMD"
sleep 0.3
tmuxq send-keys -t "$TMUX_TARGET" Enter
log "sent resume command: $RESUME_CMD"

# --- verify a new pi process is running -------------------------------------
new_pid=""
for _ in $(seq 1 40); do
  candidate="$(pane_pi)"
  if [ -n "$candidate" ] && [ "$candidate" != "$OLD_PID" ]; then new_pid="$candidate"; break; fi
  sleep 0.5
done

# Fallback: if the pty was left unusable (e.g. we had to SIGKILL), respawn the
# pane — that resets the terminal. After a respawn the pane root *is* pi.
if [ -z "$new_pid" ]; then
  log "no new pi child after 20s; falling back to 'tmux respawn-pane' (resets the pty)"
  tmuxq respawn-pane -k -t "$TMUX_TARGET" -c "$CWD" "$RESUME_CMD"
  for _ in $(seq 1 60); do
    if [ "$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_current_command}')" = "pi" ]; then
      new_pid="$(tmuxq display-message -p -t "$TMUX_TARGET" '#{pane_pid}')"
      break
    fi
    sleep 0.5
  done
fi
[ -n "$new_pid" ] || die "no new pi process appeared in pane $TMUX_TARGET"
log "new pi running: pid=$new_pid cmd=$(tr '\0' ' ' < "/proc/$new_pid/cmdline" 2>/dev/null)"

# --- verify it reached the coordinator --------------------------------------
if command -v journalctl >/dev/null && systemctl is-active --quiet "$PINET_SERVICE" 2>/dev/null; then
  registered=0
  for _ in $(seq 1 60); do
    if journalctl -u "$PINET_SERVICE" --since "@$restart_epoch" --no-pager 2>/dev/null | grep -q "host connected"; then
      registered=1
      break
    fi
    sleep 1
  done
  if [ "$registered" = "1" ]; then
    log "coordinator reports:"
    journalctl -u "$PINET_SERVICE" --since "@$restart_epoch" --no-pager 2>/dev/null | grep -E "host connected|controller connected" | tail -3
  else
    log "warn: no 'host connected' seen within 60s; check the pi pane and $PINET_SERVICE"
  fi
else
  log "service '$PINET_SERVICE' not active; skipping the registration check"
fi

log "DONE — pi restarted (old=$OLD_PID new=$new_pid); session resumed via '$RESUME_CMD'"
