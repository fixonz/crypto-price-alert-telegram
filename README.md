# Crypto Price Telegram Bot

A Telegram bot that sends cryptocurrency price updates (Bitcoin, Ethereum, BNB, Solana) with customizable intervals. Users can select which tokens to monitor and choose their preferred update frequency.

## Features

- 🪙 **Multiple Cryptocurrencies**: Bitcoin (BTC), Ethereum (ETH), BNB, and Solana (SOL)
- ⚙️ **Customizable Selection**: Choose which tokens to monitor
- ⏰ **Flexible Intervals**: Set update frequency from 1 to 60 minutes
- 📊 **Real-time Prices**: Live prices from CoinGecko API
- 📈 **24h Change**: See price changes with visual indicators
- 👥 **Multi-user Support**: Each user can have their own preferences

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory:

```
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_CHAT_ID=your_chat_id_here
```

**Important Security Notes:**
- ⚠️ **Never commit `.env` file to Git** - it's already in `.gitignore`
- ⚠️ **Never share your bot token publicly**
- See `ENV_SETUP.md` for detailed setup instructions

### 4. Run the Bot

```bash
npm start
```

## Usage

### Commands

- `/start` - Start the bot and subscribe to updates
- `/select` - Choose which cryptocurrencies to monitor (BTC, ETH, BNB, SOL)
- `/interval` - Set how often you want to receive updates (1, 2, 5, 10, 15, 30, or 60 minutes)
- `/mytokens` - View your current settings (selected tokens and interval)
- `/stop` - Stop receiving price updates

### How to Use

1. Start a chat with your bot on Telegram
2. Send `/start` to begin
3. Use `/select` to choose which tokens you want to track
4. Use `/interval` to set how often you want updates
5. The bot will automatically send price updates based on your preferences

### Example Flow

```
User: /start
Bot: Welcome message...

User: /select
Bot: Shows inline keyboard with tokens to select

User: Selects Bitcoin and Ethereum

User: /interval
Bot: Shows interval options (1, 2, 5, 10, 15, 30, 60 minutes)

User: Selects 5 minutes

Bot: Sends BTC and ETH prices every 5 minutes
```

## Supported Tokens

- **Bitcoin (BTC)** ₿
- **Ethereum (ETH)** Ξ
- **BNB** 🟡
- **Solana (SOL)** ◎

## Supported Intervals

- 1 minute
- 2 minutes
- 5 minutes
- 10 minutes
- 15 minutes
- 30 minutes
- 60 minutes

## Data Storage

User preferences are stored in `users.json` file. This file is automatically created and managed by the bot.

## Deployment

This bot can be deployed to Render (or similar services) for free. See [DEPLOY.md](./DEPLOY.md) for detailed deployment instructions.

**Quick Deploy to Render:**
1. Push code to GitHub
2. Create new Web Service on Render
3. Set `TELEGRAM_BOT_TOKEN` environment variable
4. Deploy!

## Notes

- The bot uses CoinGecko API (free, no API key required)
- Each user's preferences are stored separately
- Users can change their settings at any time
- The bot automatically handles users who block it or delete the chat
- For production use, deploy to Render, Railway, or similar services (see DEPLOY.md)
- Includes health check endpoint for hosting platforms
- **Built-in keep-alive**: Automatically prevents free tier spin-down (see KEEP_ALIVE.md)

## Troubleshooting

- If the bot doesn't respond, make sure it's running and the token is correct
- If you're not receiving updates, check your settings with `/mytokens`
- Make sure you've selected at least one token with `/select`
- Use `/stop` and `/start` to reset your subscription
