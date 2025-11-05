# Deployment Guide

This bot can be deployed to Render for free. Render supports long-running processes which is perfect for Telegram bots.

## Deploy to Render

### Option 1: Deploy via Render Dashboard (Recommended)

1. **Sign up/Login to Render**
   - Go to [render.com](https://render.com)
   - Sign up or log in with GitHub

2. **Create New Web Service**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the repository

3. **Configure the Service**
   - **Name**: `crypto-price-bot` (or any name you prefer)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free tier is fine

4. **Add Environment Variables**
   - Click "Environment" tab
   - Add: `TELEGRAM_BOT_TOKEN` = `your_bot_token_here` (from BotFather)
   - Add: `ADMIN_CHAT_ID` = `your_chat_id_here` (optional, for admin notifications)
   - **Optional**: `ENABLE_KEEP_ALIVE` = `true` (default, keeps service alive on free tier)
   - **Note**: Render automatically sets `RENDER_EXTERNAL_URL` for you

5. **Deploy**
   - Click "Create Web Service"
   - Wait for build and deployment (usually 2-3 minutes)

6. **Verify**
   - Once deployed, check the logs to see "Bot started!"
   - Test by sending `/start` to your bot on Telegram

### Option 2: Deploy via render.yaml (Automatic)

If you have `render.yaml` in your repo:

1. Push your code to GitHub
2. Go to Render Dashboard
3. Click "New +" → "Blueprint"
4. Connect your GitHub repository
5. Render will automatically detect `render.yaml` and configure everything
6. Make sure to add `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_ID` in the Environment section

## Important Notes

- **Free Tier**: Render's free tier spins down after 15 minutes of inactivity. The bot includes a built-in keep-alive mechanism that pings itself every 10 minutes to prevent spin-down.

- **Keep-Alive Options**:
  1. **Built-in (Automatic)**: The bot automatically pings itself every 10 minutes (enabled by default)
  2. **External Service**: Use a free service like [UptimeRobot](https://uptimerobot.com) or [Cron-job.org](https://cron-job.org) to ping your bot's health endpoint every 5-10 minutes
  3. **Upgrade**: For guaranteed 24/7 uptime, upgrade to Render's paid tier ($7/month)

- **Data Persistence**: User preferences and price history are stored in `users.json` and `prices.json`. On Render's free tier, these files persist but may be lost if the service is inactive for too long. For production, consider using a database.

- **Health Checks**: The bot includes a health check endpoint at `/health`. You can also use the root endpoint `/` for monitoring.

## Alternative Hosting Options

### Railway
- Similar to Render, supports long-running processes
- Free tier available
- Good for Telegram bots

### Fly.io
- Free tier available
- Supports persistent volumes
- Good documentation

### Heroku
- Paid option ($7/month minimum)
- Very reliable
- Easy to use

### Self-Hosting
- Run on a VPS (DigitalOcean, Linode, etc.)
- Use PM2 for process management
- Full control over the environment

## Monitoring

After deployment, you can:
- Check logs in Render dashboard
- Monitor the `/health` endpoint
- Test bot commands in Telegram

## Troubleshooting

- **Bot not responding**: Check Render logs for errors
- **Service sleeping**: Free tier spins down after inactivity - upgrade to paid or use a service that keeps it alive
- **Data lost**: Consider using a database instead of JSON files for production

