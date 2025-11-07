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

// Save transaction to kol_transactions table for pattern analysis
async function saveKOLTransaction(signature, kolAddress, tokenMint, transactionType, tokenAmount, solAmount, tokenPrice, timestamp, marketCap = null) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      await pool.query(`
        INSERT INTO kol_transactions 
        (signature, kol_address, token_mint, transaction_type, token_amount, sol_amount, token_price, market_cap, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT(signature) DO UPDATE SET
          token_amount = EXCLUDED.token_amount,
          sol_amount = EXCLUDED.sol_amount,
          token_price = EXCLUDED.token_price,
          market_cap = EXCLUDED.market_cap
      `, [signature, kolAddress, tokenMint, transactionType, tokenAmount, solAmount, tokenPrice || null, marketCap, timestamp]);
      return;
    } catch (error) {
      console.error('Error saving KOL transaction:', error.message);
      throw error;
    }
  }
  
  // Fallback to JSON (optional, for pattern analysis we prefer DB)
  // JSON fallback can be added if needed
}

// Get transaction history for a KOL and token (for pattern analysis)
// If tokenMint is null, returns all transactions for the KOL
async function getKOLTransactionHistory(kolAddress, tokenMint, limit = 100) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      let result;
      if (tokenMint) {
        result = await pool.query(`
          SELECT * FROM kol_transactions
          WHERE kol_address = $1 AND token_mint = $2
          ORDER BY timestamp DESC
          LIMIT $3
        `, [kolAddress, tokenMint, limit]);
      } else {
        // Get all transactions for this KOL
        result = await pool.query(`
          SELECT * FROM kol_transactions
          WHERE kol_address = $1
          ORDER BY timestamp DESC
          LIMIT $2
        `, [kolAddress, limit]);
      }
      
      return result.rows;
    } catch (error) {
      console.error('Error getting KOL transaction history:', error.message);
      return [];
    }
  }
  return [];
}

// Calculate hold time for a token (time between buy and sell)
// Calculate realized PnL using FIFO (First In First Out) matching
// This properly matches sells against buys in chronological order
async function calculateRealizedPnL(kolAddress, tokenMint) {
  const history = await getKOLTransactionHistory(kolAddress, tokenMint, 1000);
  
  if (history.length === 0) return { realizedPnL: 0, realizedPnLPercentage: 0, totalCostBasis: 0, totalProceeds: 0 };
  
  // Sort by timestamp ascending (oldest first)
  const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);
  
  // FIFO queue: array of { tokens, costBasis, timestamp }
  const buyQueue = [];
  let totalCostBasis = 0;
  let totalProceeds = 0;
  let realizedPnL = 0;
  
  for (const tx of sortedHistory) {
    const tokenAmount = parseFloat(tx.token_amount || 0);
    const solAmount = parseFloat(tx.sol_amount || 0);
    
    if (tx.transaction_type === 'buy') {
      // Add to buy queue
      buyQueue.push({
        tokens: tokenAmount,
        costBasis: solAmount,
        timestamp: tx.timestamp
      });
    } else if (tx.transaction_type === 'sell') {
      // Match against buys using FIFO
      let tokensToSell = tokenAmount;
      const sellProceeds = solAmount;
      let sellCostBasis = 0;
      
      // Match sells against oldest buys first
      while (tokensToSell > 0.000001 && buyQueue.length > 0) {
        const oldestBuy = buyQueue[0];
        
        if (oldestBuy.tokens <= tokensToSell) {
          // Use entire buy lot
          const costBasisForThisLot = oldestBuy.costBasis;
          sellCostBasis += costBasisForThisLot;
          tokensToSell -= oldestBuy.tokens;
          buyQueue.shift(); // Remove from queue
        } else {
          // Use partial buy lot (proportional)
          const proportion = tokensToSell / oldestBuy.tokens;
          const costBasisForThisLot = oldestBuy.costBasis * proportion;
          sellCostBasis += costBasisForThisLot;
          oldestBuy.tokens -= tokensToSell;
          oldestBuy.costBasis -= costBasisForThisLot;
          tokensToSell = 0;
        }
      }
      
      // Calculate PnL for this sell
      if (sellCostBasis > 0) {
        const pnl = sellProceeds - sellCostBasis;
        realizedPnL += pnl;
        totalCostBasis += sellCostBasis;
        totalProceeds += sellProceeds;
      }
    }
  }
  
  const realizedPnLPercentage = totalCostBasis > 0 ? ((realizedPnL / totalCostBasis) * 100) : 0;
  
  return {
    realizedPnL,
    realizedPnLPercentage,
    totalCostBasis,
    totalProceeds,
    remainingBuys: buyQueue.length,
    remainingTokens: buyQueue.reduce((sum, buy) => sum + buy.tokens, 0)
  };
}

// Calculate hold time for a token (time between buy and sell)
async function calculateHoldTime(kolAddress, tokenMint) {
  const history = await getKOLTransactionHistory(kolAddress, tokenMint, 50);
  
  if (history.length < 2) return null;
  
  // Find most recent buy and sell
  let lastBuy = null;
  let lastSell = null;
  
  for (const tx of history) {
    if (tx.transaction_type === 'buy' && !lastBuy) {
      lastBuy = tx;
    }
    if (tx.transaction_type === 'sell' && !lastSell) {
      lastSell = tx;
    }
  }
  
  // If we have a buy but no sell yet, calculate time since buy
  if (lastBuy && !lastSell) {
    const holdTimeMs = Date.now() - (lastBuy.timestamp * 1000);
    return holdTimeMs / 1000; // Return in seconds
  }
  
  // If we have both buy and sell, calculate time between them
  if (lastBuy && lastSell && lastBuy.timestamp > lastSell.timestamp) {
    const holdTimeMs = (lastBuy.timestamp - lastSell.timestamp) * 1000;
    return holdTimeMs / 1000; // Return in seconds
  }
  
  return null;
}

// Analyze token pattern - check if it's a "good" token based on KOL behavior
async function analyzeTokenPattern(tokenMint) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      // Get all transactions for this token
      const result = await pool.query(`
        SELECT kol_address, transaction_type, timestamp, sol_amount
        FROM kol_transactions
        WHERE token_mint = $1
        ORDER BY timestamp DESC
        LIMIT 100
      `, [tokenMint]);
      
      const transactions = result.rows;
      if (transactions.length === 0) return null;
      
      // Group by KOL
      const kolTransactions = {};
      for (const tx of transactions) {
        if (!kolTransactions[tx.kol_address]) {
          kolTransactions[tx.kol_address] = [];
        }
        kolTransactions[tx.kol_address].push(tx);
      }
      
      // Analyze patterns
      let kolCount = Object.keys(kolTransactions).length;
      let totalBuys = transactions.filter(tx => tx.transaction_type === 'buy').length;
      let totalSells = transactions.filter(tx => tx.transaction_type === 'sell').length;
      
      // Calculate average hold times
      let holdTimes = [];
      for (const [kolAddress, txs] of Object.entries(kolTransactions)) {
        const holdTime = await calculateHoldTime(kolAddress, tokenMint);
        if (holdTime !== null && holdTime > 0) {
          holdTimes.push(holdTime);
        }
      }
      
      const avgHoldTime = holdTimes.length > 0 
        ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length 
        : null;
      
      // Check if KOLs are holding (bought but haven't sold)
      let holdingKOLs = 0;
      for (const [kolAddress, txs] of Object.entries(kolTransactions)) {
        const lastTx = txs[0]; // Most recent transaction
        if (lastTx.transaction_type === 'buy') {
          holdingKOLs++;
        }
      }
      
      return {
        kolCount,
        totalBuys,
        totalSells,
        avgHoldTime,
        holdingKOLs,
        buySellRatio: totalSells > 0 ? totalBuys / totalSells : totalBuys,
        isGoodToken: avgHoldTime !== null && avgHoldTime > 30 && holdingKOLs > 0 // Hold > 30s and still holding
      };
    } catch (error) {
      console.error('Error analyzing token pattern:', error.message);
      return null;
    }
  }
  return null;
}

// Save token performance snapshot (price, market cap, volume) for historical analysis
async function saveTokenPerformance(tokenMint, price, marketCap, volume24h) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const timestamp = Math.floor(Date.now() / 1000);
      
      await pool.query(`
        INSERT INTO token_performance (token_mint, timestamp, price, market_cap, volume_24h)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(token_mint, timestamp) DO UPDATE SET
          price = EXCLUDED.price,
          market_cap = EXCLUDED.market_cap,
          volume_24h = EXCLUDED.volume_24h
      `, [tokenMint, timestamp, price || null, marketCap || null, volume24h || null]);
      return;
    } catch (error) {
      console.error('Error saving token performance:', error.message);
      throw error;
    }
  }
}

// Analyze token performance over time period (e.g., 24h, 7d)
async function analyzeTokenPerformance(tokenMint, days = 7) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const now = Math.floor(Date.now() / 1000);
      const startTime = now - (days * 24 * 60 * 60);
      
      // Get price history
      const priceHistory = await pool.query(`
        SELECT price, market_cap, timestamp
        FROM token_performance
        WHERE token_mint = $1 AND timestamp >= $2
        ORDER BY timestamp ASC
      `, [tokenMint, startTime]);
      
      // Get transaction history
      const txHistory = await pool.query(`
        SELECT transaction_type, sol_amount, token_price, timestamp
        FROM kol_transactions
        WHERE token_mint = $1 AND timestamp >= $2
        ORDER BY timestamp ASC
      `, [tokenMint, startTime]);
      
      if (priceHistory.rows.length === 0 && txHistory.rows.length === 0) {
        return null;
      }
      
      // Calculate price changes
      let priceChange24h = null;
      let priceChange7d = null;
      let maxPrice = null;
      let minPrice = null;
      let peakMarketCap = null;
      
      if (priceHistory.rows.length > 0) {
        const prices = priceHistory.rows.map(r => r.price).filter(p => p !== null);
        const marketCaps = priceHistory.rows.map(r => r.market_cap).filter(m => m !== null);
        
        if (prices.length > 0) {
          maxPrice = Math.max(...prices);
          minPrice = Math.min(...prices);
          
          // Find price 24h and 7d ago
          const price24hAgo = priceHistory.rows.find(r => r.timestamp <= now - 24*60*60)?.price;
          const price7dAgo = priceHistory.rows.find(r => r.timestamp <= now - 7*24*60*60)?.price;
          const currentPrice = prices[prices.length - 1];
          
          if (price24hAgo && currentPrice) {
            priceChange24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;
          }
          if (price7dAgo && currentPrice) {
            priceChange7d = ((currentPrice - price7dAgo) / price7dAgo) * 100;
          }
        }
        
        if (marketCaps.length > 0) {
          peakMarketCap = Math.max(...marketCaps);
        }
      }
      
      // Analyze transactions
      const buys = txHistory.rows.filter(tx => tx.transaction_type === 'buy');
      const sells = txHistory.rows.filter(tx => tx.transaction_type === 'sell');
      
      // Calculate average hold times
      const kolTransactions = {};
      for (const tx of txHistory.rows) {
        // Group by KOL (we'd need kol_address, but for now use timestamp patterns)
        // This is simplified - in real implementation, we'd track by KOL
      }
      
      return {
        tokenMint,
        periodDays: days,
        priceChange24h,
        priceChange7d,
        maxPrice,
        minPrice,
        peakMarketCap,
        totalBuys: buys.length,
        totalSells: sells.length,
        buyVolume: buys.reduce((sum, tx) => sum + (tx.sol_amount || 0), 0),
        sellVolume: sells.reduce((sum, tx) => sum + (tx.sol_amount || 0), 0),
        priceHistory: priceHistory.rows
      };
    } catch (error) {
      console.error('Error analyzing token performance:', error.message);
      return null;
    }
  }
  return null;
}

// Get winning tokens based on analysis (high score tokens)
async function getWinningTokens(limit = 10, minDays = 1) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      // Get tokens analyzed in the last N days
      const now = Math.floor(Date.now() / 1000);
      const minAnalysisDate = now - (minDays * 24 * 60 * 60);
      
      const result = await pool.query(`
        SELECT * FROM token_analysis
        WHERE analysis_date >= $1 AND is_winner = true
        ORDER BY winner_score DESC
        LIMIT $2
      `, [minAnalysisDate, limit]);
      
      return result.rows;
    } catch (error) {
      console.error('Error getting winning tokens:', error.message);
      return [];
    }
  }
  return [];
}

// Run comprehensive long-term analysis on all tokens
async function runLongTermAnalysis(days = 7) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      console.log(`📊 Running long-term analysis for ${days} days...`);
      
      // Get all unique tokens that have transactions
      const tokensResult = await pool.query(`
        SELECT DISTINCT token_mint 
        FROM kol_transactions
        WHERE timestamp >= $1
      `, [Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60)]);
      
      const tokens = tokensResult.rows.map(r => r.token_mint);
      console.log(`  Found ${tokens.length} tokens to analyze`);
      
      const analysisResults = [];
      
      for (const tokenMint of tokens) {
        try {
          // Get transaction pattern
          const pattern = await analyzeTokenPattern(tokenMint);
          
          // Get performance data
          const performance = await analyzeTokenPerformance(tokenMint, days);
          
          if (!pattern && !performance) continue;
          
          // Calculate winner score
          let winnerScore = 0;
          let isWinner = false;
          
          // Score factors:
          // 1. Multiple KOLs (more = better)
          if (pattern) {
            winnerScore += pattern.kolCount * 10;
            
            // 2. High hold rate (KOLs still holding)
            winnerScore += pattern.holdingKOLs * 15;
            
            // 3. Good buy/sell ratio (more buys than sells)
            if (pattern.buySellRatio > 2) {
              winnerScore += 20;
            }
            
            // 4. Long average hold time
            if (pattern.avgHoldTime && pattern.avgHoldTime > 60) {
              winnerScore += Math.min(pattern.avgHoldTime / 10, 50); // Max 50 points
            }
          }
          
          // 5. Price appreciation
          if (performance) {
            if (performance.priceChange24h > 0) {
              winnerScore += Math.min(performance.priceChange24h, 30); // Max 30 points
            }
            if (performance.priceChange7d > 0) {
              winnerScore += Math.min(performance.priceChange7d / 2, 50); // Max 50 points
            }
            
            // 6. High peak market cap
            if (performance.peakMarketCap) {
              if (performance.peakMarketCap > 1000000) { // > $1M
                winnerScore += 20;
              }
              if (performance.peakMarketCap > 10000000) { // > $10M
                winnerScore += 30;
              }
          }
          }
          
          // Mark as winner if score > threshold
          isWinner = winnerScore >= 50; // Minimum score to be a winner
          
          // Save analysis
          const analysisDate = Math.floor(Date.now() / 1000);
          const analysisData = JSON.stringify({
            pattern,
            performance,
            winnerScore,
            analyzedAt: new Date().toISOString()
          });
          
          await pool.query(`
            INSERT INTO token_analysis (
              token_mint, analysis_date, kol_count, total_buys, total_sells,
              avg_hold_time, holding_kols, price_change_24h, price_change_7d,
              max_price, min_price, peak_market_cap, is_winner, winner_score, analysis_data
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT(token_mint) DO UPDATE SET
              analysis_date = EXCLUDED.analysis_date,
              kol_count = EXCLUDED.kol_count,
              total_buys = EXCLUDED.total_buys,
              total_sells = EXCLUDED.total_sells,
              avg_hold_time = EXCLUDED.avg_hold_time,
              holding_kols = EXCLUDED.holding_kols,
              price_change_24h = EXCLUDED.price_change_24h,
              price_change_7d = EXCLUDED.price_change_7d,
              max_price = EXCLUDED.max_price,
              min_price = EXCLUDED.min_price,
              peak_market_cap = EXCLUDED.peak_market_cap,
              is_winner = EXCLUDED.is_winner,
              winner_score = EXCLUDED.winner_score,
              analysis_data = EXCLUDED.analysis_data,
              updated_at = EXTRACT(EPOCH FROM NOW()) * 1000
          `, [
            tokenMint,
            analysisDate,
            pattern?.kolCount || 0,
            pattern?.totalBuys || 0,
            pattern?.totalSells || 0,
            pattern?.avgHoldTime || null,
            pattern?.holdingKOLs || 0,
            performance?.priceChange24h || null,
            performance?.priceChange7d || null,
            performance?.maxPrice || null,
            performance?.minPrice || null,
            performance?.peakMarketCap || null,
            isWinner,
            winnerScore,
            analysisData
          ]);
          
          if (isWinner) {
            analysisResults.push({
              tokenMint,
              winnerScore,
              kolCount: pattern?.kolCount || 0,
              priceChange7d: performance?.priceChange7d || null
            });
          }
          
        } catch (error) {
          console.error(`  Error analyzing token ${tokenMint.substring(0, 8)}...:`, error.message);
        }
      }
      
      console.log(`✅ Analysis complete. Found ${analysisResults.length} winning tokens`);
      return {
        totalAnalyzed: tokens.length,
        winnersFound: analysisResults.length,
        winners: analysisResults.sort((a, b) => b.winnerScore - a.winnerScore)
      };
    } catch (error) {
      console.error('Error running long-term analysis:', error.message);
      throw error;
    }
  }
  return null;
}

// Update KOL behavior pattern based on transactions
async function updateKOLBehaviorPattern(kolAddress) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      // Get all transactions for this KOL
      const transactions = await pool.query(`
        SELECT transaction_type, sol_amount, token_amount, timestamp
        FROM kol_transactions
        WHERE kol_address = $1
        ORDER BY timestamp DESC
        LIMIT 100
      `, [kolAddress]);
      
      if (transactions.rows.length === 0) return null;
      
      const buys = transactions.rows.filter(tx => tx.transaction_type === 'buy');
      const sells = transactions.rows.filter(tx => tx.transaction_type === 'sell');
      
      // Calculate average buy/sell sizes
      const avgBuySize = buys.length > 0 
        ? buys.reduce((sum, tx) => sum + (tx.sol_amount || 0), 0) / buys.length 
        : 0;
      const avgSellSize = sells.length > 0
        ? sells.reduce((sum, tx) => sum + (tx.sol_amount || 0), 0) / sells.length
        : 0;
      
      // Get typical buy sizes (most common amounts)
      const buySizes = buys.map(tx => tx.sol_amount || 0).filter(s => s > 0);
      const buySizeCounts = {};
      buySizes.forEach(size => {
        const rounded = Math.round(size * 100) / 100; // Round to 0.01
        buySizeCounts[rounded] = (buySizeCounts[rounded] || 0) + 1;
      });
      const typicalBuySizes = Object.entries(buySizeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([size]) => parseFloat(size));
      
      // Get typical sell sizes
      const sellSizes = sells.map(tx => tx.sol_amount || 0).filter(s => s > 0);
      const sellSizeCounts = {};
      sellSizes.forEach(size => {
        const rounded = Math.round(size * 100) / 100;
        sellSizeCounts[rounded] = (sellSizeCounts[rounded] || 0) + 1;
      });
      const typicalSellSizes = Object.entries(sellSizeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([size]) => parseFloat(size));
      
      // Calculate hold times
      const holdTimes = [];
      for (let i = 0; i < transactions.rows.length - 1; i++) {
        const tx1 = transactions.rows[i];
        const tx2 = transactions.rows[i + 1];
        
        if (tx1.transaction_type === 'sell' && tx2.transaction_type === 'buy' && tx1.token_amount && tx2.token_amount) {
          // Check if same token
          const token1 = await pool.query(`SELECT token_mint FROM kol_transactions WHERE signature = $1`, [tx1.signature || '']);
          const token2 = await pool.query(`SELECT token_mint FROM kol_transactions WHERE signature = $1`, [tx2.signature || '']);
          
          if (token1.rows[0]?.token_mint === token2.rows[0]?.token_mint) {
            const holdTime = tx1.timestamp - tx2.timestamp; // seconds
            if (holdTime > 0 && holdTime < 86400) { // Less than 24 hours
              holdTimes.push(holdTime);
            }
          }
        }
      }
      
      const avgHoldTime = holdTimes.length > 0
        ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
        : null;
      const maxHoldTime = holdTimes.length > 0 ? Math.max(...holdTimes) : null;
      const minHoldTime = holdTimes.length > 0 ? Math.min(...holdTimes) : null;
      
      // Save pattern
      await pool.query(`
        INSERT INTO kol_behavior_patterns (
          kol_address, avg_buy_size, avg_sell_size, avg_hold_time,
          typical_buy_sizes, typical_sell_sizes, max_hold_time, min_hold_time,
          buy_count, sell_count, total_tokens_traded, last_updated
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT(kol_address) DO UPDATE SET
          avg_buy_size = EXCLUDED.avg_buy_size,
          avg_sell_size = EXCLUDED.avg_sell_size,
          avg_hold_time = EXCLUDED.avg_hold_time,
          typical_buy_sizes = EXCLUDED.typical_buy_sizes,
          typical_sell_sizes = EXCLUDED.typical_sell_sizes,
          max_hold_time = EXCLUDED.max_hold_time,
          min_hold_time = EXCLUDED.min_hold_time,
          buy_count = EXCLUDED.buy_count,
          sell_count = EXCLUDED.sell_count,
          total_tokens_traded = EXCLUDED.total_tokens_traded,
          last_updated = EXCLUDED.last_updated
      `, [
        kolAddress,
        avgBuySize,
        avgSellSize,
        avgHoldTime,
        JSON.stringify(typicalBuySizes),
        JSON.stringify(typicalSellSizes),
        maxHoldTime,
        minHoldTime,
        buys.length,
        sells.length,
        transactions.rows.length,
        Date.now() // last_updated - missing parameter!
      ]);
      
      return {
        avgBuySize,
        avgSellSize,
        avgHoldTime,
        typicalBuySizes,
        typicalSellSizes,
        maxHoldTime,
        minHoldTime
      };
    } catch (error) {
      console.error('Error updating KOL behavior pattern:', error.message);
      return null;
    }
  }
  return null;
}

// Get KOL behavior pattern
async function getKOLBehaviorPattern(kolAddress) {
  await ensureDatabaseInitialized();
  if (db) {
    try {
      const { getDatabase } = require('./database');
      const pool = await getDatabase();
      if (!pool) throw new Error('Database not initialized');
      
      const result = await pool.query(`
        SELECT * FROM kol_behavior_patterns WHERE kol_address = $1
      `, [kolAddress]);
      
      if (result.rows.length > 0) {
        const pattern = result.rows[0];
        return {
          avgBuySize: pattern.avg_buy_size,
          avgSellSize: pattern.avg_sell_size,
          avgHoldTime: pattern.avg_hold_time,
          typicalBuySizes: JSON.parse(pattern.typical_buy_sizes || '[]'),
          typicalSellSizes: JSON.parse(pattern.typical_sell_sizes || '[]'),
          maxHoldTime: pattern.max_hold_time,
          minHoldTime: pattern.min_hold_time
        };
      }
    } catch (error) {
      console.error('Error getting KOL behavior pattern:', error.message);
    }
  }
  return null;
}

// Detect if current transaction deviates from KOL's normal pattern
async function detectKOLDeviation(kolAddress, transactionType, solAmount, tokenMint) {
  const pattern = await getKOLBehaviorPattern(kolAddress);
  
  if (!pattern || !pattern.typicalBuySizes || pattern.typicalBuySizes.length === 0) {
    // No pattern yet, update it
    await updateKOLBehaviorPattern(kolAddress);
    return null;
  }
  
  const deviations = [];
  
  // Get recent transaction sequence for this token to detect pattern deviations
  const { getDatabase } = require('./database');
  const pool = await getDatabase();
  if (pool) {
    try {
      // Get last 10 transactions for this token by this KOL
      const recentTxs = await pool.query(`
        SELECT transaction_type, sol_amount, timestamp
        FROM kol_transactions
        WHERE kol_address = $1 AND token_mint = $2
        ORDER BY timestamp DESC
        LIMIT 10
      `, [kolAddress, tokenMint]);
      
      // Detect pattern: Large buy FIRST, then test buys, then sell
      // OR: Test buys first, then large buy, then sell
      if (transactionType === 'buy' && recentTxs.rows.length > 0) {
        const lastTx = recentTxs.rows[0];
        
        // Check if this is a LARGE buy after test buys (pattern: test → large)
        const isLargeBuy = solAmount > 1.5; // > 1.5 SOL
        const isTestBuy = solAmount < 0.5; // < 0.5 SOL
        
        if (isLargeBuy) {
          // Check if there were test buys before this
          const testBuysBefore = recentTxs.rows.filter(tx => 
            tx.transaction_type === 'buy' && 
            (tx.sol_amount || 0) < 0.5 &&
            tx.timestamp < (lastTx.timestamp || 0)
          );
          
          if (testBuysBefore.length > 0) {
            // Pattern detected: Test buys → Large buy (this is NORMAL pattern)
            // But if NO test buys before large buy, that's unusual!
          } else {
            // Large buy WITHOUT test buys first = UNUSUAL (might be a good token!)
            deviations.push({
              type: 'large_buy_without_test',
              message: `🚨 Large buy ${solAmount.toFixed(3)} SOL WITHOUT test buys first - might be confident!`,
              severity: 'high'
            });
          }
        }
        
        // Check if this is a test buy AFTER a large buy (unusual - usually test first)
        if (isTestBuy && lastTx.transaction_type === 'buy' && (lastTx.sol_amount || 0) > 1.5) {
          deviations.push({
            type: 'test_buy_after_large',
            message: `⚠️ Test buy AFTER large buy - unusual sequence`,
            severity: 'medium'
          });
        }
      }
      
      // Detect: Holding longer than usual (good sign)
      if (transactionType === 'sell') {
        const holdTime = await calculateHoldTime(kolAddress, tokenMint);
        if (holdTime !== null && pattern.avgHoldTime) {
          // If holding 3x longer than average, that's significant
          if (holdTime > pattern.avgHoldTime * 3) {
            deviations.push({
              type: 'unusually_long_hold',
              message: `⭐ Holding ${(holdTime / 60).toFixed(1)}m (avg: ${(pattern.avgHoldTime / 60).toFixed(1)}m) - CONFIDENCE SIGNAL!`,
              severity: 'high'
            });
          }
        }
      }
    } catch (error) {
      console.error('Error detecting pattern deviation:', error.message);
    }
  }
  
  // Original deviation checks
  if (transactionType === 'buy') {
    const isTypicalSize = pattern.typicalBuySizes.some(size => 
      Math.abs(solAmount - size) < 0.1
    );
    
    if (!isTypicalSize) {
      // Much larger than average?
      if (solAmount > pattern.avgBuySize * 2.5) {
        deviations.push({
          type: 'unusually_large_buy',
          message: `Large buy: ${solAmount.toFixed(3)} SOL (avg: ${pattern.avgBuySize.toFixed(3)} SOL)`,
          severity: 'high'
        });
      }
    }
  }
  
  return deviations.length > 0 ? deviations : null;
}

// Calculate KOL performance metrics for a specific time period
async function calculateKOLPerformance(kolAddress, periodHours) {
  await ensureDatabaseInitialized();
  if (!db) return null;
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const periodStart = Math.floor((Date.now() - (periodHours * 60 * 60 * 1000)) / 1000);
    
    // Get all transactions in the period
    const result = await pool.query(`
      SELECT * FROM kol_transactions
      WHERE kol_address = $1 AND timestamp >= $2
      ORDER BY timestamp ASC
    `, [kolAddress, periodStart]);
    
    const transactions = result.rows;
    if (transactions.length === 0) return null;
    
    // Group transactions by token
    const tokenTransactions = {};
    for (const tx of transactions) {
      if (!tokenTransactions[tx.token_mint]) {
        tokenTransactions[tx.token_mint] = [];
      }
      tokenTransactions[tx.token_mint].push(tx);
    }
    
    // Calculate metrics
    let totalPnL = 0;
    let totalCostBasis = 0;
    let totalProceeds = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let totalVolumeSOL = 0;
    let profitableTokens = 0;
    let losingTokens = 0;
    let largestWin = 0;
    let largestLoss = 0;
    const uniqueTokens = new Set();
    const holdTimes = [];
    
    // Calculate PnL per token using FIFO
    for (const [tokenMint, txs] of Object.entries(tokenTransactions)) {
      uniqueTokens.add(tokenMint);
      
      const buys = txs.filter(tx => tx.transaction_type === 'buy');
      const sells = txs.filter(tx => tx.transaction_type === 'sell');
      totalBuys += buys.length;
      totalSells += sells.length;
      
      // Calculate volume
      for (const tx of txs) {
        totalVolumeSOL += parseFloat(tx.sol_amount || 0);
      }
      
      // Calculate PnL for this token using FIFO
      const tokenPnL = await calculateRealizedPnL(kolAddress, tokenMint);
      if (tokenPnL.realizedPnL !== 0) {
        totalPnL += tokenPnL.realizedPnL;
        totalCostBasis += tokenPnL.totalCostBasis;
        totalProceeds += tokenPnL.totalProceeds;
        
        if (tokenPnL.realizedPnL > 0) {
          profitableTokens++;
          if (tokenPnL.realizedPnL > largestWin) {
            largestWin = tokenPnL.realizedPnL;
          }
        } else {
          losingTokens++;
          if (tokenPnL.realizedPnL < largestLoss) {
            largestLoss = tokenPnL.realizedPnL;
          }
        }
      }
      
      // Calculate hold times
      const holdTime = await calculateHoldTime(kolAddress, tokenMint);
      if (holdTime !== null && holdTime > 0) {
        holdTimes.push(holdTime);
      }
    }
    
    const totalPnLPercentage = totalCostBasis > 0 ? ((totalPnL / totalCostBasis) * 100) : 0;
    const winRate = (profitableTokens + losingTokens) > 0 
      ? (profitableTokens / (profitableTokens + losingTokens)) * 100 
      : 0;
    const avgHoldTime = holdTimes.length > 0 
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length 
      : null;
    
    return {
      kolAddress,
      periodHours,
      totalPnL,
      totalPnLPercentage,
      totalBuys,
      totalSells,
      totalVolumeSOL,
      uniqueTokensTraded: uniqueTokens.size,
      winRate,
      avgHoldTime,
      profitableTokens,
      losingTokens,
      largestWin,
      largestLoss,
      transactionCount: transactions.length
    };
  } catch (error) {
    console.error('Error calculating KOL performance:', error.message);
    return null;
  }
}

// Save KOL performance snapshot
async function saveKOLPerformanceSnapshot(kolAddress, periodType, performanceData) {
  await ensureDatabaseInitialized();
  if (!db) return;
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const snapshotDate = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000); // Start of day
    
    await pool.query(`
      INSERT INTO kol_performance_snapshots 
      (kol_address, snapshot_date, period_type, total_pnl, total_pnl_percentage, total_buys, total_sells, 
       total_volume_sol, unique_tokens_traded, win_rate, avg_hold_time, profitable_tokens, losing_tokens, 
       largest_win, largest_loss, performance_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT(kol_address, snapshot_date, period_type) DO UPDATE SET
        total_pnl = EXCLUDED.total_pnl,
        total_pnl_percentage = EXCLUDED.total_pnl_percentage,
        total_buys = EXCLUDED.total_buys,
        total_sells = EXCLUDED.total_sells,
        total_volume_sol = EXCLUDED.total_volume_sol,
        unique_tokens_traded = EXCLUDED.unique_tokens_traded,
        win_rate = EXCLUDED.win_rate,
        avg_hold_time = EXCLUDED.avg_hold_time,
        profitable_tokens = EXCLUDED.profitable_tokens,
        losing_tokens = EXCLUDED.losing_tokens,
        largest_win = EXCLUDED.largest_win,
        largest_loss = EXCLUDED.largest_loss,
        performance_data = EXCLUDED.performance_data
    `, [
      kolAddress,
      snapshotDate,
      periodType,
      performanceData.totalPnL || 0,
      performanceData.totalPnLPercentage || 0,
      performanceData.totalBuys || 0,
      performanceData.totalSells || 0,
      performanceData.totalVolumeSOL || 0,
      performanceData.uniqueTokensTraded || 0,
      performanceData.winRate || 0,
      performanceData.avgHoldTime || null,
      performanceData.profitableTokens || 0,
      performanceData.losingTokens || 0,
      performanceData.largestWin || 0,
      performanceData.largestLoss || 0,
      JSON.stringify(performanceData)
    ]);
  } catch (error) {
    console.error('Error saving KOL performance snapshot:', error.message);
  }
}

// Update KOL activity pattern (track hourly activity)
async function updateKOLActivityPattern(kolAddress, timestamp) {
  await ensureDatabaseInitialized();
  if (!db) return;
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const date = new Date(timestamp * 1000);
    const hourUTC = date.getUTCHours();
    
    // Get transaction to calculate volume
    const txResult = await pool.query(`
      SELECT sol_amount FROM kol_transactions
      WHERE kol_address = $1 AND timestamp = $2
      LIMIT 1
    `, [kolAddress, timestamp]);
    
    const volume = txResult.rows.length > 0 ? parseFloat(txResult.rows[0].sol_amount || 0) : 0;
    
    await pool.query(`
      INSERT INTO kol_activity_patterns (kol_address, hour_utc, transaction_count, total_volume_sol, last_updated)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT(kol_address, hour_utc) DO UPDATE SET
        transaction_count = kol_activity_patterns.transaction_count + 1,
        total_volume_sol = kol_activity_patterns.total_volume_sol + EXCLUDED.total_volume_sol,
        last_updated = EXCLUDED.last_updated
    `, [kolAddress, hourUTC, volume, Date.now()]);
  } catch (error) {
    console.error('Error updating KOL activity pattern:', error.message);
  }
}

// Get KOL activity pattern (most active hours)
async function getKOLActivityPattern(kolAddress) {
  await ensureDatabaseInitialized();
  if (!db) return null;
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const result = await pool.query(`
      SELECT hour_utc, transaction_count, total_volume_sol
      FROM kol_activity_patterns
      WHERE kol_address = $1
      ORDER BY transaction_count DESC
      LIMIT 24
    `, [kolAddress]);
    
    return result.rows.map(row => ({
      hour: row.hour_utc,
      transactionCount: row.transaction_count,
      volumeSOL: parseFloat(row.total_volume_sol || 0)
    }));
  } catch (error) {
    console.error('Error getting KOL activity pattern:', error.message);
    return null;
  }
}

// Generate leaderboard for a specific period
async function generateLeaderboard(periodType, limit = 50) {
  await ensureDatabaseInitialized();
  if (!db) return [];
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const periodHours = periodType === '24h' ? 24 : periodType === '48h' ? 48 : 168; // 7d = 168h
    const periodStart = Math.floor((Date.now() - (periodHours * 60 * 60 * 1000)) / 1000);
    
    // Get all KOLs with transactions in this period
    const kolResult = await pool.query(`
      SELECT DISTINCT kol_address FROM kol_transactions
      WHERE timestamp >= $1
    `, [periodStart]);
    
    const kols = kolResult.rows.map(r => r.kol_address);
    const performances = [];
    
    // Calculate performance for each KOL
    for (const kolAddress of kols) {
      const performance = await calculateKOLPerformance(kolAddress, periodHours);
      if (performance && performance.transactionCount > 0) {
        performances.push(performance);
      }
    }
    
    // Sort by total PnL descending
    performances.sort((a, b) => b.totalPnL - a.totalPnL);
    
    // Take top N
    const leaderboard = performances.slice(0, limit).map((perf, index) => ({
      rank: index + 1,
      ...perf
    }));
    
    // Save leaderboard snapshot
    const snapshotDate = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    for (const entry of leaderboard) {
      await pool.query(`
        INSERT INTO kol_leaderboard 
        (period_type, snapshot_date, kol_address, rank, total_pnl, total_pnl_percentage, 
         win_rate, total_volume_sol, unique_tokens_traded)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT(period_type, snapshot_date, kol_address) DO UPDATE SET
          rank = EXCLUDED.rank,
          total_pnl = EXCLUDED.total_pnl,
          total_pnl_percentage = EXCLUDED.total_pnl_percentage,
          win_rate = EXCLUDED.win_rate,
          total_volume_sol = EXCLUDED.total_volume_sol,
          unique_tokens_traded = EXCLUDED.unique_tokens_traded
      `, [
        periodType,
        snapshotDate,
        entry.kolAddress,
        entry.rank,
        entry.totalPnL,
        entry.totalPnLPercentage,
        entry.winRate,
        entry.totalVolumeSOL,
        entry.uniqueTokensTraded
      ]);
    }
    
    return leaderboard;
  } catch (error) {
    console.error('Error generating leaderboard:', error.message);
    return [];
  }
}

// Get leaderboard from saved snapshots
async function getLeaderboard(periodType, limit = 50) {
  await ensureDatabaseInitialized();
  if (!db) return [];
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    const result = await pool.query(`
      SELECT kol_address, rank, total_pnl, total_pnl_percentage, win_rate, 
             total_volume_sol, unique_tokens_traded
      FROM kol_leaderboard
      WHERE period_type = $1
      ORDER BY snapshot_date DESC, rank ASC
      LIMIT $2
    `, [periodType, limit]);
    
    return result.rows.map(row => ({
      kolAddress: row.kol_address,
      rank: row.rank,
      totalPnL: parseFloat(row.total_pnl || 0),
      totalPnLPercentage: parseFloat(row.total_pnl_percentage || 0),
      winRate: parseFloat(row.win_rate || 0),
      totalVolumeSOL: parseFloat(row.total_volume_sol || 0),
      uniqueTokensTraded: row.unique_tokens_traded || 0
    }));
  } catch (error) {
    console.error('Error getting leaderboard:', error.message);
    return [];
  }
}

// Run performance analysis for all tracked KOLs
async function runKOLPerformanceAnalysis() {
  await ensureDatabaseInitialized();
  if (!db) return;
  
  try {
    const { getDatabase } = require('./database');
    const pool = await getDatabase();
    if (!pool) throw new Error('Database not initialized');
    
    // Get all unique KOL addresses from transactions
    const kolResult = await pool.query(`
      SELECT DISTINCT kol_address FROM kol_transactions
    `);
    
    const kols = kolResult.rows.map(r => r.kol_address);
    console.log(`📊 Analyzing performance for ${kols.length} KOL(s)...`);
    
    // Analyze for each period
    const periods = [
      { type: '24h', hours: 24 },
      { type: '48h', hours: 48 },
      { type: '7d', hours: 168 }
    ];
    
    for (const period of periods) {
      console.log(`  📈 Calculating ${period.type} performance...`);
      
      for (const kolAddress of kols) {
        const performance = await calculateKOLPerformance(kolAddress, period.hours);
        if (performance && performance.transactionCount > 0) {
          await saveKOLPerformanceSnapshot(kolAddress, period.type, performance);
        }
      }
      
      // Generate leaderboard for this period
      await generateLeaderboard(period.type, 100);
    }
    
    console.log(`✅ Performance analysis complete`);
  } catch (error) {
    console.error('Error running KOL performance analysis:', error.message);
  }
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
  getKOLsForToken,
  saveKOLTransaction,
  getKOLTransactionHistory,
  calculateHoldTime,
  calculateRealizedPnL,
  analyzeTokenPattern,
  saveTokenPerformance,
  analyzeTokenPerformance,
  getWinningTokens,
  runLongTermAnalysis,
  updateKOLBehaviorPattern,
  detectKOLDeviation,
  getKOLBehaviorPattern,
  calculateKOLPerformance,
  saveKOLPerformanceSnapshot,
  updateKOLActivityPattern,
  getKOLActivityPattern,
  generateLeaderboard,
  getLeaderboard,
  runKOLPerformanceAnalysis
};

