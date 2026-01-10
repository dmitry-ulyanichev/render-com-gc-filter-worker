# GC Filter Worker

**Purpose:** Dedicated Steam Game Coordinator filtering service for distributed deployment.

## What It Does

This service performs the **rate-limited** operation in your Steam ID processing pipeline:
- Claims Steam IDs from the Redis `filter` queue
- Validates profiles using Steam Game Coordinator
- Passes qualifying IDs to the `processor` queue

## Why Separate Service?

GC filtering is the bottleneck due to Steam rate limits. By isolating this operation, you can:
- Run multiple instances with different Steam accounts
- Scale horizontally without duplicating non-rate-limited operations
- Deploy additional instances on platforms like Render.com

## Requirements

### Files Needed
1. **config.json** - Service configuration (see config.json.example)
2. **steamauth.maFile** - Steam Guard authentication file for your Steam account

### Environment Variables
```bash
NODE_API_SERVICE_URL=https://kuchababok.online/api/node  # URL to your main server's node_api_service
LINK_HARVESTER_API_KEY=your_api_key           # API key for queue access
```

## Configuration

Copy `config.json.example` to `config.json` and fill in:
- `steam_username`: Your Steam account username
- `steam_password`: Your Steam account password
- `queue_api_url`: URL to node_api_service (default: https://kuchababok.online/api/node)
- `mark_processed_api_url`: Django API endpoint for marking IDs as processed

## Running

### Local Development
```bash
npm install
node main.js
```

### Production (with PM2)
```bash
pm2 start main.js --name gc-filter-worker-1
```

### Render.com Deployment
1. Set build command: `npm install`
2. Set start command: `node main.js`
3. Add environment variables:
   - `NODE_API_SERVICE_URL`
   - `LINK_HARVESTER_API_KEY`
4. Upload `config.json` and `steamauth.maFile` as secret files

## Multiple Instances

Each instance should have:
- **Different Steam account** (username, password, maFile)
- **Same queue_api_url** (pointing to your main server)
- **Same link_harvester_api_key**

Instances will automatically coordinate through Redis queues - no manual load balancing needed.

## Monitoring

- Logs: Check `../logs/gc_worker_main.log` and `gc_worker_error.log`
- Cooldown state: Stored in Redis (persistent across restarts)
  - View via API: `GET /cooldown/:instanceId`
  - View all: `GET /cooldown`
  - Fallback to `cooldown-state.json` if Redis unavailable
- Each instance tracks its own cooldown independently

## Cooldown Strategy

Uses escalating cooldowns on Steam rate limit bans:
- Level 0: No cooldown (first attempt)
- Level 1: 30 minutes
- Level 2: 1 hour
- Level 3: 2 hours
- Level 4: 4 hours
- Level 5: 8 hours (maximum)

Manual restart clears cooldown state.
