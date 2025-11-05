const fs = require('fs').promises;
const path = require('path');

// Use SQLite if enabled (default on Render/deployment, can be disabled with USE_JSON_STORAGE=true)
const USE_SQLITE = process.env.USE_JSON_STORAGE !== 'true';

let db = null;
if (USE_SQLITE) {
  try {
    const { initDatabase, getDatabase } = require('./database');
    initDatabase();
    db = getDatabase();
    console.log('📊 Using SQLite database for persistent storage');
  } catch (error) {
    console.warn('⚠️ SQLite initialization failed, falling back to JSON files:', error.message);
    db = null;
  }
}

// In-memory cache for temporary flags (like waitingForTokenAddress)
// This is needed because SQLite doesn't store temporary flags
const tempFlagsCache = {};

// User preferences file (fallback)
const USERS_FILE = path.join(__dirname, '..', 'users.json');

// Price history file (fallback)
const PRICES_FILE = path.join(__dirname, '..', 'prices.json');

// Load user preferences
async function loadUsers() {
  if (db) {
    try {
      const rows = db.prepare('SELECT * FROM users').all();
      const users = {};
      for (const row of rows) {
        users[row.chat_id] = {
          subscribed: Boolean(row.subscribed),
          tokens: JSON.parse(row.tokens || '[]'),
          customTokens: JSON.parse(row.custom_tokens || '[]'),
          interval: row.interval_minutes || 1,
          createdAt: row.created_at || Date.now()
        };
      }
      return users;
    } catch (error) {
      console.error('Error loading users from database:', error.message);
      return {};
    }
  }
  
  // Fallback to JSON
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save user preferences
async function saveUsers(users) {
  if (db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO users (chat_id, subscribed, tokens, custom_tokens, interval_minutes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          subscribed = excluded.subscribed,
          tokens = excluded.tokens,
          custom_tokens = excluded.custom_tokens,
          interval_minutes = excluded.interval_minutes,
          updated_at = excluded.updated_at
      `);
      
      for (const [chatId, user] of Object.entries(users)) {
        stmt.run(
          chatId,
          user.subscribed ? 1 : 0,
          JSON.stringify(user.tokens || []),
          JSON.stringify(user.customTokens || []),
          user.interval || 1,
          user.createdAt || Date.now(),
          Date.now()
        );
      }
      return;
    } catch (error) {
      console.error('Error saving users to database:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON
  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log(`✅ Saved users data to: ${USERS_FILE}`);
  } catch (error) {
    console.error(`❌ Error saving users data to ${USERS_FILE}:`, error.message);
    throw error;
  }
}

// Load price history
async function loadPriceHistory() {
  if (db) {
    try {
      const rows = db.prepare('SELECT * FROM price_history').all();
      const history = {};
      for (const row of rows) {
        history[row.token_key] = {
          price: row.price,
          timestamp: row.timestamp,
          history: JSON.parse(row.history || '[]')
        };
      }
      return history;
    } catch (error) {
      console.error('Error loading price history from database:', error.message);
      return {};
    }
  }
  
  // Fallback to JSON
  try {
    const data = await fs.readFile(PRICES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save price history
async function savePriceHistory(history) {
  if (db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO price_history (token_key, price, timestamp, history)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token_key) DO UPDATE SET
          price = excluded.price,
          timestamp = excluded.timestamp,
          history = excluded.history
      `);
      
      for (const [tokenKey, data] of Object.entries(history)) {
        stmt.run(
          tokenKey,
          data.price || null,
          data.timestamp || Date.now(),
          JSON.stringify(data.history || [])
        );
      }
      return;
    } catch (error) {
      console.error('Error saving price history to database:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON
  try {
    await fs.writeFile(PRICES_FILE, JSON.stringify(history, null, 2), 'utf8');
    // Don't log every price save (too verbose), only log occasionally
    if (Math.random() < 0.01) {
      console.log(`✅ Saved price history to: ${PRICES_FILE}`);
    }
  } catch (error) {
    console.error(`❌ Error saving price history to ${PRICES_FILE}:`, error.message);
    throw error;
  }
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
      customTokens: [], // Custom Solana tokens with addresses
      interval: 1, // default 1 minute
      createdAt: Date.now()
    };
    await saveUsers(users);
    console.log(`📝 Created new user entry for chatId: ${chatId}`);
  }
  // Ensure customTokens exists for existing users
  if (!users[chatId].customTokens) {
    users[chatId].customTokens = [];
    await saveUsers(users);
  }
  
  // Add temporary flags from cache
  const userPrefs = { ...users[chatId] };
  if (tempFlagsCache[chatId]) {
    Object.assign(userPrefs, tempFlagsCache[chatId]);
  }
  
  return { ...userPrefs, isNew };
}

// Set temporary flag (for waitingForTokenAddress, etc.)
function setTempFlag(chatId, flag, value) {
  if (!tempFlagsCache[chatId]) {
    tempFlagsCache[chatId] = {};
  }
  tempFlagsCache[chatId][flag] = value;
}

// Get temporary flag
function getTempFlag(chatId, flag) {
  return tempFlagsCache[chatId]?.[flag];
}

// Clear temporary flag
function clearTempFlag(chatId, flag) {
  if (tempFlagsCache[chatId]) {
    delete tempFlagsCache[chatId][flag];
  }
}

// Update user preferences
async function updateUserPreferences(chatId, updates) {
  const users = await loadUsers();
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      customTokens: [],
      interval: 1,
      createdAt: Date.now()
    };
  }
  // Ensure customTokens exists
  if (!users[chatId].customTokens) {
    users[chatId].customTokens = [];
  }
  Object.assign(users[chatId], updates);
  await saveUsers(users);
  return users[chatId];
}

module.exports = {
  loadUsers,
  saveUsers,
  loadPriceHistory,
  savePriceHistory,
  getUserCount,
  getActiveUserCount,
  isNewUser,
  getUserPreferences,
  updateUserPreferences,
  setTempFlag,
  getTempFlag,
  clearTempFlag
};

