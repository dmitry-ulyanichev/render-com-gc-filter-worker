// filter_raw_ids/workers/filter-service-queue.js - Queue-based filter service
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const GlobalOffensive = require('globaloffensive');
const SteamID = require('steamid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ConnectionManager = require('./connection-manager');
const crypto = require('crypto');

// Configuration
const CONFIG = {
    MAFILE_PATH: path.join(__dirname, '../steamauth.maFile'),
    CONFIG_PATH: '/etc/secrets/config.json',
    LOG_DIR: path.join(__dirname, '../../logs'),

    // API settings (must come from /etc/secrets/config.json on Render)
    QUEUE_API_URL: null,
    API_KEY: null,
    DJANGO_API_URL: null,

    // Queue settings
    CLAIM_BATCH_SIZE: 10,           // Claim 10 IDs at once from queue
    EMPTY_QUEUE_DELAY: 10000,       // 10 seconds when queue is empty

    // AGGRESSIVE PROCESSING - Fast delays when connected
    PROCESSING_DELAY_MIN: 500,      // 0.5 seconds
    PROCESSING_DELAY_MAX: 1000,     // 1 second
    LOGIN_TO_GAME_DELAY_MIN: 15000,
    LOGIN_TO_GAME_DELAY_MAX: 25000,

    ERROR_DELAY: 5000,
    MAX_RETRIES: 3,
    REQUEST_TIMEOUT: 20000,

    // Health monitoring
    MAX_CONSECUTIVE_TIMEOUTS: 10,

    // Enhanced GC Connection Recovery Settings
    GC_CONNECTION_TIMEOUT: 120000,  // 2 minutes to wait for GC connection
};

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
    return min + Math.random() * (max - min);
}

function logToFile(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [FILTER-QUEUE] ${message}\n`;

    console.log(logMessage.trim());

    if (type === 'error') {
        fs.appendFileSync(path.join(CONFIG.LOG_DIR, 'filter_error.log'), logMessage);
    } else {
        fs.appendFileSync(path.join(CONFIG.LOG_DIR, 'steam_id_filter.log'), logMessage);
    }
}

// Queue API helper functions
async function makeQueueApiRequest(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, CONFIG.QUEUE_API_URL);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.API_KEY
            },
            timeout: 30000
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
                        reject(new Error(`Queue API error: ${parsed.error || responseData}`));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse queue API response: ${err.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Queue API request failed: ${err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Queue API request timeout'));
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

// Django API helper functions (unchanged)
async function markSteamIdProcessed(steamID, config) {
    return new Promise((resolve, reject) => {
        const url = new URL(config.DJANGO_API_URL);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const postData = JSON.stringify({
            steam_id: steamID.toString()
        });

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-API-Key': config.API_KEY
            },
            timeout: 10000
        };

        const req = httpModule.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode === 200) {
                        const response = JSON.parse(data);
                        resolve(response);
                    } else {
                        reject(new Error(`API returned status ${res.statusCode}: ${data}`));
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

        req.write(postData);
        req.end();
    });
}

async function markSteamIdProcessedWithRetries(steamID, config, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await markSteamIdProcessed(steamID, config);

            if (response.success) {
                if (response.created) {
                    logToFile(`✅ Marked ${steamID} as processed in database`);
                } else {
                    logToFile(`ℹ️ ${steamID} was already marked as processed`);
                }
                return true;
            } else {
                throw new Error(response.error || 'Unknown API error');
            }
        } catch (err) {
            lastError = err;
            logToFile(`Failed to mark ${steamID} as processed (attempt ${attempt}): ${err.message}`, 'error');

            if (attempt < maxRetries) {
                await delay(2000);
            }
        }
    }

    logToFile(`❌ Failed to mark ${steamID} as processed after ${maxRetries} attempts: ${lastError.message}`, 'error');
    return false;
}

// Enhanced main worker class
class FilterService {
    constructor() {
        this.steamClient = new SteamUser();
        this.csgo = new GlobalOffensive(this.steamClient);
        this.config = this.loadConfig();
        this.maFile = this.loadMaFile();
        this.running = false;
        this.processingActive = false;

        // Generate unique instance ID
        this.instanceId = `filter-${crypto.randomBytes(4).toString('hex')}`;
        logToFile(`Instance ID: ${this.instanceId}`);

        // Current batch being processed
        this.currentBatch = [];
        this.currentItem = null;

        this.failureStats = {};

        // Enhanced connection management
        this.connectionManager = new ConnectionManager(this, this.config, this.instanceId);

        // Stats tracking
        this.requestCount = 0;
        this.consecutiveTimeouts = 0;
        this.lastSuccessTime = Date.now();
        this.sessionStartTime = Date.now();

        this.setupEventHandlers();
    }

    loadConfig() {
        try {
            let config = { ...CONFIG }; // Start with defaults

            if (fs.existsSync(CONFIG.CONFIG_PATH)) {
                const userConfig = JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));

                // Load Steam credentials
                config.steam_username = userConfig.steam_username;
                config.steam_password = userConfig.steam_password;

                // Override filter service settings if present
                if (userConfig.filter_service) {
                    const fs = userConfig.filter_service;
                    config.PROCESSING_DELAY_MIN = (fs.processing_delay_min || CONFIG.PROCESSING_DELAY_MIN / 1000) * 1000;
                    config.PROCESSING_DELAY_MAX = (fs.processing_delay_max || CONFIG.PROCESSING_DELAY_MAX / 1000) * 1000;
                    config.LOGIN_TO_GAME_DELAY_MIN = (fs.login_to_game_delay_min || CONFIG.LOGIN_TO_GAME_DELAY_MIN / 1000) * 1000;
                    config.LOGIN_TO_GAME_DELAY_MAX = (fs.login_to_game_delay_max || CONFIG.LOGIN_TO_GAME_DELAY_MAX / 1000) * 1000;
                    config.EMPTY_QUEUE_DELAY = (fs.empty_queue_delay || CONFIG.EMPTY_QUEUE_DELAY / 1000) * 1000;
                    config.ERROR_DELAY = (fs.error_delay || CONFIG.ERROR_DELAY / 1000) * 1000;
                    config.MAX_RETRIES = fs.max_retries || CONFIG.MAX_RETRIES;
                    config.REQUEST_TIMEOUT = (fs.request_timeout || CONFIG.REQUEST_TIMEOUT / 1000) * 1000;
                    config.MAX_CONSECUTIVE_TIMEOUTS = fs.max_consecutive_timeouts || CONFIG.MAX_CONSECUTIVE_TIMEOUTS;

                    // Enhanced recovery settings
                    config.GC_CONNECTION_TIMEOUT = (fs.gc_connection_timeout || CONFIG.GC_CONNECTION_TIMEOUT / 1000) * 1000;
                }

                // Override API settings if present
                config.DJANGO_API_URL = userConfig.mark_processed_api_url || config.DJANGO_API_URL;
                config.API_KEY = userConfig.link_harvester_api_key || config.API_KEY;
                config.QUEUE_API_URL = userConfig.queue_api_url || config.QUEUE_API_URL;

                if (!config.QUEUE_API_URL || !config.API_KEY || !config.DJANGO_API_URL) {
                    throw new Error('Missing API settings in /etc/secrets/config.json');
                }

                // Provide both naming styles for other modules (ConnectionManager/CooldownStateManager)
                config.queue_api_url = config.QUEUE_API_URL;
                config.link_harvester_api_key = config.API_KEY;
                config.mark_processed_api_url = config.DJANGO_API_URL;

                // Make queue helper functions use the loaded config (they reference global CONFIG)
                CONFIG.QUEUE_API_URL = config.QUEUE_API_URL;
                CONFIG.API_KEY = config.API_KEY;
                CONFIG.DJANGO_API_URL = config.DJANGO_API_URL;

            }

            return config;
        } catch (error) {
            logToFile(`Error loading config, using defaults: ${error.message}`, 'error');
            return CONFIG;
        }
    }

    loadMaFile() {
        try {
            return JSON.parse(fs.readFileSync(this.config.MAFILE_PATH, 'utf8'));
        } catch (error) {
            logToFile(`Error loading maFile: ${error.message}`, 'error');
            throw error;
        }
    }

    setupEventHandlers() {
        this.steamClient.on('loggedOn', () => {
            logToFile(`✅ Logged into Steam as ${this.steamClient.steamID.getSteamID64()}`);
            this.steamClient.setPersona(SteamUser.EPersonaState.Online);

            const loginDelay = getRandomDelay(
                this.config.LOGIN_TO_GAME_DELAY_MIN,
                this.config.LOGIN_TO_GAME_DELAY_MAX
            );
            logToFile(`Waiting ${Math.round(loginDelay/1000)}s before launching CS:GO`);

            setTimeout(() => {
                if (this.running) {
                    logToFile('🎮 Launching CS:GO and connecting to GC');
                    this.steamClient.gamesPlayed([730]);
                    this.connectionManager.startConnectionTimer();
                }
            }, loginDelay);
        });

        this.csgo.on('connectedToGC', () => {
            logToFile('✅ Connected to CS:GO Game Coordinator');
            this.connectionManager.clearConnectionTimer();
            this.connectionManager.reset();

            if (!this.processingActive) {
                this.startProcessing();
            }
        });

        this.csgo.on('disconnectedFromGC', (reason) => {
            logToFile(`⚠️ Disconnected from GC: ${reason}`);
            this.processingActive = false;
        });

        this.steamClient.on('error', (err) => {
            logToFile(`❌ Steam error: ${err.message}`, 'error');
            this.connectionManager.handleConnectionError();
        });

        this.steamClient.on('disconnected', (eresult, msg) => {
            logToFile(`❌ Disconnected from Steam: ${msg}`, 'error');
            this.processingActive = false;

            if (this.running) {
                setTimeout(() => {
                    if (this.running) {
                        logToFile('Attempting to reconnect...');
                        this.login();
                    }
                }, 30000);
            }
        });

        process.on('SIGINT', () => {
            logToFile('Received SIGINT, shutting down gracefully...');
            this.stop();
            setTimeout(() => {
                process.exit(0);
            }, 5000);
        });

        process.on('SIGTERM', () => {
            logToFile('Received SIGTERM, shutting down gracefully...');
            this.stop();
            setTimeout(() => {
                process.exit(0);
            }, 5000);
        });
    }

    login() {
        try {
            const code = SteamTotp.generateAuthCode(this.maFile.shared_secret);

            logToFile(`Logging into Steam as ${this.config.steam_username}...`);

            this.steamClient.logOn({
                accountName: this.config.steam_username,
                password: this.config.steam_password,
                twoFactorCode: code
            });
        } catch (error) {
            logToFile(`Failed to login: ${error.message}`, 'error');

            setTimeout(() => {
                if (this.running) {
                    this.login();
                }
            }, 5000);
        }
    }

    start() {
        if (this.running) {
            logToFile('Filter service is already running');
            return;
        }

        this.running = true;
        this.sessionStartTime = Date.now();

        logToFile('🚀 Starting QUEUE-BASED Steam ID Filter Service Worker');
        logToFile(`📋 Instance ID: ${this.instanceId}`);
        logToFile(`⚡ Processing: ${this.config.PROCESSING_DELAY_MIN/1000}-${this.config.PROCESSING_DELAY_MAX/1000}s delays`);
        logToFile(`📦 Batch size: ${this.config.CLAIM_BATCH_SIZE} IDs per claim`);
        logToFile(`🔗 Queue API: ${this.config.QUEUE_API_URL}`);
        logToFile(`🌐 Django API: ${this.config.DJANGO_API_URL}`);

        // Log cooldown info if resuming after ban
        const cooldownInfo = this.connectionManager.getCooldownInfo();
        if (cooldownInfo.totalBans > 0) {
            logToFile(`📊 Resuming from cooldown level ${cooldownInfo.cooldownLevel} after ${cooldownInfo.totalBans} previous bans`);
        }

        this.login();
    }

    startProcessing() {
        if (this.processingActive) return;
        this.processingActive = true;
        logToFile('🔥 Starting queue processing - aggressive mode!');
        this.processQueue();
    }

    async processQueue() {
        while (this.running && this.processingActive) {
            try {
                // Claim a batch if we don't have any items
                if (this.currentBatch.length === 0) {
                    const batch = await this.claimBatchFromQueue();
                    if (!batch || batch.length === 0) {
                        // Queue is empty, wait and retry
                        await delay(this.config.EMPTY_QUEUE_DELAY);
                        continue;
                    }
                    this.currentBatch = batch;
                    logToFile(`📦 Claimed batch of ${batch.length} IDs from queue`);
                }

                // Process next item from current batch
                const item = this.currentBatch.shift();
                this.currentItem = item;

                logToFile(`Processing ${item.id} (${item.username}) - ${this.currentBatch.length} remaining in batch`);

                const processResult = await this.processSteamIDWithRetries(item.id, this.config.MAX_RETRIES);

                if (processResult.success) {
                    if (processResult.passed) {
                        // Success: Passed filters - add to processor queue and complete in filter queue
                        await this.addToProcessorQueue(item.id, item.username);
                        await this.completeInFilterQueue([item.id]);
                        logToFile(`✅ ${item.id} passed filters and added to processor queue`);

                        this.requestCount++;
                        this.lastSuccessTime = Date.now();
                        this.consecutiveTimeouts = 0;
                    } else {
                        // Filtering failure: ID doesn't meet criteria - complete in filter queue (remove it)
                        await this.completeInFilterQueue([item.id]);
                        logToFile(`🗑️ ${item.id} filtered out: ${processResult.filterReason || 'does not meet criteria'}`);
                        
                        this.requestCount++;
                        this.consecutiveTimeouts = 0;
                    }
                } else {
                    // Network/timeout error: Release back to queue to try again later
                    await this.releaseToFilterQueue([item.id]);
                    logToFile(`🔄 ${item.id} released back to queue due to error: ${processResult.error?.message || 'unknown error'}`);

                    if (!this.failureStats[item.id]) {
                        this.failureStats[item.id] = 0;
                    }
                    this.failureStats[item.id]++;
                }

                this.currentItem = null;

                // Random delay between requests
                const processingDelay = getRandomDelay(
                    this.config.PROCESSING_DELAY_MIN,
                    this.config.PROCESSING_DELAY_MAX
                );
                await delay(processingDelay);

            } catch (error) {
                logToFile(`Error in processing loop: ${error.message}`, 'error');
                await delay(this.config.ERROR_DELAY);
            }
        }
    }

    async claimBatchFromQueue() {
        try {
            const response = await makeQueueApiRequest('POST', 'queue/filter/claim', {
                instance_id: this.instanceId,
                count: this.config.CLAIM_BATCH_SIZE
            });

            return response.items || [];
        } catch (error) {
            logToFile(`Failed to claim batch from queue: ${error.message}`, 'error');
            return [];
        }
    }

    async completeInFilterQueue(itemIds) {
        try {
            await makeQueueApiRequest('POST', 'queue/filter/complete', {
                instance_id: this.instanceId,
                items: itemIds
            });
            logToFile(`✅ Completed ${itemIds.length} items in filter queue`);
        } catch (error) {
            logToFile(`Failed to complete items in filter queue: ${error.message}`, 'error');
        }
    }

    async releaseToFilterQueue(itemIds) {
        try {
            await makeQueueApiRequest('POST', 'queue/filter/release', {
                instance_id: this.instanceId,
                items: itemIds
            });
            logToFile(`🔄 Released ${itemIds.length} items back to filter queue`);
        } catch (error) {
            logToFile(`Failed to release items to filter queue: ${error.message}`, 'error');
        }
    }

    async addToProcessorQueue(steamID, username) {
        try {
            await makeQueueApiRequest('POST', 'queue/processor/add', {
                [username]: [steamID.toString()]
            });
            logToFile(`➡️ Added ${steamID} to processor queue for user ${username}`);
        } catch (error) {
            logToFile(`Failed to add to processor queue: ${error.message}`, 'error');
            throw error;
        }
    }

    async processSteamIDWithRetries(steamID64, maxRetries) {
        let attempts = 0;
        let lastError = null;
        let processResult = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                const result = await this.fetchAndCheckProfile(steamID64);
                processResult = { success: true, ...result };
                break;
            } catch (error) {
                lastError = error;
                logToFile(`Attempt ${attempts} failed for ${steamID64}: ${error.message}`, 'error');
                if (attempts < maxRetries) {
                    await delay(this.config.ERROR_DELAY);
                }
            }
        }

        if (!processResult) {
            processResult = { success: false, error: lastError };
        }

        // Mark as processed in Django database
        try {
            await markSteamIdProcessedWithRetries(steamID64, this.config);
        } catch (err) {
            logToFile(`Warning: Could not mark ${steamID64} as processed in database: ${err.message}`, 'error');
        }

        return processResult;
    }

    fetchAndCheckProfile(steamID64) {
        return new Promise((resolve, reject) => {
            let steamIDObj;
            let accountID;

            try {
                steamIDObj = new SteamID(steamID64.toString());
                accountID = steamIDObj.accountid;

                if (!accountID || accountID === 0) {
                    reject(new Error(`Invalid Steam ID or could not extract account ID from ${steamID64}`));
                    return;
                }

                if (steamIDObj.type !== SteamID.Type.INDIVIDUAL) {
                    reject(new Error(`Steam ID ${steamID64} is not an individual account`));
                    return;
                }
            } catch (error) {
                reject(new Error(`SteamID construction error for ${steamID64}: ${error.message}`));
                return;
            }

            const requestStartTime = Date.now();
            let requestTimeout = setTimeout(() => {
                this.consecutiveTimeouts++;
                logToFile(`⏱️ Request timeout for ${steamID64} (${this.consecutiveTimeouts} consecutive)`, 'error');

                if (this.consecutiveTimeouts >= this.config.MAX_CONSECUTIVE_TIMEOUTS) {
                    logToFile(`❌ Too many consecutive timeouts (${this.consecutiveTimeouts}), triggering connection recovery`, 'error');
                    this.connectionManager.handleConnectionTimeout();
                }

                reject(new Error('Request timeout'));
            }, this.config.REQUEST_TIMEOUT);

            // Use callback instead of event listener
            this.csgo.requestPlayersProfile(steamIDObj, (profile) => {
                clearTimeout(requestTimeout);

                this.consecutiveTimeouts = 0;

                try {
                    const result = this.checkProfile(steamID64, profile);
                    resolve({
                        success: true,
                        passed: result.passedChecks,
                        filterReason: result.filterReason,  // Add this line
                        ...result
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    checkProfile(steamID64, profile) {
        if (!profile) {
            throw new Error('No profile data received');
        }

        const medals = profile.medals?.display_items_defidx || [];
        const commend = profile.commendation || {};
        const totalCommendations =
            (commend.cmd_friendly || 0) +
            (commend.cmd_teaching || 0) +
            (commend.cmd_leader || 0);

        const unwantedMedals = new Set([
            4960, 6111, 6112, 6123, 6126, 6129, 4918, 4555, 4759, 6101, 4687,
            6113, 6106, 6125, 4886, 4853, 4703, 4552, 960, 4959, 4762, 4919,
            4828, 4800, 4761, 4626, 4986, 4873, 6127, 6128, 4799, 4702, 909,
            4550, 6105, 4798, 4553, 4760, 4958, 6114, 4884, 4701, 4700, 6124,
            4885, 6130, 4690, 6115, 4691, 6131, 4887, 935, 912, 908, 902, 4552, 968,
            952, 946, 6034, 6117, 6116, 6120, 6109, 6104, 6108, 6118, 4623, 4851
        ]);

        let passed = true;
        let filterReason = null;

        if (totalCommendations >= 100) {
            passed = false;
            filterReason = `commendations ≥ 100 (${totalCommendations})`;
        } else if (!medals.includes(874)) {
            passed = false;
            filterReason = "missing medal 874";
        } else if (medals.length < 3) {
            passed = false;
            filterReason = `less than 3 medals (has ${medals.length})`;
        } else if (medals.find(m => unwantedMedals.has(m)) !== undefined) {
            const firstUnwanted = medals.find(m => unwantedMedals.has(m));
            passed = false;
            filterReason = `has unwanted medal: ${firstUnwanted}`;
        }

        const resultMessage = passed ? 
            `✅ ${steamID64} - Passed filters` : 
            `❌ ${steamID64} - Failed (${filterReason})`;
        
        logToFile(resultMessage);

        return {
            passedChecks: passed,
            filterReason: filterReason,  // Add this line
            profileData: {
                account_id: profile.account_id,
                steam_id: steamID64,
                commendations: commend,
                medals: medals,
                timestamp: new Date().toISOString()
            }
        };
    }

    getStats() {
        const uptime = (Date.now() - this.sessionStartTime) / 1000;
        const avgRate = uptime > 0 ? this.requestCount / uptime : 0;

        return {
            running: this.running,
            processing_active: this.processingActive,
            instance_id: this.instanceId,
            current_batch_size: this.currentBatch.length,
            current_item: this.currentItem ? this.currentItem.id : null,
            requests_processed: this.requestCount,
            consecutive_timeouts: this.consecutiveTimeouts,
            session_uptime_seconds: Math.round(uptime),
            avg_requests_per_second: avgRate.toFixed(2),
            last_success_ago_seconds: Math.round((Date.now() - this.lastSuccessTime) / 1000),
            cooldown_info: this.connectionManager.getCooldownInfo(),
            timestamp: new Date().toISOString()
        };
    }

    stop() {
        if (!this.running) {
            return;
        }

        logToFile('Stopping Queue-Based Steam ID Filter Service Worker...');
        this.running = false;
        this.processingActive = false;

        // Clean up connection manager
        if (this.connectionManager) {
            this.connectionManager.clearConnectionTimer();
            logToFile('Connection manager cleanup completed');
        }

        // Release current batch back to queue
        if (this.currentBatch.length > 0) {
            const itemIds = this.currentBatch.map(item => item.id);
            logToFile(`Releasing ${itemIds.length} items from current batch back to queue`);
            this.releaseToFilterQueue(itemIds)
                .catch(err => logToFile(`Failed to release batch on shutdown: ${err.message}`, 'error'));
        }

        // Release current item if processing
        if (this.currentItem) {
            logToFile(`Shutdown detected while processing ${this.currentItem.id}, releasing back to queue`);
            this.releaseToFilterQueue([this.currentItem.id])
                .catch(err => logToFile(`Failed to release current item on shutdown: ${err.message}`, 'error'));
        }

        // Clean logout
        try {
            if (this.steamClient.steamID) {
                this.steamClient.logOff();
                logToFile('Steam client logged off');
            }
        } catch (error) {
            logToFile(`Error during Steam logout: ${error.message}`, 'error');
        }

        // Log final session statistics
        const stats = this.getStats();
        logToFile(`📊 Final session stats: ${stats.requests_processed} requests in ${stats.session_uptime_seconds}s (${stats.avg_requests_per_second} req/s)`);

        logToFile('Filter service stopped');
    }

    isRunning() {
        return this.running && this.processingActive;
    }
}

module.exports = FilterService;
