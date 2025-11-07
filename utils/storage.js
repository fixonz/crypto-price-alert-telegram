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

// Get KOL token balance for a specific token
async function getKOLTokenBalance(kolAddress, tokenMint) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query(
        'SELECT * FROM kol_token_balances WHERE kol_address = $1 AND token_mint = $2',
        [kolAddress, tokenMint]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (error) {
      console.error('Error loading KOL token balance from database:', error.message);
      return null;
    }
  }
  
  // Fallback to JSON
  const KOL_BALANCES_FILE = path.join(__dirname, '..', 'kol_token_balances.json');
  try {
    const data = await fs.readFile(KOL_BALANCES_FILE, 'utf8');
    const balances = JSON.parse(data);
    const key = `${kolAddress}_${tokenMint}`;
    return balances[key] || null;
  } catch (error) {
    return null;
  }
}

// Get count of KOLs who have bought a specific token (for multi-KOL detection)
async function getKOLCountForToken(tokenMint) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query(
        'SELECT COUNT(DISTINCT kol_address) as kol_count FROM kol_token_balances WHERE token_mint = $1 AND first_buy_signature IS NOT NULL',
        [tokenMint]
      );
      
      return parseInt(result.rows[0]?.kol_count || 0);
    } catch (error) {
      console.error('Error counting KOLs for token:', error.message);
      return 0;
    }
  }
  
  // Fallback to JSON
  const KOL_BALANCES_FILE = path.join(__dirname, '..', 'kol_token_balances.json');
  try {
    const data = await fs.readFile(KOL_BALANCES_FILE, 'utf8');
    const balances = JSON.parse(data);
    const kolSet = new Set();
    for (const key in balances) {
      if (key.endsWith(`_${tokenMint}`) && balances[key].first_buy_signature) {
        const kolAddress = key.split('_')[0];
        kolSet.add(kolAddress);
      }
    }
    return kolSet.size;
  } catch (error) {
    return 0;
  }
}

// Get list of KOL names who have bought a token
async function getKOLsForToken(tokenMint) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query(
        'SELECT DISTINCT kol_address FROM kol_token_balances WHERE token_mint = $1 AND first_buy_signature IS NOT NULL',
        [tokenMint]
      );
      
      return result.rows.map(row => row.kol_address);
    } catch (error) {
      console.error('Error getting KOLs for token:', error.message);
      return [];
    }
  }
  
  // Fallback to JSON
  const KOL_BALANCES_FILE = path.join(__dirname, '..', 'kol_token_balances.json');
  try {
    const data = await fs.readFile(KOL_BALANCES_FILE, 'utf8');
    const balances = JSON.parse(data);
    const kolSet = new Set();
    for (const key in balances) {
      if (key.endsWith(`_${tokenMint}`) && balances[key].first_buy_signature) {
        const kolAddress = key.split('_')[0];
        kolSet.add(kolAddress);
      }
    }
    return Array.from(kolSet);
  } catch (error) {
    return [];
  }
}

// Check if we've already alerted on this transaction
async function hasAlertedOnTransaction(signature) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query(
        'SELECT signature FROM kol_alerted_transactions WHERE signature = $1',
        [signature]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error checking alerted transaction:', error.message);
      return false;
    }
  }
  
  // Fallback to JSON
  const ALERTED_FILE = path.join(__dirname, '..', 'kol_alerted_transactions.json');
  try {
    const data = await fs.readFile(ALERTED_FILE, 'utf8');
    const alerted = JSON.parse(data);
    return alerted[signature] === true;
  } catch (error) {
    return false;
  }
}

// Mark transaction as alerted
async function markTransactionAsAlerted(signature, kolAddress, tokenMint) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      await pool.query(`
        INSERT INTO kol_alerted_transactions (signature, kol_address, token_mint, alerted_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(signature) DO NOTHING
      `, [signature, kolAddress, tokenMint, Date.now()]);
      return;
    } catch (error) {
      console.error('Error marking transaction as alerted:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON
  const ALERTED_FILE = path.join(__dirname, '..', 'kol_alerted_transactions.json');
  try {
    let alerted = {};
    try {
      const data = await fs.readFile(ALERTED_FILE, 'utf8');
      alerted = JSON.parse(data);
    } catch (error) {
      // File doesn't exist yet
    }
    alerted[signature] = true;
    await fs.writeFile(ALERTED_FILE, JSON.stringify(alerted, null, 2), 'utf8');
  } catch (error) {
    console.error(`❌ Error saving alerted transactions:`, error.message);
    throw error;
  }
}

// Update KOL token balance (for buys and sells)
async function updateKOLTokenBalance(kolAddress, tokenMint, balanceChange, signature, isFirstBuy = false, buyPrice = null, solAmount = null) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      // Get current balance
      const current = await getKOLTokenBalance(kolAddress, tokenMint);
      const currentBalance = current ? parseFloat(current.balance) : 0;
      const currentCostBasis = current ? parseFloat(current.total_cost_basis || 0) : 0;
      const currentTokensBought = current ? parseFloat(current.total_tokens_bought || 0) : 0;
      const newBalance = Math.max(0, currentBalance + balanceChange); // Ensure balance doesn't go negative
      
      let newCostBasis = currentCostBasis;
      let newTokensBought = currentTokensBought;
      
      // If this is a buy, update cost basis
      if (balanceChange > 0 && buyPrice && solAmount) {
        const tokensBought = balanceChange;
        const costInSOL = solAmount;
        newCostBasis = currentCostBasis + costInSOL;
        newTokensBought = currentTokensBought + tokensBought;
      }
      
      if (isFirstBuy && !current) {
        // First time buying this token
        await pool.query(`
          INSERT INTO kol_token_balances (kol_address, token_mint, balance, first_buy_signature, first_buy_timestamp, first_buy_price, total_cost_basis, total_tokens_bought, last_updated)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT(kol_address, token_mint) DO UPDATE SET
            balance = EXCLUDED.balance,
            total_cost_basis = EXCLUDED.total_cost_basis,
            total_tokens_bought = EXCLUDED.total_tokens_bought,
            last_updated = EXCLUDED.last_updated
        `, [kolAddress, tokenMint, newBalance, signature, Date.now(), buyPrice || 0, newCostBasis, newTokensBought, Date.now()]);
      } else {
        // Update existing balance
        await pool.query(`
          INSERT INTO kol_token_balances (kol_address, token_mint, balance, total_cost_basis, total_tokens_bought, last_updated)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT(kol_address, token_mint) DO UPDATE SET
            balance = EXCLUDED.balance,
            total_cost_basis = EXCLUDED.total_cost_basis,
            total_tokens_bought = EXCLUDED.total_tokens_bought,
            last_updated = EXCLUDED.last_updated
        `, [kolAddress, tokenMint, newBalance, newCostBasis, newTokensBought, Date.now()]);
      }
      return newBalance;
    } catch (error) {
      console.error('Error updating KOL token balance in database:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON
  const KOL_BALANCES_FILE = path.join(__dirname, '..', 'kol_token_balances.json');
  try {
    let balances = {};
    try {
      const data = await fs.readFile(KOL_BALANCES_FILE, 'utf8');
      balances = JSON.parse(data);
    } catch (error) {
      // File doesn't exist yet, start with empty object
    }
    
    const key = `${kolAddress}_${tokenMint}`;
    const current = balances[key] || { balance: 0, total_cost_basis: 0, total_tokens_bought: 0 };
    const currentBalance = parseFloat(current.balance) || 0;
    const currentCostBasis = parseFloat(current.total_cost_basis || 0) || 0;
    const currentTokensBought = parseFloat(current.total_tokens_bought || 0) || 0;
    const newBalance = Math.max(0, currentBalance + balanceChange);
    
    let newCostBasis = currentCostBasis;
    let newTokensBought = currentTokensBought;
    
    // If this is a buy, update cost basis
    if (balanceChange > 0 && buyPrice && solAmount) {
      const tokensBought = balanceChange;
      const costInSOL = solAmount;
      newCostBasis = currentCostBasis + costInSOL;
      newTokensBought = currentTokensBought + tokensBought;
    }
    
    if (isFirstBuy && !current.first_buy_signature) {
      balances[key] = {
        balance: newBalance,
        first_buy_signature: signature,
        first_buy_timestamp: Date.now(),
        first_buy_price: buyPrice || 0,
        total_cost_basis: newCostBasis,
        total_tokens_bought: newTokensBought,
        last_updated: Date.now()
      };
    } else {
      balances[key] = {
        ...current,
        balance: newBalance,
        total_cost_basis: newCostBasis,
        total_tokens_bought: newTokensBought,
        last_updated: Date.now()
      };
    }
    
    await fs.writeFile(KOL_BALANCES_FILE, JSON.stringify(balances, null, 2), 'utf8');
    return newBalance;
  } catch (error) {
    console.error(`❌ Error saving KOL token balances to ${KOL_BALANCES_FILE}:`, error.message);
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
  saveKOLSignature,
  getKOLTokenBalance,
  updateKOLTokenBalance,
  hasAlertedOnTransaction,
  markTransactionAsAlerted,
  getKOLCountForToken,
  getKOLsForToken
};

