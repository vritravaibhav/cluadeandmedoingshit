#!/bin/bash
# watch.sh — run one crawl slice, safely, from cron.
#
# Deliberately plain shell + node: no model is involved, so this consumes zero
# Claude usage no matter how often it fires. That is the point — the crawl keeps
# making progress whether or not a session is open.
#
# Overlap protection lives in crawl.js, NOT here. It used to be here, which was
# wrong twice over: a hand-run `node crawl.js` bypassed it entirely (two runs
# then clobbered each other's checkpoint and the crawl went backwards), and once
# crawl.js took the same lock itself this wrapper deadlocked against its own
# child. crawl.js owns the lock; this script just calls it.
#
# Guards kept here:
#   - PATH fixed up, because a scheduler gets a minimal environment without node
#
# Install (every 15 minutes):
#   crontab -l 2>/dev/null | grep -v 'india/watch.sh' > /tmp/ct
#   echo "*/15 * * * * /Users/longfloat/deletelater/jobs/india/watch.sh" >> /tmp/ct
#   crontab /tmp/ct

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/watch.log"
BUDGET="${1:-60}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$DIR" || exit 1
echo "$(date '+%F %T')  tick (budget ${BUDGET} pages)" >> "$LOG"
node crawl.js --budget="$BUDGET" --push >> "$LOG" 2>&1
echo "$(date '+%F %T')  done — $(node crawl.js --status | head -1)" >> "$LOG"
