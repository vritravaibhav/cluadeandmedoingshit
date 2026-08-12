#!/bin/bash
# watch.sh — run one crawl slice, safely, from cron.
#
# Deliberately plain shell + node: no model is involved, so this consumes zero
# Claude usage no matter how often it fires. That is the point — the crawl keeps
# making progress whether or not a session is open.
#
# Guards:
#   - a lock directory, so a slow run can never overlap the next cron tick
#     (mkdir is atomic on macOS; flock is not available)
#   - a stale-lock breaker, so one killed run does not wedge the schedule
#   - PATH fixed up, because cron gets a minimal environment without node
#
# Install (every 15 minutes):
#   crontab -l 2>/dev/null | grep -v 'india/watch.sh' > /tmp/ct
#   echo "*/15 * * * * /Users/longfloat/deletelater/jobs/india/watch.sh" >> /tmp/ct
#   crontab /tmp/ct

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK="$DIR/.crawl.lock"
LOG="$DIR/watch.log"
BUDGET="${1:-60}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# break a lock left behind by a killed run (older than 30 minutes)
if [ -d "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    echo "$(date '+%F %T')  breaking stale lock" >> "$LOG"
    rm -rf "$LOCK"
  else
    echo "$(date '+%F %T')  previous run still going — skipping this tick" >> "$LOG"
    exit 0
  fi
fi

mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rm -rf "$LOCK"' EXIT INT TERM

cd "$DIR" || exit 1
echo "$(date '+%F %T')  tick (budget ${BUDGET} pages)" >> "$LOG"
node crawl.js --budget="$BUDGET" --push >> "$LOG" 2>&1
echo "$(date '+%F %T')  done — $(node crawl.js --status | head -1)" >> "$LOG"
