# Environment Variables Setup

## Required .env File

Create a `.env` file in the root directory with the following variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_CHAT_ID=your_chat_id_here
```

## Explanation

- **TELEGRAM_BOT_TOKEN**: Your Telegram bot token from BotFather
- **ADMIN_CHAT_ID**: Your Telegram chat ID to receive admin notifications

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

