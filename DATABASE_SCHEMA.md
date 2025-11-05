# Database Schema

This document describes the database tables and their structure for the Telegram bot.

## Tables

The bot automatically creates these tables on first connection to the Neon database.

### `users` Table

Stores user preferences and subscription settings.

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT (PRIMARY KEY) | Telegram chat ID - unique identifier for each user |
| `subscribed` | BOOLEAN | Whether the user is subscribed to receive updates (default: true) |
| `tokens` | TEXT | JSON array of standard token keys the user follows (default: '[]') |
| `custom_tokens` | TEXT | JSON array of custom Solana token objects (default: '[]') |
| `interval_minutes` | INTEGER | Update interval in minutes (default: 1) |
| `created_at` | BIGINT | Timestamp when user was first created (milliseconds since epoch) |
| `updated_at` | BIGINT | Timestamp when user was last updated (milliseconds since epoch) |

**Example data:**
```json
{
  "chat_id": "123456789",
  "subscribed": true,
  "tokens": ["sol", "eth", "btc"],
  "custom_tokens": [
    {
      "symbol": "BONK",
      "address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "marketCap": 1234567,
      "creator": "ABC123...",
      "holders": { "count": 5000 }
    }
  ],
  "interval_minutes": 5,
  "created_at": 1704067200000,
  "updated_at": 1704067200000
}
```

### `price_history` Table

Stores price history for all tokens to enable price drop alerts.

| Column | Type | Description |
|--------|------|-------------|
| `token_key` | TEXT (PRIMARY KEY) | Unique identifier for the token (e.g., "sol", "eth", or "solana_<address>") |
| `price` | REAL | Current price in USD |
| `timestamp` | BIGINT | Timestamp when price was last updated (milliseconds since epoch) |
| `history` | TEXT | JSON array of recent price points for calculating 5-minute changes (default: '[]') |

**Example data:**
```json
{
  "token_key": "sol",
  "price": 98.45,
  "timestamp": 1704067200000,
  "history": [
    { "price": 98.20, "timestamp": 1704066900000 },
    { "price": 98.45, "timestamp": 1704067200000 }
  ]
}
```

## Automatic Table Creation

**You don't need to manually create tables!** The bot automatically creates these tables when it first connects to your Neon database.

The table creation happens in `utils/database.js` in the `initDatabase()` function, which runs:
- On bot startup
- Before any database operations

## Migration from SQLite

If you previously used SQLite, the schema is the same. The bot will automatically create the tables in Neon when you:
1. Set `DATABASE_URL` environment variable
2. Restart the bot

Your existing data will need to be migrated manually if you have important user data or price history from SQLite.

## Viewing Your Database

You can view your database tables in the Neon dashboard:
1. Go to your Neon project
2. Click on "SQL Editor"
3. Run queries like:
   ```sql
   SELECT * FROM users;
   SELECT * FROM price_history;
   ```

## Troubleshooting

If tables aren't being created:
1. Check that `DATABASE_URL` is set correctly
2. Check bot logs for initialization messages
3. Verify database connection in Neon dashboard
4. Check that the database user has CREATE TABLE permissions (should be automatic on Neon)

