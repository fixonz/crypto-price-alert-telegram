const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
require('dotenv').config();

// Initialize Telegram Bot with polling enabled
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(token, { polling: true });

// Supported tokens configuration
const TOKENS = {
  bitcoin: { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
  ethereum: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', emoji: 'Ξ' },
  binancecoin: { id: 'binancecoin', symbol: 'BNB', name: 'BNB', emoji: '🟡' },
  solana: { id: 'solana', symbol: 'SOL', name: 'Solana', emoji: '◎' }
};

// Valid intervals (in minutes)
const VALID_INTERVALS = [1, 2, 5, 10, 15, 30, 60];

// User preferences file
const USERS_FILE = path.join(__dirname, 'users.json');

// Price history file (stores last known prices for drop detection)
const PRICES_FILE = path.join(__dirname, 'prices.json');

// Load user preferences
async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save user preferences
async function saveUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// Load price history
async function loadPriceHistory() {
  try {
    const data = await fs.readFile(PRICES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save price history
async function savePriceHistory(prices) {
  await fs.writeFile(PRICES_FILE, JSON.stringify(prices, null, 2));
}

// Get user count
async function getUserCount() {
  const users = await loadUsers();
  return Object.keys(users).length;
}

// Get active user count
async function getActiveUserCount() {
  const users = await loadUsers();
  return Object.values(users).filter(u => u.subscribed).length;
}

// Check if user is new (first time starting)
async function isNewUser(chatId) {
  const users = await loadUsers();
  return !users[chatId];
}

// Get user preferences or create default
async function getUserPreferences(chatId) {
  const users = await loadUsers();
  const isNew = !users[chatId];
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      interval: 1, // default 1 minute
      createdAt: Date.now()
    };
    await saveUsers(users);
  }
  return { ...users[chatId], isNew };
}

// Update user preferences
async function updateUserPreferences(chatId, updates) {
  const users = await loadUsers();
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      interval: 1,
      createdAt: Date.now()
    };
  }
  Object.assign(users[chatId], updates);
  await saveUsers(users);
  return users[chatId];
}

// Send admin notification about new user
async function notifyAdminNewUser(userId, username, firstName, lastName) {
  if (!ADMIN_CHAT_ID) return;
  
  const totalUsers = await getUserCount();
  const activeUsers = await getActiveUserCount();
  
  const userInfo = [
    username ? `@${username}` : 'No username',
    firstName ? firstName : '',
    lastName ? lastName : ''
  ].filter(Boolean).join(' ') || 'Unknown';
  
  const message = `🆕 *New User Started Bot*

👤 *User Info:*
• ID: \`${userId}\`
• Name: ${userInfo}

📊 *Statistics:*
• Total Users: *${totalUsers}*
• Active Users: *${activeUsers}*

_Time: ${new Date().toLocaleString()}_`;

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending admin notification:', error.message);
  }
}

// Fetch price for a specific token
async function getTokenPrice(tokenId) {
  try {
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd&include_24hr_change=true`
    );
    
    const data = response.data[tokenId];
    if (!data) return null;
    
    const price = data.usd;
    const change24h = data.usd_24h_change;
    
    return {
      price: price.toFixed(2),
      change24h: change24h ? change24h.toFixed(2) : '0.00',
      emoji: change24h >= 0 ? '📈' : '📉'
    };
  } catch (error) {
    console.error(`Error fetching ${tokenId} price:`, error.message);
    return null;
  }
}

// Format price message
function formatPriceMessage(token, priceData) {
  const tokenInfo = TOKENS[token];
  return `${priceData.emoji} *${tokenInfo.name} (${tokenInfo.symbol})*
${tokenInfo.emoji} *$${priceData.price}*
${priceData.change24h >= 0 ? '📊' : '📊'} 24h: ${priceData.change24h >= 0 ? '+' : ''}${priceData.change24h}%

_Updated: ${new Date().toLocaleTimeString()}_`;
}

// Format alert message for price drops
function formatAlertMessage(token, priceData, dropPercentage, previousPrice) {
  const tokenInfo = TOKENS[token];
  return `🚨 *PRICE ALERT - ${tokenInfo.name} (${tokenInfo.symbol})*

⚠️ *5%+ Drop Detected!*

📉 *$${priceData.price}* (was $${previousPrice})
📊 *Drop: -${dropPercentage.toFixed(2)}%*
${priceData.change24h >= 0 ? '📈' : '📉'} 24h: ${priceData.change24h >= 0 ? '+' : ''}${priceData.change24h}%

_Alert: ${new Date().toLocaleTimeString()}_`;
}

// Send price update to user
async function sendPriceUpdate(chatId, token) {
  const priceData = await getTokenPrice(TOKENS[token].id);
  
  if (!priceData) {
    return;
  }

  const message = formatPriceMessage(token, priceData);

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    // If user blocked bot or chat doesn't exist, remove them
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    }
  }
}

// Send updates for all user's subscribed tokens
async function sendUserUpdates(chatId, userPrefs) {
  if (!userPrefs.subscribed || userPrefs.tokens.length === 0) {
    return;
  }

  for (const token of userPrefs.tokens) {
    if (TOKENS[token]) {
      await sendPriceUpdate(chatId, token);
      // Small delay between messages
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// Send instant alert to user for price drop
async function sendPriceDropAlert(chatId, token, priceData, dropPercentage, previousPrice) {
  const tokenInfo = TOKENS[token];
  const message = formatAlertMessage(token, priceData, dropPercentage, previousPrice);

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    console.log(`Alert sent to user ${chatId} for ${tokenInfo.name} (${dropPercentage.toFixed(2)}% drop)`);
  } catch (error) {
    // If user blocked bot or chat doesn't exist, remove them
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    }
  }
}

// Check for price drops and send instant alerts
async function checkPriceDrops() {
  const priceHistory = await loadPriceHistory();
  const users = await loadUsers();
  
  // Check each token
  for (const [tokenKey, tokenInfo] of Object.entries(TOKENS)) {
    const currentPriceData = await getTokenPrice(tokenInfo.id);
    
    if (!currentPriceData) continue;
    
    const currentPrice = parseFloat(currentPriceData.price);
    const lastPrice = priceHistory[tokenKey]?.price;
    
    // Update price history
    priceHistory[tokenKey] = {
      price: currentPrice,
      timestamp: Date.now()
    };
    await savePriceHistory(priceHistory);
    
    // If we have a previous price, check for drop
    if (lastPrice && lastPrice > 0) {
      const dropPercentage = ((lastPrice - currentPrice) / lastPrice) * 100;
      
      // If price dropped more than 5%, send alerts to all users who have this token
      if (dropPercentage >= 5) {
        console.log(`🚨 Alert: ${tokenInfo.name} dropped ${dropPercentage.toFixed(2)}% (${lastPrice} -> ${currentPrice})`);
        
        // Find all users who have this token and are subscribed
        for (const [chatId, userPrefs] of Object.entries(users)) {
          if (userPrefs.subscribed && userPrefs.tokens.includes(tokenKey)) {
            await sendPriceDropAlert(chatId, tokenKey, currentPriceData, dropPercentage, lastPrice.toFixed(2));
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
  }
}

// Scheduled job to send updates
let scheduledJobs = {};

// Schedule updates for a user
function scheduleUserUpdates(chatId, userPrefs) {
  // Cancel existing job if any
  if (scheduledJobs[chatId]) {
    scheduledJobs[chatId].destroy();
    delete scheduledJobs[chatId];
  }

  if (!userPrefs.subscribed || userPrefs.tokens.length === 0) {
    return;
  }

  const intervalMinutes = userPrefs.interval || 1;
  const cronPattern = `*/${intervalMinutes} * * * *`;

  const job = cron.schedule(cronPattern, async () => {
    const userInfo = await getUserPreferences(chatId);
    const currentPrefs = { ...userInfo };
    delete currentPrefs.isNew;
    await sendUserUpdates(chatId, currentPrefs);
  });

  scheduledJobs[chatId] = job;
  console.log(`Scheduled updates for user ${chatId}: ${userPrefs.tokens.join(', ')} every ${intervalMinutes} minute(s)`);
}

// Initialize all user schedules
async function initializeSchedules() {
  const users = await loadUsers();
  for (const [chatId, prefs] of Object.entries(users)) {
    if (prefs.subscribed && prefs.tokens.length > 0) {
      scheduleUserUpdates(chatId, prefs);
    }
  }
}

// Command handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const isNew = userInfo.isNew;
  const prefs = { ...userInfo };
  delete prefs.isNew; // Remove isNew property for scheduleUserUpdates
  
  await updateUserPreferences(chatId, { subscribed: true });
  scheduleUserUpdates(chatId, prefs);

  // Notify admin if new user
  if (isNew && ADMIN_CHAT_ID) {
    await notifyAdminNewUser(
      chatId,
      msg.from?.username,
      msg.from?.first_name,
      msg.from?.last_name
    );
  }

  const welcomeMessage = `👋 *Welcome to Crypto Price Bot!*

Select which cryptocurrencies you want to track:
• /select - Choose tokens to monitor
• /interval - Set update interval
• /mytokens - View your current settings
• /stop - Stop receiving updates

🚨 *Instant Alerts:* You'll automatically receive instant alerts when any selected token drops 5% or more, regardless of your update interval!

_Use /select to get started!_`;

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/select/, async (msg) => {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  const keyboard = {
    inline_keyboard: Object.keys(TOKENS).map(token => {
      const tokenInfo = TOKENS[token];
      const isSelected = prefs.tokens.includes(token);
      return [{
        text: `${isSelected ? '✅' : '⬜'} ${tokenInfo.name} (${tokenInfo.symbol})`,
        callback_data: `toggle_${token}`
      }];
    })
  };

  await bot.sendMessage(chatId, 'Select tokens to monitor:', {
    reply_markup: keyboard
  });
});

bot.onText(/\/interval/, async (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: VALID_INTERVALS.map(interval => [{
      text: `${interval} minute${interval > 1 ? 's' : ''}`,
      callback_data: `interval_${interval}`
    }])
  };

  await bot.sendMessage(chatId, 'Choose update interval:', {
    reply_markup: keyboard
  });
});

bot.onText(/\/mytokens/, async (msg) => {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  if (prefs.tokens.length === 0) {
    await bot.sendMessage(chatId, '❌ You haven\'t selected any tokens yet.\n\nUse /select to choose tokens.');
    return;
  }

  const tokenList = prefs.tokens.map(t => {
    const tokenInfo = TOKENS[t];
    return `• ${tokenInfo.emoji} ${tokenInfo.name} (${tokenInfo.symbol})`;
  }).join('\n');

  const message = `📊 *Your Settings*

*Tokens:*\n${tokenList}

*Interval:* ${prefs.interval} minute${prefs.interval > 1 ? 's' : ''}

*Status:* ${prefs.subscribed ? '✅ Active' : '❌ Inactive'}`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  await updateUserPreferences(chatId, { subscribed: false });
  
  if (scheduledJobs[chatId]) {
    scheduledJobs[chatId].destroy();
    delete scheduledJobs[chatId];
  }

  await bot.sendMessage(chatId, '❌ Updates stopped. Use /start to resume.');
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Check if user is admin
  if (chatId.toString() !== ADMIN_CHAT_ID?.toString()) {
    await bot.sendMessage(chatId, '❌ Access denied. Admin only.');
    return;
  }

  const totalUsers = await getUserCount();
  const activeUsers = await getActiveUserCount();
  const users = await loadUsers();
  
  // Get token distribution
  const tokenStats = {};
  Object.values(users).forEach(user => {
    user.tokens.forEach(token => {
      tokenStats[token] = (tokenStats[token] || 0) + 1;
    });
  });

  const tokenList = Object.entries(tokenStats)
    .map(([token, count]) => {
      const tokenInfo = TOKENS[token];
      return tokenInfo ? `• ${tokenInfo.emoji} ${tokenInfo.name}: *${count}*` : '';
    })
    .filter(Boolean)
    .join('\n') || 'No tokens selected yet';

  const message = `📊 *Bot Statistics*

👥 *Users:*
• Total Users: *${totalUsers}*
• Active Users: *${activeUsers}*
• Inactive Users: *${totalUsers - activeUsers}*

🪙 *Token Distribution:*
${tokenList}

_Updated: ${new Date().toLocaleString()}_`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Handle callback queries (inline keyboard buttons)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('toggle_')) {
    const token = data.replace('toggle_', '');
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    
    const index = prefs.tokens.indexOf(token);
    if (index > -1) {
      prefs.tokens.splice(index, 1);
    } else {
      prefs.tokens.push(token);
    }
    
    await updateUserPreferences(chatId, { tokens: prefs.tokens });
    scheduleUserUpdates(chatId, prefs);
    
    const tokenInfo = TOKENS[token];
    const isSelected = prefs.tokens.includes(token);
    
    await bot.answerCallbackQuery(query.id, {
      text: `${isSelected ? 'Added' : 'Removed'} ${tokenInfo.name}`
    });
    
    // Update the message
    const keyboard = {
      inline_keyboard: Object.keys(TOKENS).map(t => {
        const tInfo = TOKENS[t];
        const selected = prefs.tokens.includes(t);
        return [{
          text: `${selected ? '✅' : '⬜'} ${tInfo.name} (${tInfo.symbol})`,
          callback_data: `toggle_${t}`
        }];
      })
    };
    
    await bot.editMessageReplyMarkup(keyboard, {
      chat_id: chatId,
      message_id: query.message.message_id
    });

  } else if (data.startsWith('interval_')) {
    const interval = parseInt(data.replace('interval_', ''));
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    
    await updateUserPreferences(chatId, { interval });
    scheduleUserUpdates(chatId, prefs);
    
    await bot.answerCallbackQuery(query.id, {
      text: `Interval set to ${interval} minute${interval > 1 ? 's' : ''}`
    });
    
    await bot.sendMessage(chatId, `✅ Update interval set to ${interval} minute${interval > 1 ? 's' : ''}.`);
  }
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
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

// Start bot
console.log('Bot started! Waiting for commands...');
initializeSchedules();

// Initialize price history for all tokens on startup
async function initializePriceHistory() {
  const priceHistory = await loadPriceHistory();
  let needsUpdate = false;
  
  for (const [tokenKey, tokenInfo] of Object.entries(TOKENS)) {
    if (!priceHistory[tokenKey]) {
      const priceData = await getTokenPrice(tokenInfo.id);
      if (priceData) {
        priceHistory[tokenKey] = {
          price: parseFloat(priceData.price),
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

// Schedule price drop monitoring (runs every minute)
cron.schedule('* * * * *', async () => {
  await checkPriceDrops();
});

// Initialize price history on startup
initializePriceHistory();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nBot shutting down...');
  Object.values(scheduledJobs).forEach(job => job.destroy());
  process.exit(0);
});
