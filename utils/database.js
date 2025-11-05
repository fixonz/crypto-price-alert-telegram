const Database = require('better-sqlite3');
const path = require('path');

// Database file path (will be created in project root)
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'bot.db');

let db = null;

// Initialize database connection
function initDatabase() {
  if (db) return db;
  
  try {
    db = new Database(DB_PATH);
    
    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    
    // Create users table
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        subscribed INTEGER DEFAULT 1,
        tokens TEXT DEFAULT '[]',
        custom_tokens TEXT DEFAULT '[]',
        interval_minutes INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);
    
    // Create price_history table
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        token_key TEXT PRIMARY KEY,
        price REAL,
        timestamp INTEGER,
        history TEXT DEFAULT '[]'
      )
    `);
    
    console.log(`✅ SQLite database initialized at: ${DB_PATH}`);
    return db;
  } catch (error) {
    console.error('❌ Error initializing database:', error.message);
    throw error;
  }
}

// Get database instance
function getDatabase() {
  if (!db) {
    initDatabase();
  }
  return db;
}

// Close database connection
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  DB_PATH
};

