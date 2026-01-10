// gc-filter-worker/utils/cooldown-api.js - API client for cooldown state management
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Helper for logging
 */
function logToFile(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [COOLDOWN-API] ${message}\n`;

    console.log(logMessage.trim());

    const LOG_DIR = path.join(__dirname, '../../logs');
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const logFile = type === 'error' ? 'gc_worker_error.log' : 'gc_worker_main.log';
    fs.appendFileSync(path.join(LOG_DIR, logFile), logMessage);
}

/**
 * Make HTTP request to cooldown API
 */
async function makeApiRequest(method, endpoint, data = null, config) {
    return new Promise((resolve, reject) => {
        const apiUrl = config.QUEUE_API_URL;
        if (!apiUrl) throw new Error('Missing QUEUE_API_URL in config passed to CooldownStateManager');
        const url = new URL(endpoint, apiUrl);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.API_KEY
            },
            timeout: 10000
        };

        if (data) {
            const postData = JSON.stringify(data);
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = httpModule.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    if (res.statusCode === 200 && parsed.success) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`API error: ${parsed.error || responseData}`));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse API response: ${err.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`API request failed: ${err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('API request timeout'));
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

/**
 * CooldownStateManager - Manages cooldown state with Redis fallback to file
 */
class CooldownStateManager {
    constructor(instanceId, config) {
        this.instanceId = instanceId;
        this.config = config;
        this.fallbackFilePath = path.join(__dirname, '../cooldown-state.json');
        this.useRedis = true; // Try Redis first, fallback to file on error
    }

    /**
     * Load cooldown state (try Redis, fallback to file)
     */
    async load() {
        // Try Redis first
        if (this.useRedis) {
            try {
                const response = await makeApiRequest(
                    'GET',
                    `cooldown/${this.instanceId}`,
                    null,
                    this.config
                );

                if (response.found) {
                    logToFile(`Loaded cooldown state from Redis: level ${response.state.cooldownLevel}, bans ${response.state.totalBanCount}`);
                    return response.state;
                } else {
                    logToFile('No cooldown state in Redis, starting fresh');
                    return { lastBanTime: 0, totalBanCount: 0, cooldownLevel: 0 };
                }
            } catch (error) {
                logToFile(`Redis unavailable, falling back to file storage: ${error.message}`, 'error');
                this.useRedis = false; // Disable Redis for this session
            }
        }

        // Fallback to file
        try {
            if (fs.existsSync(this.fallbackFilePath)) {
                const state = JSON.parse(fs.readFileSync(this.fallbackFilePath, 'utf8'));
                logToFile('Loaded cooldown state from file (Redis fallback)');
                return {
                    lastBanTime: state.lastBanTime || 0,
                    totalBanCount: state.totalBanCount || 0,
                    cooldownLevel: state.cooldownLevel || 0
                };
            }
        } catch (error) {
            logToFile(`Error loading from file: ${error.message}`, 'error');
        }

        logToFile('No cooldown state found, starting fresh');
        return { lastBanTime: 0, totalBanCount: 0, cooldownLevel: 0 };
    }

    /**
     * Save cooldown state (try Redis, fallback to file)
     */
    async save(state) {
        let savedToRedis = false;

        // Try Redis first
        if (this.useRedis) {
            try {
                await makeApiRequest(
                    'POST',
                    `cooldown/${this.instanceId}`,
                    state,
                    this.config
                );

                logToFile(`Saved cooldown state to Redis: level ${state.cooldownLevel}, bans ${state.totalBanCount}`);
                savedToRedis = true;
            } catch (error) {
                logToFile(`Failed to save to Redis, using file: ${error.message}`, 'error');
                this.useRedis = false; // Disable Redis for this session
            }
        }

        // Always save to file as backup
        try {
            const stateWithTimestamp = {
                ...state,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(this.fallbackFilePath, JSON.stringify(stateWithTimestamp, null, 2));

            if (!savedToRedis) {
                logToFile(`Saved cooldown state to file: level ${state.cooldownLevel}, bans ${state.totalBanCount}`);
            }
        } catch (error) {
            logToFile(`Error saving to file: ${error.message}`, 'error');
        }
    }

    /**
     * Clear cooldown state (both Redis and file)
     */
    async clear() {
        // Try clearing from Redis
        if (this.useRedis) {
            try {
                await makeApiRequest(
                    'DELETE',
                    `cooldown/${this.instanceId}`,
                    null,
                    this.config
                );
                logToFile('Cleared cooldown state from Redis');
            } catch (error) {
                logToFile(`Failed to clear Redis state: ${error.message}`, 'error');
            }
        }

        // Clear file
        try {
            if (fs.existsSync(this.fallbackFilePath)) {
                fs.unlinkSync(this.fallbackFilePath);
                logToFile('Cleared cooldown state file');
            }
        } catch (error) {
            logToFile(`Error clearing file: ${error.message}`, 'error');
        }
    }
}

module.exports = CooldownStateManager;
