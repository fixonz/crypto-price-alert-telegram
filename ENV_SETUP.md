# Environment Variables Setup

## Required .env File

Create a `.env` file in the root directory with the following variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_CHAT_ID=your_chat_id_here
DATABASE_URL=your_neon_database_url_here
```

## Explanation

- **TELEGRAM_BOT_TOKEN**: Your Telegram bot token from BotFather
- **ADMIN_CHAT_ID**: Your Telegram chat ID to receive admin notifications
- **DATABASE_URL**: Your Neon serverless Postgres connection string (required for alerts)

## Database Setup (Neon)

This bot uses **Neon** (serverless Postgres) for persistent storage. Without a database, alerts will not work.

### Quick Setup:

1. **Create a Neon account**: Visit [neon.tech](https://neon.tech) and sign up (free tier available)
2. **Create a new project**: Click "New Project" in your dashboard
3. **Copy connection string**: After creating the project, copy the connection string (it looks like: `postgresql://user:password@host/dbname`)
4. **Add to environment**: Set `DATABASE_URL` in your `.env` file or Render environment variables

The database tables (`users` and `price_history`) will be created automatically on first run.

### Fallback to JSON Storage

If you want to use JSON file storage instead (not recommended for production), set:
```env
USE_JSON_STORAGE=true
```

**Note**: JSON storage does not persist on serverless platforms like Render, so alerts may not work properly.

## Admin Features

When `ADMIN_CHAT_ID` is set, you will:
- ✅ Receive notifications when new users start the bot
- ✅ See total user count and active user count
- ✅ Use `/admin` command to view bot statistics

## Getting Your Chat ID

If you need to find your chat ID:
1. Start a chat with your bot
2. Send any message (e.g., `/start`)
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Look for `"chat":{"id":123456789}` in the response

## For Render Deployment

When deploying to Render, add these environment variables in the Render dashboard:
- Go to your service → Environment tab
- Add `TELEGRAM_BOT_TOKEN`
- Add `ADMIN_CHAT_ID`
- Add `DATABASE_URL` (your Neon connection string)

**Important**: The `DATABASE_URL` is required for alerts to work. Without it, price drop alerts will not function.

