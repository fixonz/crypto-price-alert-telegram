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
        interval_minutes INTEGER DEFAULT 1,
        created_at BIGINT,
        updated_at BIGINT
      )
    `);
    
    // Create price_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        token_key TEXT PRIMARY KEY,
        price REAL,
        timestamp BIGINT,
        history TEXT DEFAULT '[]'
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

