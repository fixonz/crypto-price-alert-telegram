const { Pool } = require('pg');

let pool = null;

// Initialize database connection (Neon serverless Postgres)
async function initDatabase() {
  if (pool) return pool;
  
  try {
    // Use DATABASE_URL from environment (Neon provides this)
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      console.warn('⚠️ DATABASE_URL not set, falling back to JSON storage');
      return null;
    }
    
    // Neon connection string already includes SSL requirements
    // For serverless environments, use smaller pool size
    const isServerless = process.env.RENDER || process.env.VERCEL || connectionString.includes('neon.tech');
    
    pool = new Pool({
      connectionString,
      // Neon requires SSL, connection string usually includes ?sslmode=require
      ssl: connectionString.includes('neon.tech') || connectionString.includes('vercel') 
        ? { rejectUnauthorized: false } 
        : undefined, // Let connection string determine SSL
      // Smaller pool for serverless (Neon recommends 1-2 for serverless)
      max: isServerless ? 2 : 10,
      idleTimeoutMillis: 10000, // Shorter for serverless
      connectionTimeoutMillis: 5000,
      // Allow existing connections to be reused
      allowExitOnIdle: true,
    });
    
    // Test connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        subscribed BOOLEAN DEFAULT true,
        tokens TEXT DEFAULT '[]',
        custom_tokens TEXT DEFAULT '[]',
        tracked_kols TEXT DEFAULT '[]',
        interval_minutes INTEGER DEFAULT 1,
        created_at BIGINT,
        updated_at BIGINT
      )
    `);
    
    // Add tracked_kols column if it doesn't exist (for existing databases)
    try {
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS tracked_kols TEXT DEFAULT '[]'
      `);
    } catch (error) {
      // Column might already exist, ignore error
    }
    
    // Create price_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        token_key TEXT PRIMARY KEY,
        price REAL,
        timestamp BIGINT,
        history TEXT DEFAULT '[]'
      )
    `);
    
    // Create kol_signatures table to track last processed transaction signatures
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kol_signatures (
        kol_address TEXT PRIMARY KEY,
        last_signature TEXT,
        updated_at BIGINT
      )
    `);
    
    // Create kol_token_balances table to track KOL token balances and purchase history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kol_token_balances (
        kol_address TEXT,
        token_mint TEXT,
        balance REAL DEFAULT 0,
        first_buy_signature TEXT,
        first_buy_timestamp BIGINT,
        first_buy_price REAL,
        total_cost_basis REAL DEFAULT 0,
        total_tokens_bought REAL DEFAULT 0,
        last_updated BIGINT,
        PRIMARY KEY (kol_address, token_mint)
      )
    `);
    
    // Create kol_alerted_transactions table to track which transactions we've already alerted on
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kol_alerted_transactions (
        signature TEXT PRIMARY KEY,
        kol_address TEXT,
        token_mint TEXT,
        alerted_at BIGINT
      )
    `);
    
    // Create kol_transactions table to track all transactions for pattern analysis
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kol_transactions (
        signature TEXT PRIMARY KEY,
        kol_address TEXT,
        token_mint TEXT,
        transaction_type TEXT, -- 'buy' or 'sell'
        token_amount REAL,
        sol_amount REAL,
        token_price REAL,
        timestamp BIGINT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    
    // Create index for faster pattern queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_kol_transactions_kol_token 
      ON kol_transactions(kol_address, token_mint, timestamp DESC)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_kol_transactions_token_timestamp 
      ON kol_transactions(token_mint, timestamp DESC)
    `);
    
    // Create token_performance table to track token price history for analysis
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_performance (
        token_mint TEXT,
        timestamp BIGINT,
        price REAL,
        market_cap REAL,
        volume_24h REAL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
        PRIMARY KEY (token_mint, timestamp)
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_performance_token_timestamp 
      ON token_performance(token_mint, timestamp DESC)
    `);
    
    // Create token_analysis table to store periodic analysis results
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_analysis (
        token_mint TEXT PRIMARY KEY,
        analysis_date BIGINT,
        kol_count INTEGER DEFAULT 0,
        total_buys INTEGER DEFAULT 0,
        total_sells INTEGER DEFAULT 0,
        avg_hold_time REAL,
        holding_kols INTEGER DEFAULT 0,
        price_change_24h REAL,
        price_change_7d REAL,
        max_price REAL,
        min_price REAL,
        peak_market_cap REAL,
        is_winner BOOLEAN DEFAULT false,
        winner_score REAL DEFAULT 0,
        analysis_data TEXT, -- JSON string with detailed analysis
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_analysis_winner_score 
      ON token_analysis(winner_score DESC)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_token_analysis_date 
      ON token_analysis(analysis_date DESC)
    `);
    
    // Create kol_behavior_patterns table to track individual KOL trading patterns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kol_behavior_patterns (
        kol_address TEXT PRIMARY KEY,
        avg_buy_size REAL,
        avg_sell_size REAL,
        avg_hold_time REAL,
        typical_buy_sizes TEXT, -- JSON array of typical buy amounts
        typical_sell_sizes TEXT, -- JSON array of typical sell amounts
        max_hold_time REAL,
        min_hold_time REAL,
        buy_count INTEGER DEFAULT 0,
        sell_count INTEGER DEFAULT 0,
        total_tokens_traded INTEGER DEFAULT 0,
        last_updated BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    
    // Verify tables were created
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'price_history')
    `);
    
    const createdTables = tablesResult.rows.map(r => r.table_name);
    console.log(`✅ Neon Postgres database initialized`);
    console.log(`📊 Tables created: ${createdTables.join(', ') || 'none (already existed)'}`);
    return pool;
  } catch (error) {
    console.error('❌ Error initializing database:', error.message);
    // Don't throw - allow fallback to JSON
    return null;
  }
}

// Get database pool instance
async function getDatabase() {
  if (!pool) {
    await initDatabase();
  }
  return pool;
}

// Close database connection
async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase
};

