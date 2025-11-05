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
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Keep-alive mechanism for free tier hosting (prevents spin-down)
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || `http://localhost:${PORT}/health`;
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 minutes (free tier spins down after 15 min)

// Self-ping function to keep service alive
async function keepAlive() {
  try {
    const response = await axios.get(KEEP_ALIVE_URL, { timeout: 5000 });
    console.log(`Keep-alive ping successful: ${response.status}`);
  } catch (error) {
    // If localhost doesn't work (e.g., on Render), try the public URL
    if (KEEP_ALIVE_URL.includes('localhost') && process.env.RENDER_EXTERNAL_URL) {
      try {
        await axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`, { timeout: 5000 });
        console.log('Keep-alive ping successful (external URL)');
      } catch (err) {
        console.log('Keep-alive ping failed (will retry)');
      }
    } else {
      console.log('Keep-alive ping failed (will retry)');
    }
  }
}

// Start keep-alive ping every 10 minutes
if (process.env.ENABLE_KEEP_ALIVE !== 'false') {
  setInterval(keepAlive, KEEP_ALIVE_INTERVAL);
  // Initial ping after 30 seconds (to let server start)
  setTimeout(keepAlive, 30000);
  console.log('Keep-alive mechanism enabled (pinging every 10 minutes)');
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
initializeSchedules(bot);

// Schedule price drop monitoring (runs every 2 minutes to reduce API calls)
cron.schedule('*/2 * * * *', async () => {
  await checkPriceDrops(bot);
});

// Initialize price history on startup
initializePriceHistory();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nBot shutting down...');
  const scheduledJobs = getScheduledJobs();
  Object.values(scheduledJobs).forEach(job => job.destroy());
  process.exit(0);
});
