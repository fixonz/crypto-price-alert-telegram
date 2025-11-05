const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

// Import handlers
const {
  handleStart,
  handleSelect,
  handleInterval,
  handleMyTokens,
  handleAddToken,
  handleCancel,
  handleStop,
  handleAdmin,
  handleTokenAddress
} = require('./handlers/commands');

const { handleCallbackQuery } = require('./handlers/callbacks');

// Import services
const { initializeSchedules, getScheduledJobs } = require('./services/scheduler');
const { checkPriceDrops } = require('./services/alerts');
const { getAllTokenPrices } = require('./utils/api');
const { loadPriceHistory, savePriceHistory } = require('./utils/storage');
const { TOKENS } = require('./config/tokens');

// Initialize Telegram Bot with polling enabled
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// Command handlers
bot.onText(/\/start/, (msg) => handleStart(bot, msg));
bot.onText(/\/select/, (msg) => handleSelect(bot, msg));
bot.onText(/\/interval/, (msg) => handleInterval(bot, msg));
bot.onText(/\/mytokens/, (msg) => handleMyTokens(bot, msg));
bot.onText(/\/addtoken/, (msg) => handleAddToken(bot, msg));
bot.onText(/\/cancel/, (msg) => handleCancel(bot, msg));
bot.onText(/\/stop/, (msg) => handleStop(bot, msg));
bot.onText(/\/admin/, (msg) => handleAdmin(bot, msg));

// Handle callback queries (inline keyboard buttons)
bot.on('callback_query', (query) => handleCallbackQuery(bot, query));

// Handle token address input
bot.on('message', async (msg) => {
  const text = msg.text;
  
  // Skip if it's a command
  if (text && text.startsWith('/')) {
    return;
  }
  
  await handleTokenAddress(bot, msg);
});

// Handle errors
bot.on('polling_error', (error) => {
  // Ignore 409 conflicts during deployment (multiple instances temporarily)
  if (error.response?.statusCode === 409) {
    console.warn('⚠️ Telegram conflict: Multiple instances detected. This is normal during deployment and will resolve automatically.');
    return;
  }
  console.error('Polling error:', error.message || error);
});

// Start Express server for health checks (needed for Render)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Telegram Crypto Price Bot',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    service: 'Telegram Crypto Price Bot'
  });
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Keep-alive mechanism for free tier hosting (prevents spin-down)
// Note: Self-pinging doesn't prevent Render spin-down - use external service like UptimeRobot
const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // 5 minutes (more frequent than 10 min)

// Determine the best URL to ping
function getKeepAliveUrl() {
  // Priority: 1) Custom URL, 2) Render external URL, 3) Localhost
  if (process.env.KEEP_ALIVE_URL) {
    return process.env.KEEP_ALIVE_URL;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL}/health`;
  }
  return `http://localhost:${PORT}/health`;
}

// Self-ping function to keep service alive
async function keepAlive() {
  const url = getKeepAliveUrl();
  const timestamp = new Date().toISOString();
  
  try {
    const response = await axios.get(url, { 
      timeout: 10000,
      headers: {
        'User-Agent': 'CryptoPriceBot-KeepAlive/1.0'
      }
    });
    console.log(`[${timestamp}] ✅ Keep-alive ping successful: ${url} (${response.status})`);
    return true;
  } catch (error) {
    // If external URL fails, try localhost as fallback
    if (!url.includes('localhost') && process.env.RENDER_EXTERNAL_URL) {
      try {
        const localUrl = `http://localhost:${PORT}/health`;
        const response = await axios.get(localUrl, { timeout: 5000 });
        console.log(`[${timestamp}] ✅ Keep-alive ping successful (localhost fallback): ${response.status}`);
        return true;
      } catch (localError) {
        console.log(`[${timestamp}] ⚠️ Keep-alive ping failed: ${error.message || error}`);
      }
    } else {
      console.log(`[${timestamp}] ⚠️ Keep-alive ping failed: ${error.message || error}`);
    }
    
    // Log warning about external service
    if (!process.env.RENDER_EXTERNAL_URL && !process.env.KEEP_ALIVE_URL) {
      console.log(`[${timestamp}] 💡 Tip: Self-pinging may not prevent Render spin-down. Use external service like UptimeRobot to ping your /health endpoint every 5 minutes.`);
    }
    return false;
  }
}

// Start keep-alive ping every 5 minutes
if (process.env.ENABLE_KEEP_ALIVE !== 'false') {
  setInterval(keepAlive, KEEP_ALIVE_INTERVAL);
  // Initial ping after 30 seconds (to let server start)
  setTimeout(() => {
    console.log(`🔔 Keep-alive mechanism enabled (pinging every ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
    console.log(`📍 Keep-alive URL: ${getKeepAliveUrl()}`);
    console.log(`💡 For best results on Render free tier, use external service like UptimeRobot to ping your /health endpoint`);
    keepAlive();
  }, 30000);
}

// Initialize price history for all tokens on startup
async function initializePriceHistory() {
  const priceHistory = await loadPriceHistory();
  let needsUpdate = false;
  
  // Fetch all prices at once
  const allPrices = await getAllTokenPrices();
  if (allPrices) {
    for (const [tokenKey, tokenInfo] of Object.entries(TOKENS)) {
      if (!priceHistory[tokenKey] && allPrices[tokenInfo.id]) {
        priceHistory[tokenKey] = {
          price: parseFloat(allPrices[tokenInfo.id].usd),
          timestamp: Date.now()
        };
        needsUpdate = true;
      }
    }
  }
  
  if (needsUpdate) {
    await savePriceHistory(priceHistory);
  }
}

// Start bot
console.log('Bot started! Waiting for commands...');

// Initialize database on startup
(async () => {
  try {
    const { initDatabase } = require('./utils/database');
    await initDatabase();
  } catch (error) {
    console.warn('Database initialization warning:', error.message);
  }
})();

initializeSchedules(bot);

// Schedule price drop monitoring (runs every 2 minutes to reduce API calls)
cron.schedule('*/2 * * * *', async () => {
  await checkPriceDrops(bot);
});

// Schedule DexScreener boost checking (runs every 30 minutes)
const { checkBoostsForAllTokens } = require('./services/boostChecker');
cron.schedule('*/30 * * * *', async () => {
  await checkBoostsForAllTokens(bot);
});

// Initialize price history on startup
initializePriceHistory();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nBot shutting down...');
  const scheduledJobs = getScheduledJobs();
  Object.values(scheduledJobs).forEach(job => {
    try {
      if (typeof job.destroy === 'function') job.destroy();
      else if (job.stop) job.stop();
    } catch (e) {}
  });
  
  // Close database connection
  try {
    const { closeDatabase } = require('./utils/database');
    await closeDatabase();
  } catch (e) {}
  
  process.exit(0);
});
