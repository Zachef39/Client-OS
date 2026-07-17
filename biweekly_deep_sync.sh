#!/usr/bin/env bash
# Faerber Client OS — biweekly deep sync
# Runs the 1st and 15th of each month at 8 AM via cron
# OR triggered manually / via /faerber-deep-sync skill

set -e
cd "/Users/zachef/Desktop/Playground - Claude/scripts/faerber-client-os"
PY=".venv/bin/python"
DATE=$(date +%F)
LOG="/tmp/faerber-deep-sync-${DATE}.log"

banner() {
  echo "" | tee -a "$LOG"
  echo "═══════════════════════════════════════════" | tee -a "$LOG"
  echo "  $1" | tee -a "$LOG"
  echo "═══════════════════════════════════════════" | tee -a "$LOG"
}

echo "=== $(date -Iseconds) — Faerber Deep Sync START ===" > "$LOG"

banner "[1/9] Stripe — all 3 accounts (full sync)"
$PY -u sync_stripe.py 2>&1 | tee -a "$LOG" || echo "⚠ Stripe failed" | tee -a "$LOG"

banner "[2/9] Trainerize client roster + enrichment"
$PY -u enrich_all_clients.py 2>&1 | tee -a "$LOG" || echo "⚠ Enrichment failed" | tee -a "$LOG"

banner "[3/9] Trainerize conversations — FULL history"
$PY -u sync_conversations.py --days 0 2>&1 | tee -a "$LOG" || echo "⚠ Conversations failed" | tee -a "$LOG"

banner "[4/9] Trainerize data refresh (workouts, food, checkins, weights)"
if [ -f "sync_all.py" ]; then
  $PY -u sync_all.py --skip-recs 2>&1 | tee -a "$LOG" || echo "⚠ TZ data failed" | tee -a "$LOG"
fi

banner "[5/9] Monday.com Coach Board notes + updates"
$PY -u -c "
import os,json,requests
from dotenv import load_dotenv
load_dotenv('/Users/zachef/Desktop/Playground - Claude/.env')
q='''{boards(ids: 8896739421){items_page(limit: 250){items{id name column_values(ids: [\"text_mkpqvyd4\"]){text value} updates(limit: 100){id body text_body created_at}}}}}'''
r=requests.post('https://api.monday.com/v2',
  headers={'Authorization':os.environ['MONDAY_API_TOKEN'],'Content-Type':'application/json'},
  json={'query':q}, timeout=90)
items=r.json()['data']['boards'][0]['items_page']['items']
json.dump(items, open('/tmp/monday_full.json','w'))
print(f'items:{len(items)} updates:{sum(len(i.get(\"updates\") or []) for i in items)}')
" 2>&1 | tee -a "$LOG"
$PY -u backfill_monday.py 2>&1 | tee -a "$LOG" || echo "⚠ Monday backfill failed" | tee -a "$LOG"

banner "[6/9] Bloodwork PDF scan"
$PY -u backfill_bloodwork.py 2>&1 | tee -a "$LOG" || echo "⚠ Bloodwork scan failed" | tee -a "$LOG"

banner "[7/9] Claude extract — rules/symptoms/tags from latest checkins"
$PY -u backfill_claude_extract.py --concurrency 6 2>&1 | tee -a "$LOG" || echo "⚠ Claude extract failed" | tee -a "$LOG"

banner "[8/9] Churn risk scoring (fresh row per client)"
$PY -u compute_churn_risk.py 2>&1 | tee -a "$LOG" || echo "⚠ Churn failed" | tee -a "$LOG"

banner "[9/9] Summary"
$PY -u -c "
import os, requests
from dotenv import load_dotenv
load_dotenv('/Users/zachef/Desktop/Playground - Claude/.env')
K=os.environ.get('FAERBER_CLIENT_OS_SUPABASE_KEY','sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U')
H={'apikey':K,'Authorization':f'Bearer {K}','Prefer':'count=exact'}
tables=['clients','client_conversations','client_calls','client_notes','client_billing','client_wins','client_rules','client_tags','client_symptoms','client_churn_risk','client_bloodwork','client_medications','client_supplements','client_cycle_tracking','client_program_state','client_goals']
for t in tables:
    r=requests.head(f'https://sfuvqaoeuajsrvldoiek.supabase.co/rest/v1/{t}?select=id',headers={**H,'Range':'0-0'})
    print(f'  {t:28s} {r.headers.get(\"content-range\",\"?\").split(\"/\")[-1]}')
" 2>&1 | tee -a "$LOG"

echo "" >> "$LOG"
echo "=== $(date -Iseconds) — Faerber Deep Sync DONE ===" | tee -a "$LOG"

# Rotate old logs (keep 60 days)
find /tmp -maxdepth 1 -name "faerber-deep-sync-*.log" -mtime +60 -delete 2>/dev/null || true

# Notify via Slack (if webhook available)
if [ -n "$SLACK_WEBHOOK_URL" ]; then
  curl -s -X POST "$SLACK_WEBHOOK_URL" -H "Content-Type: application/json" \
    -d "{\"text\":\"✅ Faerber Deep Sync complete — $(date +%Y-%m-%d). See $LOG\"}" > /dev/null 2>&1
fi
