// gc-filter-worker/main.js - Dedicated Game Coordinator filter service
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FilterService = require('./workers/filter-service');
const CooldownStateManager = require('./utils/cooldown-api');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const CONFIG = {
    LOG_DIR: path.join(__dirname, '../logs'),
    CONFIG_PATH: '/etc/secrets/config.json',
    COOLDOWN_STATE_PATH: path.join(__dirname, 'cooldown-state.json'),

    // Detect cloud environment (Render, Heroku, etc.) - skip file logging on ephemeral filesystems
    ENABLE_FILE_LOGGING: !process.env.RENDER && !process.env.DYNO,

    // Escalating cooldown levels (in minutes)
    COOLDOWN_LEVELS: [
        0,           // Level 0: No cooldown (first attempt)
        30,          // Level 1: 30 minutes
        60,          // Level 2: 1 hour
        120,         // Level 3: 2 hours
        240,         // Level 4: 4 hours
        480          // Level 5: 8 hours (maximum)
    ]
};

// Ensure directories exist
function initializeEnvironment() {
    // Create logs directory only if file logging is enabled
    if (CONFIG.ENABLE_FILE_LOGGING) {
        fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
    }

    // Check for required config file
    if (!fs.existsSync(CONFIG.CONFIG_PATH)) {
        console.error('ERROR: config.json not found!');
        console.error('Please create config.json with your Steam credentials.');
        process.exit(1);
    }
}

// Helper functions
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logToFile(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [GC-WORKER] ${message}\n`;

    console.log(logMessage.trim());

    // Only write to file if file logging is enabled (disabled on cloud platforms with ephemeral filesystems)
    if (CONFIG.ENABLE_FILE_LOGGING) {
        try {
            const logFile = type === 'error' ? 'gc_worker_error.log' : 'gc_worker_main.log';
            fs.appendFileSync(path.join(CONFIG.LOG_DIR, logFile), logMessage);
        } catch (error) {
            // If file logging fails, at least we have console output
            console.error(`Failed to write to log file: ${error.message}`);
        }
    }
}

// Cooldown state management (now handled by CooldownStateManager in constructor)
// These functions are kept for the startup cooldown check in main.js
async function loadCooldownStateAsync(cooldownStateManager) {
    try {
        return await cooldownStateManager.load();
    } catch (error) {
        logToFile(`Error loading cooldown state: ${error.message}`, 'error');
        return { lastBanTime: 0, totalBanCount: 0, cooldownLevel: 0 };
    }
}

function calculateCooldownEndTime(cooldownState) {
    if (!cooldownState.lastBanTime || cooldownState.cooldownLevel === 0) {
        return 0; // No cooldown
    }

    const cooldownMinutes = CONFIG.COOLDOWN_LEVELS[cooldownState.cooldownLevel] || 0;
    return cooldownState.lastBanTime + (cooldownMinutes * 60 * 1000);
}

function getRemainingCooldownTime(cooldownState) {
    const endTime = calculateCooldownEndTime(cooldownState);
    return Math.max(0, endTime - Date.now());
}

function getCooldownLevelInfo(level) {
    const minutes = CONFIG.COOLDOWN_LEVELS[level] || 0;
    const hours = minutes / 60;
    return { level, minutes, hours };
}

// Main service class
class GCFilterWorker {
    constructor() {
        this.filterWorker = null;
        this.running = false;
        this.filterWorkerRunning = false;
        this.filterRestartTimer = null;

        // Generate instance ID for cooldown state tracking
        this.instanceId = `gc-worker-${crypto.randomBytes(4).toString('hex')}`;

        // Load config for cooldown state manager
        const config = this.loadMainConfig();

        if (!config.queue_api_url) throw new Error('Missing queue_api_url in config');
        if (!config.link_harvester_api_key) throw new Error('Missing link_harvester_api_key in config');

        this.cooldownStateManager = new CooldownStateManager(this.instanceId, {
        QUEUE_API_URL: config.queue_api_url,
        API_KEY: config.link_harvester_api_key
        });

        this.setupEventHandlers();
    }

    loadMainConfig() {
        try {
            if (fs.existsSync(CONFIG.CONFIG_PATH)) {
                return JSON.parse(fs.readFileSync(CONFIG.CONFIG_PATH, 'utf8'));
            }
        } catch (error) {
            logToFile(`Error loading config: ${error.message}`, 'error');
        }
        return {};
    }

    setupEventHandlers() {
        process.on('SIGINT', () => {
            logToFile('Received SIGINT, shutting down gracefully...');
            this.shutdown();
        });

        process.on('SIGTERM', () => {
            logToFile('Received SIGTERM, shutting down gracefully...');
            this.shutdown();
        });

        process.on('uncaughtException', (error) => {
            logToFile(`Uncaught exception: ${error.message}`, 'error');
            logToFile(`Stack: ${error.stack}`, 'error');
            this.shutdown();
        });

        process.on('unhandledRejection', (reason, promise) => {
            logToFile(`Unhandled rejection at ${promise}: ${reason}`, 'error');
        });
    }

    async start() {
        if (this.running) {
            logToFile('Service is already running');
            return;
        }

        this.running = true;
        logToFile('Starting Game Coordinator Filter Worker');
        logToFile('================================================================');

        try {
            // Initialize environment
            initializeEnvironment();

            logToFile('');
            logToFile('SERVICE PURPOSE: Steam GC Filtering (Rate-Limited Operation)');
            logToFile('WORKFLOW:');
            logToFile('1. Claims IDs from Redis filter queue via node_api_service');
            logToFile('2. Checks profiles using Steam Game Coordinator');
            logToFile('3. Passes qualifying IDs to processor queue');
            logToFile('4. Can run multiple instances with different Steam accounts');
            logToFile('');
            logToFile('ESCALATING COOLDOWN STRATEGY:');
            CONFIG.COOLDOWN_LEVELS.forEach((minutes, level) => {
                const hours = minutes === 0 ? '0 (no cooldown)' : minutes < 60 ? `${minutes}min` : `${minutes/60}h`;
                logToFile(`Level ${level}: ${hours}`);
            });
            logToFile('Strategy: 30min → 1h → 2h → 4h → 8h (resets to 30min on success or max)');
            logToFile('');

            // Check and start filter service
            await this.checkAndStartFilterService();

            // Start monitoring
            this.startFilterWorkerMonitoring();

            logToFile('GC Filter Worker started successfully!');
            if (CONFIG.ENABLE_FILE_LOGGING) {
                logToFile('Check logs in: logs/');
            } else {
                logToFile('File logging disabled (cloud environment detected - check platform dashboard for logs)');
            }
            logToFile(`Cooldown state persisted in Redis (instance: ${this.instanceId})`);

        } catch (error) {
            logToFile(`Failed to start service: ${error.message}`, 'error');
            this.shutdown();
        }
    }

    async checkAndStartFilterService() {
        // Check if this is a manual restart
        const isManualRestart = this.detectManualRestart();

        if (isManualRestart) {
            logToFile('🔧 Manual service restart detected - clearing previous ban state');
            await this.clearCooldownState();
            logToFile('✅ Starting from clean slate with cooldown level 0');
            this.startFilterWorker();
            return;
        }

        const cooldownState = await loadCooldownStateAsync(this.cooldownStateManager);
        const remainingCooldown = getRemainingCooldownTime(cooldownState);
        const cooldownInfo = getCooldownLevelInfo(cooldownState.cooldownLevel);

        if (remainingCooldown > 0) {
            const remainingHours = (remainingCooldown / (60 * 60 * 1000)).toFixed(1);
            const remainingMinutes = Math.ceil(remainingCooldown / (60 * 1000));
            const restartTime = new Date(Date.now() + remainingCooldown);

            logToFile('🚫 Filter Service in escalating cooldown period', 'error');
            logToFile(`📊 Cooldown Info:`, 'error');
            logToFile(`   - Current level: ${cooldownInfo.level} (${cooldownInfo.minutes}min / ${cooldownInfo.hours}h)`, 'error');
            logToFile(`   - Remaining: ${remainingMinutes}min / ${remainingHours}h`, 'error');
            logToFile(`   - Restart at: ${restartTime.toISOString()}`, 'error');
            logToFile(`   - Total bans: ${cooldownState.totalBanCount}`, 'error');

            // Show next escalation level
            const nextLevel = Math.min(cooldownState.cooldownLevel + 1, CONFIG.COOLDOWN_LEVELS.length - 1);
            const nextCooldownInfo = getCooldownLevelInfo(nextLevel);
            if (nextLevel > cooldownState.cooldownLevel) {
                logToFile(`   - Next failure → Level ${nextLevel} (${nextCooldownInfo.minutes}min / ${nextCooldownInfo.hours}h)`, 'error');
            } else {
                logToFile(`   - At maximum cooldown level`, 'error');
            }

            // Schedule restart after cooldown
            this.scheduleFilterRestart(remainingCooldown);
        } else {
            // No cooldown, start immediately
            if (cooldownState.totalBanCount > 0) {
                logToFile(`📊 Cooldown expired, resuming from level ${cooldownState.cooldownLevel} after ${cooldownState.totalBanCount} previous bans`);
            }
            this.startFilterWorker();
        }
    }

    detectManualRestart() {
        if (process.env.RESET_COOLDOWN === 'true') {
            return true;
        }

        if (process.argv.includes('--reset-cooldown')) {
            return true;
        }

        // Check if process was started by systemd
        if (process.env.INVOCATION_ID || process.ppid === 1) {
            return true;
        }

        return false;
    }

    async clearCooldownState() {
        try {
            await this.cooldownStateManager.clear();
            logToFile('🗑️ Cooldown state cleared (Redis + file)');
        } catch (error) {
            logToFile(`⚠️ Error clearing cooldown state: ${error.message}`, 'error');
        }
    }

    startFilterWorker() {
        if (this.filterWorkerRunning) {
            logToFile('Filter worker is already running');
            return;
        }

        logToFile('🚀 Starting Game Coordinator Filter Service Worker...');

        try {
            this.filterWorker = new FilterService();
            this.filterWorker.start();
            this.filterWorkerRunning = true;

            logToFile('✅ Filter Service Worker started successfully');
        } catch (error) {
            logToFile(`❌ Failed to start Filter Service Worker: ${error.message}`, 'error');

            // Try again in 1 minute
            this.scheduleFilterRestart(60000);
        }
    }

    scheduleFilterRestart(delayMs) {
        if (this.filterRestartTimer) {
            clearTimeout(this.filterRestartTimer);
        }

        const restartTime = new Date(Date.now() + delayMs);
        const delayMinutes = Math.ceil(delayMs / (60 * 1000));
        const delayHours = (delayMs / (60 * 60 * 1000)).toFixed(1);

        if (delayMs < 60 * 60 * 1000) { // Less than 1 hour
            logToFile(`⏰ Filter worker restart scheduled for ${restartTime.toISOString()} (${delayMinutes}min from now)`);
        } else {
            logToFile(`⏰ Filter worker restart scheduled for ${restartTime.toISOString()} (${delayHours}h from now)`);
        }

        this.filterRestartTimer = setTimeout(() => {
            const cooldownState = loadCooldownState();
            const cooldownInfo = getCooldownLevelInfo(cooldownState.cooldownLevel);
            logToFile(`⚡ Cooldown level ${cooldownInfo.level} expired, restarting Filter Service Worker...`);
            this.startFilterWorker();
        }, delayMs);
    }

    startFilterWorkerMonitoring() {
        const MONITOR_INTERVAL = 30000; // 30 seconds

        setInterval(() => {
            this.monitorFilterWorker();
        }, MONITOR_INTERVAL);

        logToFile('🔍 Filter worker monitoring started');
    }

    monitorFilterWorker() {
        if (!this.running) return;

        // Simple monitoring: just check if worker is alive and restart if needed
        // Cooldown logic is handled internally by ConnectionManager
        if (!this.filterWorkerRunning || !this.filterWorker) {
            // Worker should be running but isn't
            logToFile('🔍 Filter worker not running - starting...');
            setTimeout(() => {
                if (this.running && !this.filterWorkerRunning) {
                    this.startFilterWorker();
                }
            }, 2000);
            return;
        }

        // Check if worker has died unexpectedly
        try {
            if (this.filterWorker && typeof this.filterWorker.isRunning === 'function') {
                const isRunning = this.filterWorker.isRunning();
                if (!isRunning && !this.filterWorker.isBanned) {
                    logToFile('🔍 Filter worker died unexpectedly (not banned) - restarting...');
                    this.filterWorkerRunning = false;
                    this.filterWorker = null;

                    setTimeout(() => {
                        if (this.running) {
                            this.startFilterWorker();
                        }
                    }, 5000);
                }
            }
        } catch (error) {
            logToFile(`🔍 Error checking filter worker status: ${error.message}`, 'error');
        }
    }

    shutdown() {
        if (!this.running) {
            return;
        }

        logToFile('Shutting down GC Filter Worker...');
        this.running = false;

        if (this.filterRestartTimer) {
            clearTimeout(this.filterRestartTimer);
            this.filterRestartTimer = null;
            logToFile('Cancelled pending filter worker restart');
        }

        if (this.filterWorker && typeof this.filterWorker.stop === 'function') {
            try {
                logToFile('Stopping filter worker...');
                this.filterWorker.stop();
            } catch (error) {
                logToFile(`Error stopping filter worker: ${error.message}`, 'error');
            }
        }

        this.filterWorkerRunning = false;

        logToFile('Service stopped');

        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }

    getStatus() {
        const cooldownState = loadCooldownState();
        const remainingCooldown = getRemainingCooldownTime(cooldownState);
        const cooldownInfo = getCooldownLevelInfo(cooldownState.cooldownLevel);

        let internalBanInfo = {
            isBanned: false,
            banEndTime: null,
            remainingMs: 0
        };

        if (this.filterWorker && this.filterWorker.isBanned) {
            const banEndTime = this.filterWorker.banEndTime || 0;
            const remainingMs = Math.max(0, banEndTime - Date.now());

            internalBanInfo = {
                isBanned: true,
                banEndTime: banEndTime,
                remainingMs: remainingMs
            };
        }

        let filterStats = null;
        if (this.filterWorker && typeof this.filterWorker.getStats === 'function') {
            try {
                filterStats = this.filterWorker.getStats();
            } catch (error) {
                logToFile(`Error getting filter stats: ${error.message}`, 'error');
            }
        }

        return {
            running: this.running,
            filterWorker: {
                running: this.filterWorkerRunning,
                inCooldown: remainingCooldown > 0,
                remainingCooldownMs: remainingCooldown,
                cooldownLevel: cooldownState.cooldownLevel,
                cooldownInfo: cooldownInfo,
                totalBans: cooldownState.totalBanCount,
                nextRestartTime: remainingCooldown > 0 ? new Date(Date.now() + remainingCooldown).toISOString() : null,
                escalationLevels: CONFIG.COOLDOWN_LEVELS,
                cooldownStrategy: 'Escalating: 30min → 1h → 2h → 4h → 8h (resets on success)',
                internalBan: internalBanInfo,
                stats: filterStats
            },
            uptime: process.uptime(),
            memory: process.memoryUsage()
        };
    }
}

// Main execution
(async () => {
    const service = new GCFilterWorker();
    await service.start();
})();
