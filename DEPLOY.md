# Deploy to Raspberry Pi

## Step 1: Transfer Files

From your Mac, run this command to copy the tool to your Pi:

```bash
# Replace 'pi' with your Pi username and 'raspberrypi.local' with your Pi's address
scp -r /Users/reeceway/Desktop/kalshi/kalshi-btc-tool pi@raspberrypi.local:~/kalshi-btc-tool
```

Or if using IP address:
```bash
scp -r /Users/reeceway/Desktop/kalshi/kalshi-btc-tool pi@192.168.1.XXX:~/kalshi-btc-tool
```

## Step 2: SSH into Pi

```bash
ssh pi@raspberrypi.local
```

## Step 3: Verify Node.js 18+

```bash
node --version
```

If Node.js is not installed or is < v18, install it:
```bash
# Using NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Step 4: Test the Tool

```bash
cd ~/kalshi-btc-tool
node src/tool.js
```

You should see JSON output with a recommendation.

## Step 5: Set Up Cron for Hourly Trading

The moltbot should get fresh data a few minutes before each hour when markets settle.

```bash
# Edit crontab
crontab -e

# Add this line - runs at :55 of every hour (5 min before settlement)
55 * * * * cd /home/pi/kalshi-btc-tool && node src/tool.js > /home/pi/kalshi-latest.json 2>&1
```

This saves the latest output to `/home/pi/kalshi-latest.json` which the moltbot can read.

## Step 6: (Optional) Kalshi API Keys

If you want to place orders programmatically, set up your Kalshi API keys:

```bash
# Create key directory
mkdir -p ~/.kalshi

# Copy your private key (from your Mac)
# On Mac, run:
scp /path/to/your/kalshi-key.pem pi@raspberrypi.local:~/.kalshi/key.pem

# Set environment variables (add to ~/.bashrc)
echo 'export KALSHI_API_KEY_ID="your-key-id"' >> ~/.bashrc
echo 'export KALSHI_PRIVATE_KEY_FILE="/home/pi/.kalshi/key.pem"' >> ~/.bashrc
source ~/.bashrc
```

## File Structure on Pi

After deployment:
```
/home/pi/
├── kalshi-btc-tool/
│   ├── src/
│   │   ├── tool.js          # Main entry - run this
│   │   ├── data/
│   │   │   ├── coinbase.js  # BTC price
│   │   │   └── kalshi.js    # Market data
│   │   ├── indicators/      # TA calculations
│   │   └── engines/         # Prediction logic
│   ├── package.json
│   └── README.md
├── kalshi-latest.json        # Output from cron (moltbot reads this)
└── .kalshi/
    └── key.pem              # (Optional) API key for trading
```

## What the Moltbot Reads

The `/home/pi/kalshi-latest.json` file contains:

```json
{
  "data": {
    "recommendation": {
      "action": "BUY",
      "side": "YES",
      "ticker": "KXBTCD-26JAN3122-T78749.99",
      "expiresInMinutes": 5,
      "urgency": "HIGH",
      "summary": "BUY YES on KXBTCD-26JAN3122-T78749.99 @ 49¢ (90% conf, 41% edge, 5min left)"
    }
  }
}
```

The moltbot should:
1. Read `recommendation.action` - if "BUY", proceed
2. Use `recommendation.ticker` - this is the exact market to trade
3. Use `recommendation.side` - "YES" or "NO"
4. Check `recommendation.urgency` - if "HIGH", market closes soon

## Quick Commands

```bash
# Test run
cd ~/kalshi-btc-tool && node src/tool.js | jq '.data.recommendation'

# View latest cron output
cat /home/pi/kalshi-latest.json | jq '.data.recommendation'

# Check cron is running
crontab -l

# View cron logs
grep CRON /var/log/syslog | tail -20
```
