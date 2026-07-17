#!/usr/bin/env bash
# Faerber Client OS — daily full sync
# Runs: Stripe → Conversations → Trainerize refresh → Churn scoring
# Schedule via cron (or launchd). Logs to /tmp/faerber-client-os-{date}.log

set -e
cd "/Users/zachef/Desktop/Playground - Claude/scripts/faerber-client-os"
PY=".venv/bin/python"
DATE=$(date +%F)
LOG="/tmp/faerber-client-os-${DATE}.log"

echo "=== $(date -Iseconds) — Faerber Client OS daily sync ===" > "$LOG"

echo "" >> "$LOG"
echo "── [1/4] Stripe (all 3 accounts) ──" | tee -a "$LOG"
$PY -u sync_stripe.py 2>&1 | tee -a "$LOG"

echo "" >> "$LOG"
echo "── [2/4] Trainerize conversations (last 7d) ──" | tee -a "$LOG"
$PY -u sync_conversations.py --days 7 2>&1 | tee -a "$LOG"

echo "" >> "$LOG"
echo "── [3/4] Trainerize data refresh (existing sync_all.py) ──" | tee -a "$LOG"
if [ -f "sync_all.py" ]; then
  $PY -u sync_all.py --skip-recs 2>&1 | tee -a "$LOG"
fi

echo "" >> "$LOG"
echo "── [4/4] Churn risk scoring ──" | tee -a "$LOG"
$PY -u compute_churn_risk.py 2>&1 | tee -a "$LOG"

echo "" >> "$LOG"
echo "=== $(date -Iseconds) — DONE ===" | tee -a "$LOG"

# Rotate old logs (keep 14 days)
find /tmp -maxdepth 1 -name "faerber-client-os-*.log" -mtime +14 -delete 2>/dev/null || true
