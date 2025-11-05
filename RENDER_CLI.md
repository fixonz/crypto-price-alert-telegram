# Using Render CLI to View Logs

## Setup

1. **Install Render CLI** (if not already installed):
   ```bash
   # On MacOS (Homebrew)
   brew update
   brew install render
   
   # On Linux/MacOS (direct download)
   curl -L https://github.com/render-oss/cli/releases/download/v1.1.0/cli_1.1.0_linux_amd64.zip -o render.zip
   unzip render.zip
   sudo mv cli_v1.1.0 /usr/local/bin/render
   ```

2. **Login to Render CLI**:
   ```bash
   render login
   ```
   This opens your browser to authorize the CLI. Click "Generate token" and return to terminal.

3. **Set your workspace** (if prompted):
   ```bash
   render workspace set
   ```

## View Logs

### Interactive Mode (Recommended)

1. **List all services**:
   ```bash
   render services
   ```
   This shows a menu - select your bot service.

2. **View logs** - After selecting your service, choose "View logs" from the menu.

### Non-Interactive Mode (For Scripting)

View logs directly:
```bash
# List services first to get service ID
render services --output json

# View logs for a specific service
render logs [SERVICE_ID] --output text

# Or follow logs (like tail -f)
render logs [SERVICE_ID] --follow
```

## Common Commands

```bash
# View all services
render services

# View logs for a service
render logs [SERVICE_ID]

# Follow logs (real-time)
render logs [SERVICE_ID] --follow

# Deploy a service
render deploys create [SERVICE_ID]

# View deploy logs
render deploys list [SERVICE_ID]

# Restart a service
render services restart [SERVICE_ID]
```

## Get Your Service ID

1. Run `render services`
2. Select your bot service
3. Note the service ID (shown in the output)
4. Or use: `render services --output json` to see all service IDs

## Example: View Logs for Your Bot

```bash
# 1. Login (if not already)
render login

# 2. List services and find your bot
render services

# 3. Select your bot service, then choose "View logs"

# OR directly with service ID:
render logs crypto-price-alert-telegram --follow
```

## Tips

- Use `--follow` flag to stream logs in real-time (like `tail -f`)
- Use `--output json` for structured output in scripts
- Logs are available for recent activity (last 24-48 hours typically)
- For older logs, check the Render Dashboard web interface

