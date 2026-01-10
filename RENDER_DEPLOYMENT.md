# Render.com Deployment Guide

Quick reference for deploying gc-filter-worker instances on Render.com.

## Prerequisites

Before deploying, prepare:

1. **Steam Account** - Separate account for this instance (different from other workers)
2. **steamauth.maFile** - Steam Guard authentication file for the account
3. **API Credentials** - From your main server:
   - `LINK_HARVESTER_API_KEY` (same as other instances)
   - Node API service URL (default: `https://kuchababok.online/api/node/`)

## Deployment Steps

### 1. Create New Web Service

1. Log in to Render.com Dashboard
2. Click **New +** → **Web Service**
3. Connect your Git repository OR select **Deploy an existing image from a registry**
4. Select the `render-com-gc-filter-worker` repository

### 2. Configure Service Settings

**Basic Settings:**
- **Name**: `gc-filter-worker-render-1` (or similar descriptive name)
- **Language**: `Node`
- **Branch**: `main`
- **Region**: Choose closest to your main server
- **Root Directory**: Leave empty
- **Build Command**: `npm install`
- **Start Command**: `node main.js`
- **Instance Type**: `Free` (or paid for better performance)

### 3. Environment Variables

Add these environment variables in Render dashboard:

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_API_SERVICE_URL` | `https://kuchababok.online/api/node/` | Your queue API endpoint |
| `LINK_HARVESTER_API_KEY` | `the_actual_key` | API key for queue access | See in config.json

### 4. Secret Files (Expand Advanced)

Upload as **Secret Files** (not environment variables):

#### config.json
Filename: `config.json`

```json
{
  "steam_username": "YOUR_STEAM_USERNAME",
  "steam_password": "YOUR_STEAM_PASSWORD",
  "link_harvester_api_key": "the_actual_key",
  "mark_processed_api_url": "https://kuchababok.online/en/links/api/mark-steamid-processed/",
  "queue_api_url": "https://kuchababok.online/api/node/",
  "filter_service": {
    "processing_delay_min": 1.5,
    "processing_delay_max": 3.0,
    "gc_connection_timeout": 120,
    "error_delay": 5,
    "login_to_game_delay_min": 15,
    "login_to_game_delay_max": 25,
    "empty_queue_delay": 10,
    "max_retries": 3,
    "request_timeout": 20,
    "max_consecutive_timeouts": 5
  }
}
```

#### steamauth.maFile
Filename: `steamauth.maFile`

Upload your Steam Guard mobile authenticator file for this specific Steam account.

### 5. Deploy

Click **Create Web Service** - Render will automatically build and deploy.

## Post-Deployment

### Verify Deployment

1. Check **Logs** tab in Render dashboard
2. Look for successful Steam login and GC connection messages
3. Verify instance is claiming tasks from Redis queue

### Monitor Instance

- **Logs**: **Only available in Render dashboard** (no file logging on ephemeral filesystem)
  - Real-time logs in **Logs** tab
  - Application automatically detects Render environment and skips file logging
  - All log output goes to stdout/stderr (captured by Render)
- **Cooldown State**: Check via API endpoint `GET /cooldown/:instanceId`
- **Health**: Monitor for Steam rate limit bans and escalating cooldowns

## Important Notes

### Multiple Instances

Each Render instance needs:
- ✅ **Different Steam account** (unique username, password, maFile)
- ✅ **Same queue_api_url** (all point to main server)
- ✅ **Same link_harvester_api_key**

Instances auto-coordinate through Redis - no manual load balancing required.

### Free Tier Limitations

Render free tier:
- **Spins down after 15 min inactivity** (auto-wakes on queue activity)
- **Cold start delay** (~30-60 sec when waking)
- **750 hours/month limit** per account
- **Ephemeral filesystem** - no persistent file storage (logs only in dashboard)

For 24/7 operation with better reliability, upgrade to paid instance ($7/month).

### Secret Files Update

To update `config.json` or `steamauth.maFile`:
1. Go to **Environment** tab
2. Edit secret file
3. Click **Save Changes**
4. Service will auto-redeploy

### Troubleshooting

**Service won't start:**
- Check Logs tab for errors
- Verify secret files are mounted correctly
- Confirm environment variables are set

**No tasks being processed:**
- Verify `NODE_API_SERVICE_URL` points to correct endpoint
- Check `LINK_HARVESTER_API_KEY` matches main server
- Ensure Steam account logged in successfully

**Frequent cooldowns:**
- Normal behavior under heavy rate limiting
- Check cooldown levels: `GET /cooldown/:instanceId`
- Consider using different Steam account or adding delays

## Quick Reference Commands

**View all cooldown states:**
```bash
curl https://kuchababok.online/api/node/cooldown
```

**View specific instance:**
```bash
curl https://kuchababok.online/api/node/cooldown/gc-filter-worker-render-1
```

## Deployment Checklist

- [ ] Steam account credentials ready
- [ ] steamauth.maFile generated and downloaded
- [ ] config.json created with correct values
- [ ] Render service created and configured
- [ ] Environment variables set
- [ ] Secret files uploaded
- [ ] Service deployed successfully
- [ ] Logs show successful Steam login
- [ ] Instance processing tasks from queue
