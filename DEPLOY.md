# Faerber Client OS — Railway Cloud Deploy Guide

Ship the Express server to Railway so `dash.faerberfitness.com` is always up,
auto-restarts on crash, and no laptop needs to be running.

---

## ⚡ TL;DR — 15 min from run to live

**Already done (Claude):**
- ✅ GitHub repo pushed: https://github.com/Zachef39/Client-OS
- ✅ Code refactored for cloud (PORT env var, LOCAL_ONLY guards, graceful shutdown)
- ✅ railway.toml + Dockerfile + .env.example + .gitignore

**Your 4 steps when back:**
1. **Railway** — you already signed up. Go to your dashboard.
2. **New Project → Deploy from GitHub** → pick `Client-OS` → let it start (build will fail once, that's OK)
3. **Variables tab** → paste env vars from `~/Desktop/Playground - Claude/.env` (list in `.env.example`). Redeploy.
4. **Settings → Domains** → add `dash.faerberfitness.com` → copy CNAME target → GHL DNS → add CNAME record → done.

Detailed walkthrough below.

---

## What ships to the cloud

- Express server (`server/server.js`) + all `/api/v2/*` endpoints
- Static dashboard at `/v2/` (bento CEO dashboard) and `/` (legacy)
- All cloud-safe routes: Supabase reads/writes, Monday API, GHL API, Meta Ads, Stripe, Anthropic

## What stays on the Mac

Endpoints marked `LOCAL_ONLY` in `server.js` — they need Python venv, Playwright,
or Mac desktop file paths that don't exist in a container:

- `/api/sync`, `/api/sync/recs` (Python `sync_all.py`)
- `/api/checkin/scrape`, `/api/checkin/send`, `/api/checkin/rewrite`, `/api/checkin/save`, `/api/checkin/this-week` (Playwright + Mac desktop scrape output)
- `/api/clients/:id/send-mealplan` (Playwright uploads local PDF to Trainerize)
- `/api/batch/meal-plans` (spawns node script that writes PDFs to `~/Downloads`)

Cloud instance returns `501 Not Implemented` with a clear hint for these.
Your Mac wrapper stays running for scripts that need Playwright + PDF generators.
Both talk to the same Supabase — data stays in sync.

---

## Step-by-step deploy

### 1. Create a Railway account
- Go to https://railway.app
- Sign in with GitHub (recommended — enables auto-deploy on push)
- Free tier is fine to start; add a card if you want to remove the trial cap

### 2. GitHub repo — ✅ ALREADY DONE
Repo already created + pushed: **https://github.com/Zachef39/Client-OS**
- Private ✅
- Initial commit `f85bea9` (Railway deploy prep) pushed

### 3. Skip — already pushed
(No action needed)

### 4. Create the Railway project
- Railway dashboard → **New Project** → **Deploy from GitHub repo**
- Select `faerber-client-os`
- Railway auto-detects `railway.toml` and starts the nixpacks build
- The first build will FAIL if env vars aren't set yet — that's expected. Do step 5 next.

### 5. Add environment variables
- Railway project → **Variables** tab → **Raw editor** (top right)
- Open `~/Desktop/Playground - Claude/scripts/faerber-client-os/.env.example` in your editor
- For each variable listed there, paste the real value from `~/Desktop/Playground - Claude/.env`
- **Do NOT** set `PORT` — Railway injects it automatically
- Make sure `LOCAL_ONLY=false` and `NODE_ENV=production`
- Click **Deploy** at the bottom of the Variables panel

Required (paste values from `~/Desktop/Playground - Claude/.env`):

```
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_KEY               # use SUPABASE_SERVICE_ROLE_KEY value
SUPABASE_SERVICE_KEY       # same value as above
SUPABASE_SERVICE_ROLE_KEY  # same value as above
MONDAY_API_TOKEN
MONDAY_BOARD_ID
TRAINERIZE_GROUP_ID
TRAINERIZE_API_TOKEN
GHL_API_KEY
GHL_LOCATION_ID
GHL_SALES_CALENDAR_IDS
GHL_DISCOVERY_CALENDAR_IDS
META_ADS_TOKEN
META_AD_ACCOUNT_ID
STRIPE_SK_MEDICAL
STRIPE_SK_PANDADOC
STRIPE_SK_AFFIRM
LOCAL_ONLY=false
NODE_ENV=production

# Dashboard basic auth — REQUIRED in cloud (otherwise anyone with the URL
# can see client health data + revenue). /api/health stays public.
DASHBOARD_USER=zach
DASHBOARD_PASSWORD=<generate a long random string — 32+ chars>
```

To generate a strong password locally:
```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Optional (only if you use them):

```
SLACK_WEBHOOK
RESEND_API_KEY
RESEND_FROM_EMAIL
NOTIFY_EMAIL
```

### 6. Verify the deploy
- Railway auto-redeploys once vars are saved. Watch the **Deploy Logs** tab.
- On success you'll see:
  ```
  🟢 Faerber Client OS server running
     Dashboard: http://0.0.0.0:PORT/
     Health:    http://0.0.0.0:PORT/api/health
     Mode:      CLOUD (LOCAL_ONLY routes 501)
  ```
- Railway assigns a temporary URL like `faerber-client-os-production.up.railway.app`
- Test:
  ```bash
  curl https://YOUR_TEMP_URL.up.railway.app/api/health
  # Expect: {"ok":true,"ts":"..."}
  ```
- Open `https://YOUR_TEMP_URL.up.railway.app/v2/` — dashboard should load

### 7. Wire up the custom domain (GHL DNS)
- Railway → project → **Settings** → **Domains** → **Custom Domain**
- Enter `dash.faerberfitness.com` → Railway shows a CNAME target like `xxx.up.railway.app`
- Copy that CNAME target.

**GHL DNS steps:**
- Log in to GoHighLevel
- **Settings** → **Domains** → find `faerberfitness.com`
- Click into the domain → **DNS Records** tab
- **Add Record** → **CNAME**:
  - **Host / Name / Subdomain**: `dash`
  - **Value / Points to**: `xxx.up.railway.app` (what Railway showed you)
  - **TTL**: `300` (or default)
- Save.

(If `faerberfitness.com` isn't managed under Domains in GHL — it may live under Locations → your sub-account → Settings → Domains. Same CNAME steps either way.)

### 8. Wait for DNS propagation
- Usually 5–30 min. Sometimes an hour on slow registrars.
- Watch Railway → Domains — when it flips to green with a padlock, SSL is live.
- Check propagation: https://dnschecker.org/#CNAME/dash.faerberfitness.com

### 9. Final smoke test
Once green:

```bash
curl https://dash.faerberfitness.com/api/health
# {"ok":true,"ts":"..."}
```

Open `https://dash.faerberfitness.com/v2/` in a browser.
Confirm:
- Dashboard loads
- Sales / P&L / Team tabs pull data
- No 502s in the browser console

---

## Cloud cron jobs

The cloud server auto-runs 4 sync scripts on schedule (in-process via
`node-cron`, defined in `server/v2/cron.js`). They fire automatically
whenever the cloud instance is running — no separate service required:

| Schedule (UTC) | Script                    | Purpose                                    |
| -------------- | ------------------------- | ------------------------------------------ |
| 05:00 daily    | `sync-ads-daily.mjs`      | Meta ads → `ad_metrics`                    |
| 05:15 daily    | `sync-programmed-to.mjs`  | Monday Coach Board → `clients.programmed_to` |
| 05:30 daily    | `sync-assigned-coach.mjs` | Monday Clients Board → `clients.assigned_coach` |
| every 4 hours  | `alerts-monitor.mjs`      | Slack alerts (critical resigns, capacity, EOD) |

**Local Mac wrapper:** launchd already runs these locally. When
`LOCAL_ONLY=true`, the cloud cron self-disables so nothing double-fires.

**One caveat:** `alerts-monitor.mjs` also checks `~/Downloads` for new
bloodwork PDFs — that alert cleanly no-ops in the cloud (directory doesn't
exist). The other 3 alerts (critical resigns, coach overloaded, missed EOD)
work fine in the cloud since they read Supabase.

**Verify crons ran:** Railway → Deployments → View Logs → look for lines like
`[cron 2026-...] running sync-ads-daily.mjs` and `[cron ...] sync-ads-daily.mjs exited 0`.

---

## Local Mac wrapper — still needs to run

Cloud handles the always-on dashboard + all Supabase/Monday/GHL/Meta/Stripe API traffic.

Your Mac wrapper stays running for the `LOCAL_ONLY` routes:
- Weekly check-in Playwright scrape + send
- Batch meal-plan PDF generation (writes to `~/Downloads`)
- Trainerize meal-plan upload via Playwright
- Python sync (`sync_all.py`)

Keep the launchd job / `start.sh` running on the Mac exactly as today.
Both instances read/write the same Supabase, so data stays in sync.

---

## Auto-deploy on future changes

Railway watches `main`. Any `git push origin main` triggers a new build + deploy.

To ship a change:
```bash
cd "/Users/zachef/Desktop/Playground - Claude/scripts/faerber-client-os"
git add -A
git commit -m "your message"
git push
```

Railway builds + swaps to the new version in ~2 min with zero downtime.

---

## Troubleshooting

### Build fails on nixpacks
Fallback: Railway → project → Settings → **Build** → change builder from `nixpacks` to `Dockerfile`. The repo ships with a working `Dockerfile` at the root.

### 502 Bad Gateway
- Deploy logs will show why the server crashed on boot
- 90% of the time: missing env var. Check `Variables` tab against `.env.example`.
- Health check timeout means server never bound to `PORT`. Confirm the log line `Faerber Client OS server running` appears.

### "Cannot find module '@supabase/supabase-js'" or similar
- Install phase failed. Check deploy logs for the `npm install` output.
- If it hangs, force: Railway → Settings → **Build** → **Trigger Redeploy** with cache cleared.

### API returns `501` for something you expected to work
- That endpoint is marked `LOCAL_ONLY`. Run it on the Mac wrapper instead.
- To see the list, search `server/server.js` for `guardLocalOnly` — every guarded route is documented.

### Custom domain shows "not found" or SSL error
- DNS hasn't propagated. Wait longer (up to 30 min on GHL).
- CNAME target typo. Double-check against what Railway shows in Domains.
- GHL DNS: confirm the CNAME saved. Search `dash.faerberfitness.com` on https://dnschecker.org/#CNAME/dash.faerberfitness.com to verify.

### stage-overrides.json resets on every deploy
- Expected — Railway containers are ephemeral. Migrate that data to Supabase before it starts mattering. Currently `{}` so no data loss.

### Env value has weird characters (Anthropic key starts with `sk-ant-sk-ant-`)
- Server auto-strips the double prefix on boot. Nothing to do.

### Need to roll back a bad deploy
- Railway → Deployments → find the last green deploy → **Redeploy**. Instant rollback.

---

## Cost expectation

- Railway Hobby: $5/mo covers this small Node process w/ headroom
- Custom domain: free (uses your existing `faerberfitness.com` DNS)
- Total: **$5/mo**
