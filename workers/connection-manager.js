// gc-filter-worker/workers/connection-manager.js - Enhanced GC Connection Recovery with Escalating Cooldowns
const fs = require('fs');
const path = require('path');
const CooldownStateManager = require('../utils/cooldown-api');

function logToFile(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [CONNECTION] ${message}\n`;

    console.log(logMessage.trim());

    const LOG_DIR = path.join(__dirname, '../../logs');
    if (type === 'error') {
        fs.appendFileSync(path.join(LOG_DIR, 'gc_worker_error.log'), logMessage);
    } else {
        fs.appendFileSync(path.join(LOG_DIR, 'gc_worker_main.log'), logMessage);
    }
}

class ConnectionManager {
    constructor(filterService, config, instanceId) {
        this.filterService = filterService;
        this.config = config;
        this.instanceId = instanceId;

        // Initialize cooldown state manager (Redis with file fallback)
        this.cooldownStateManager = new CooldownStateManager(instanceId, {
            QUEUE_API_URL: config.QUEUE_API_URL || config.queue_api_url || 'http://127.0.0.1:3001',
            API_KEY: config.API_KEY || config.link_harvester_api_key || 'fa46kPOVnHT2a4aFmQS11dd70290'
        });

        // Escalating cooldown configuration
        this.COOLDOWN_LEVELS = [
            0,           // Level 0: No cooldown (first attempt)
            30,          // Level 1: 30 minutes
            60,          // Level 2: 1 hour
            120,         // Level 3: 2 hours
            240,         // Level 4: 4 hours
            480          // Level 5: 8 hours (maximum)
        ];

        this.reset();

        // Load cooldown state asynchronously
        this.loadCooldownState().catch(err => {
            logToFile(`Error during initial cooldown state load: ${err.message}`, 'error');
        });
    }

    reset() {
        this.gcConnectionAttempts = 0;
        this.lastGcConnectionTime = 0;
        this.connectionTimer = null;
        this.recoveryInProgress = false;
        logToFile('Connection manager state reset');
    }

    async loadCooldownState() {
        try {
            const state = await this.cooldownStateManager.load();
            this.lastBanTime = state.lastBanTime || 0;
            this.totalBanCount = state.totalBanCount || 0;
            this.cooldownLevel = state.cooldownLevel || 0;

            logToFile(`Loaded cooldown state: total bans: ${this.totalBanCount}, cooldown level: ${this.cooldownLevel}`);
        } catch (error) {
            logToFile(`Error loading cooldown state: ${error.message}, starting fresh`, 'error');
            this.lastBanTime = 0;
            this.totalBanCount = 0;
            this.cooldownLevel = 0;
        }
    }

    async saveCooldownState() {
        try {
            const state = {
                lastBanTime: this.lastBanTime,
                totalBanCount: this.totalBanCount,
                cooldownLevel: this.cooldownLevel
            };

            await this.cooldownStateManager.save(state);
        } catch (error) {
            logToFile(`Error saving cooldown state: ${error.message}`, 'error');
        }
    }
    
    startConnectionTimer() {
        this.clearConnectionTimer();
        this.connectionTimer = setTimeout(() => {
            this.handleConnectionTimeout();
        }, this.config.GC_CONNECTION_TIMEOUT || 120000); // 2 minutes default
        
        logToFile(`GC connection timer started (${(this.config.GC_CONNECTION_TIMEOUT || 120000)/1000}s timeout)`);
    }
    
    clearConnectionTimer() {
        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
            this.connectionTimer = null;
        }
    }
    
    onGcConnected() {
        this.clearConnectionTimer();
        this.lastGcConnectionTime = Date.now();
        
        // SUCCESS: Reset cooldown level to 0 for future attempts
        if (this.cooldownLevel > 0) {
            logToFile(`✅ GC connection successful after cooldown level ${this.cooldownLevel} - resetting to level 0`);
            this.cooldownLevel = 0;
            this.saveCooldownState();
        }
        
        this.reset(); // Reset connection attempts on successful connection
        logToFile('✅ GC connection successful - ready to process');
    }
    
    onGcDisconnected() {
        this.clearConnectionTimer();
        logToFile('❌ GC disconnected during processing - may indicate soft ban');
        
        if (!this.recoveryInProgress) {
            // Don't start recovery immediately, add small delay
            setTimeout(() => {
                this.startRecovery();
            }, 5000);
        }
    }
    
    onSteamError(error) {
        logToFile(`Steam client error: ${error.message}`, 'error');
        this.clearConnectionTimer();
        
        if (!this.recoveryInProgress) {
            setTimeout(() => {
                this.startRecovery();
            }, 10000);
        }
    }
    
    async handleConnectionTimeout() {
        logToFile('⏰ GC connection timeout after 2 minutes - likely soft ban detected', 'error');
        this.gcConnectionAttempts++;
        
        // After first timeout, try simple reconnect once
        if (this.gcConnectionAttempts === 1) {
            logToFile('Attempting one simple GC reconnection before declaring ban...');
            await this.attemptSimpleGcReconnection();
        } else {
            // Multiple failures = ban detected
            await this.handleBanDetected();
        }
    }
    
    async startRecovery() {
        if (this.recoveryInProgress) {
            logToFile('Recovery already in progress, skipping...');
            return;
        }
        
        this.recoveryInProgress = true;
        
        try {
            await this.handleConnectionTimeout();
        } catch (error) {
            logToFile(`Recovery error: ${error.message}`, 'error');
            await this.handleBanDetected();
        } finally {
            this.recoveryInProgress = false;
        }
    }
    
    async attemptSimpleGcReconnection() {
        try {
            logToFile('🔄 Attempting simple GC reconnection...');
            
            // Check if Steam is still connected
            if (!this.filterService.steamClient.steamID) {
                logToFile('Steam client disconnected, declaring ban');
                await this.handleBanDetected();
                return;
            }
            
            this.filterService.processingActive = false;
            await this.delay(5000); // Wait 5 seconds
            
            logToFile('Launching CS2 for reconnection attempt...');
            this.filterService.steamClient.gamesPlayed([730]);
            this.startConnectionTimer();
            
        } catch (error) {
            logToFile(`Simple GC reconnection failed: ${error.message}`, 'error');
            await this.handleBanDetected();
        }
    }
    
    async handleBanDetected() {
        this.totalBanCount++;
        this.lastBanTime = Date.now();
        
        // Escalate cooldown level (but don't exceed maximum)
        const previousLevel = this.cooldownLevel;
        this.cooldownLevel = Math.min(this.cooldownLevel + 1, this.COOLDOWN_LEVELS.length - 1);
        const cooldownMinutes = this.COOLDOWN_LEVELS[this.cooldownLevel];
        
        logToFile(`🚫 SOFT BAN DETECTED (ban #${this.totalBanCount})`, 'error');
        logToFile(`📊 Escalating Cooldown Strategy:`, 'error');
        logToFile(`   - Previous level: ${previousLevel} (${this.COOLDOWN_LEVELS[previousLevel]}min)`, 'error');
        logToFile(`   - New level: ${this.cooldownLevel} (${cooldownMinutes}min)`, 'error');
        logToFile(`   - Total bans since start: ${this.totalBanCount}`, 'error');
        logToFile(`   - GC connection attempts this session: ${this.gcConnectionAttempts}`, 'error');
        
        // Show escalation path
        const remainingLevels = this.COOLDOWN_LEVELS.slice(this.cooldownLevel + 1);
        if (remainingLevels.length > 0) {
            logToFile(`   - Next levels: ${remainingLevels.join('min → ')}min`, 'error');
        } else {
            logToFile(`   - At maximum cooldown level`, 'error');
        }
        
        // Save state before shutdown
        this.saveCooldownState();
        
        // Clean shutdown sequence
        await this.performCleanShutdown(cooldownMinutes / 60); // Convert to hours for compatibility
    }
    
    async performCleanShutdown(cooldownHours) {
        logToFile(`🔄 Starting clean shutdown for ${cooldownHours}h cooldown...`);
        
        try {
            // Save current Steam ID back to queue if processing
            if (this.filterService.currentSteamID) {
                logToFile('💾 Saving current Steam ID back to queue...');
                await this.filterService.returnToQueue(
                    this.filterService.currentSteamID.steamID,
                    this.filterService.currentSteamID.username
                );
                logToFile('✅ Current Steam ID saved to queue');
            }
            
            // Stop processing
            this.filterService.processingActive = false;
            this.clearConnectionTimer();
            
            // Log off from Steam
            if (this.filterService.steamClient.steamID) {
                logToFile('🚪 Logging off from Steam...');
                this.filterService.steamClient.logOff();
                await this.delay(2000); // Give it time to log off
                logToFile('✅ Steam logout completed');
            }
            
            // Final logging
            const nextRestartTime = new Date(Date.now() + (cooldownHours * 60 * 60 * 1000));
            logToFile(`⏰ Filter worker will restart at: ${nextRestartTime.toISOString()}`);
            logToFile(`🛑 Filter worker entering ${cooldownHours}h cooldown (level ${this.cooldownLevel})...`);
            logToFile(`ℹ️ Other services (UniquenessChecker, Submitter, HTTP API) continue running`);
            
            // Set flags that main.js can check
            logToFile('✅ Filter worker clean shutdown completed - main service will handle cooldown');
            
            // Stop the filter service gracefully
            if (this.filterService && typeof this.filterService.stop === 'function') {
                this.filterService.stop();
            }
            
            // Set a flag that main.js can check
            this.filterService.isBanned = true;
            this.filterService.banEndTime = Date.now() + (cooldownHours * 60 * 60 * 1000);
            
        } catch (error) {
            logToFile(`❌ Error during clean shutdown: ${error.message}`, 'error');
            // Still try to stop the filter service gracefully
            if (this.filterService && typeof this.filterService.stop === 'function') {
                this.filterService.stop();
            }
            this.filterService.isBanned = true;
        }
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // Utility methods for status reporting
    getCooldownInfo() {
        if (!this.lastBanTime) {
            return {
                inCooldown: false,
                totalBans: this.totalBanCount,
                cooldownLevel: this.cooldownLevel
            };
        }
        
        const cooldownMinutes = this.COOLDOWN_LEVELS[this.cooldownLevel];
        const cooldownEndTime = this.lastBanTime + (cooldownMinutes * 60 * 1000);
        const remainingMs = Math.max(0, cooldownEndTime - Date.now());
        
        return {
            inCooldown: remainingMs > 0,
            cooldownLevel: this.cooldownLevel,
            cooldownMinutes: cooldownMinutes,
            cooldownHours: cooldownMinutes / 60,
            remainingMs: remainingMs,
            endTime: cooldownEndTime,
            totalBans: this.totalBanCount,
            escalationPath: this.COOLDOWN_LEVELS,
            nextCooldownMinutes: this.cooldownLevel < this.COOLDOWN_LEVELS.length - 1 ? 
                               this.COOLDOWN_LEVELS[this.cooldownLevel + 1] : 
                               this.COOLDOWN_LEVELS[this.COOLDOWN_LEVELS.length - 1]
        };
    }
    
    getStatus() {
        const cooldownInfo = this.getCooldownInfo();
        
        return {
            gcAttempts: this.gcConnectionAttempts,
            recoveryInProgress: this.recoveryInProgress,
            lastGcConnection: this.lastGcConnectionTime,
            timeSinceLastGcConnection: this.lastGcConnectionTime ? Date.now() - this.lastGcConnectionTime : null,
            cooldown: cooldownInfo
        };
    }
    
    // Method to manually reset cooldown (for testing/manual intervention)
    resetCooldown() {
        this.lastBanTime = 0;
        this.cooldownLevel = 0;
        this.saveCooldownState();
        logToFile('🔧 Cooldown manually reset to level 0');
    }
    
    // Method to manually set cooldown level (for testing)
    setCooldownLevel(level) {
        if (level >= 0 && level < this.COOLDOWN_LEVELS.length) {
            this.cooldownLevel = level;
            this.saveCooldownState();
            logToFile(`🔧 Cooldown level manually set to ${level} (${this.COOLDOWN_LEVELS[level]}min)`);
        } else {
            logToFile(`❌ Invalid cooldown level ${level}. Valid range: 0-${this.COOLDOWN_LEVELS.length - 1}`, 'error');
        }
    }
}

module.exports = ConnectionManager;