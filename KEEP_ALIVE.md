# Keep-Alive Setup for Free Tier Hosting

The bot includes a built-in keep-alive mechanism to prevent Render's free tier from spinning down after 15 minutes of inactivity.

## How It Works

The bot automatically pings its own health endpoint every 10 minutes to keep the service active. This prevents the free tier from going to sleep.

## Built-in Keep-Alive (Automatic)

✅ **Enabled by default** - No configuration needed!

The bot will:
- Ping `/health` endpoint every 10 minutes
- Automatically use `RENDER_EXTERNAL_URL` if available (set by Render)
- Fall back to localhost if external URL not available

## External Keep-Alive Services (Recommended for Reliability)

For extra reliability, use a free external service to ping your bot:

### Option 1: UptimeRobot (Recommended)

1. Go to [UptimeRobot.com](https://uptimerobot.com)
2. Sign up for free account
3. Click "Add New Monitor"
4. Select "HTTP(s)"
5. Enter your bot's URL: `https://your-bot-name.onrender.com/health`
6. Set interval to **5 minutes**
7. Click "Create Monitor"
8. Free tier: Up to 50 monitors, 5-minute intervals

### Option 2: Cron-job.org

1. Go to [Cron-job.org](https://cron-job.org)
2. Sign up for free account
3. Click "Create cronjob"
4. Enter URL: `https://your-bot-name.onrender.com/health`
5. Set schedule: Every **5 minutes** (`*/5 * * * *`)
6. Click "Create"
7. Free tier: Up to 2 cronjobs, 5-minute intervals

### Option 3: Pingdom (Alternative)

1. Go to [Pingdom.com](https://www.pingdom.com)
2. Sign up (free tier available)
3. Add uptime check
4. Set interval to 5 minutes

## Get Your Bot's URL

After deploying to Render:
1. Go to your Render dashboard
2. Find your service
3. Copy the URL (e.g., `https://crypto-price-bot.onrender.com`)
4. Use this URL with `/health` endpoint for monitoring

Example: `https://crypto-price-bot.onrender.com/health`

## Disable Built-in Keep-Alive

If you prefer to use only external services, you can disable the built-in keep-alive:

1. In Render dashboard → Environment variables
2. Add: `ENABLE_KEEP_ALIVE` = `false`
3. Redeploy

## Troubleshooting

- **Bot still sleeping?**: Make sure the external service is actually pinging (check logs)
- **Built-in keep-alive not working?**: Check Render logs for keep-alive ping messages
- **Service URL not found?**: Make sure `RENDER_EXTERNAL_URL` is set (Render sets this automatically)

## Best Practice

For maximum reliability, use **both**:
1. Built-in keep-alive (automatic, runs every 10 min)
2. External service (UptimeRobot, runs every 5 min)

This ensures your bot stays awake even if one method fails.

