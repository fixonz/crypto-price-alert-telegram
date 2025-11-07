const fs = require('fs').promises;
const path = require('path');

// Use Postgres (Neon) if DATABASE_URL is set, otherwise fall back to JSON
let db = null;
let dbInitialized = false;

// Initialize database connection (call this before using db)
async function ensureDatabaseInitialized() {
  if (dbInitialized) return;
  
  if (process.env.DATABASE_URL && process.env.USE_JSON_STORAGE !== 'true') {
    try {
      const { initDatabase } = require('./database');
      db = await initDatabase();
      if (db) {
        console.log('📊 Using Neon Postgres database for persistent storage');
      }
    } catch (error) {
      console.warn('⚠️ Database initialization failed, falling back to JSON files:', error.message);
      db = null;
    }
  }
  dbInitialized = true;
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
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query('SELECT * FROM users');
      const users = {};
      for (const row of result.rows) {
        users[row.chat_id] = {
          subscribed: Boolean(row.subscribed),
          tokens: JSON.parse(row.tokens || '[]'),
          customTokens: JSON.parse(row.custom_tokens || '[]'),
          trackedKOLs: JSON.parse(row.tracked_kols || '[]'),
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
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        for (const [chatId, user] of Object.entries(users)) {
          await client.query(`
            INSERT INTO users (chat_id, subscribed, tokens, custom_tokens, tracked_kols, interval_minutes, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT(chat_id) DO UPDATE SET
              subscribed = EXCLUDED.subscribed,
              tokens = EXCLUDED.tokens,
              custom_tokens = EXCLUDED.custom_tokens,
              tracked_kols = EXCLUDED.tracked_kols,
              interval_minutes = EXCLUDED.interval_minutes,
              updated_at = EXCLUDED.updated_at
          `, [
            chatId,
            user.subscribed || false,
            JSON.stringify(user.tokens || []),
            JSON.stringify(user.customTokens || []),
            JSON.stringify(user.trackedKOLs || []),
            user.interval || 1,
            user.createdAt || Date.now(),
            Date.now()
          ]);
        }
        
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
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
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query('SELECT * FROM price_history');
      const history = {};
      for (const row of result.rows) {
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
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        for (const [tokenKey, data] of Object.entries(history)) {
          await client.query(`
            INSERT INTO price_history (token_key, price, timestamp, history)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT(token_key) DO UPDATE SET
              price = EXCLUDED.price,
              timestamp = EXCLUDED.timestamp,
              history = EXCLUDED.history
          `, [
            tokenKey,
            data.price || null,
            data.timestamp || Date.now(),
            JSON.stringify(data.history || [])
          ]);
        }
        
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
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
      trackedKOLs: [], // Tracked KOL addresses
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
  // Ensure trackedKOLs exists for existing users
  if (!users[chatId].trackedKOLs) {
    users[chatId].trackedKOLs = [];
    await saveUsers(users);
  }
  
  // Debug: Log what we're loading
  console.log(`Loading preferences for user ${chatId}:`, {
    hasTokens: (users[chatId].tokens || []).length > 0,
    hasCustomTokens: (users[chatId].customTokens || []).length > 0,
    customTokensCount: (users[chatId].customTokens || []).length,
    customTokens: (users[chatId].customTokens || []).map(ct => ({ symbol: ct.symbol, address: ct.address?.substring(0, 8) + '...' }))
  });
  
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

// Load KOL last processed signatures
async function loadKOLSignatures() {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query('SELECT * FROM kol_signatures');
      const signatures = {};
      for (const row of result.rows) {
        signatures[row.kol_address] = row.last_signature;
      }
      return signatures;
    } catch (error) {
      console.error('Error loading KOL signatures from database:', error.message);
      return {};
    }
  }
  
  // Fallback to JSON
  const KOL_SIGNATURES_FILE = path.join(__dirname, '..', 'kol_signatures.json');
  try {
    const data = await fs.readFile(KOL_SIGNATURES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save KOL last processed signature
async function saveKOLSignature(kolAddress, signature) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      await pool.query(`
        INSERT INTO kol_signatures (kol_address, last_signature, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(kol_address) DO UPDATE SET
          last_signature = EXCLUDED.last_signature,
          updated_at = EXCLUDED.updated_at
      `, [kolAddress, signature, Date.now()]);
      return;
    } catch (error) {
      console.error('Error saving KOL signature to database:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON
  const KOL_SIGNATURES_FILE = path.join(__dirname, '..', 'kol_signatures.json');
  try {
    const signatures = await loadKOLSignatures();
    signatures[kolAddress] = signature;
    await fs.writeFile(KOL_SIGNATURES_FILE, JSON.stringify(signatures, null, 2), 'utf8');
  } catch (error) {
    console.error(`❌ Error saving KOL signatures to ${KOL_SIGNATURES_FILE}:`, error.message);
    throw error;
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
      trackedKOLs: [],
      interval: 1,
      createdAt: Date.now()
    };
  }
  // Ensure customTokens exists
  if (!users[chatId].customTokens) {
    users[chatId].customTokens = [];
  }
  // Ensure trackedKOLs exists
  if (!users[chatId].trackedKOLs) {
    users[chatId].trackedKOLs = [];
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
  clearTempFlag,
  loadKOLSignatures,
  saveKOLSignature
};

