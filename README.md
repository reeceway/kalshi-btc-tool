# Kalshi BTC Tool

A timer-based trading tool for **Kalshi BTC hourly price markets** designed for Claude moltbot integration on Raspberry Pi OS.

## What It Does

Every time you run `node src/tool.js`, it outputs a JSON object with:

1. **`recommendation`** - Exactly what to buy (YES or NO), which market ticker, confidence level
2. **`price`** - Current BTC price from Coinbase (US-based)
3. **`market`** - Selected Kalshi market details (nearest strike to current price)
4. **`technicalAnalysis`** - TA signals (RSI, MACD, VWAP, Heiken Ashi)

## Quick Start

```bash
# Run once - outputs JSON for moltbot
node src/tool.js

# The output includes everything the moltbot needs:
# - recommendation.action: "BUY" or "NO_TRADE"
# - recommendation.side: "YES" or "NO"
# - recommendation.ticker: "KXBTCD-26JAN3122-T78749.99" (exact market to trade)
# - recommendation.expiresInMinutes: time until settlement
```

## Sample Output

```json
{
  "timestamp": "2026-01-31T21:16:00.000Z",
  "success": true,
  "data": {
    "recommendation": {
      "action": "BUY",
      "side": "YES",
      "ticker": "KXBTCD-26JAN3122-T78749.99",
      "eventTicker": "KXBTCD-26JAN3122",
      "strikePrice": 78749.99,
      "currentPrice": 78771.37,
      "marketPrice": 47,
      "confidence": 90,
      "edge": 43,
      "expiration": "2026-02-01T03:00:00.000Z",
      "expiresInMinutes": 44,
      "urgency": "LOW",
      "reasoning": [
        "Price $21.38 ABOVE strike",
        "TA confirms UP bias (90.0%)"
      ],
      "summary": "BUY YES on KXBTCD-26JAN3122-T78749.99 @ 47¢ (90% conf, 43.0% edge, 44min left)"
    },
    "price": {
      "current": 78771.37,
      "bid": 78770.00,
      "ask": 78771.00,
      "source": "coinbase"
    },
    "market": {
      "ticker": "KXBTCD-26JAN3122-T78749.99",
      "strikePrice": 78749.99,
      "expiration": "2026-02-01T03:00:00.000Z",
      "timeLeftMinutes": 44
    }
  }
}
```

## For Claude Moltbot

The moltbot should read these fields:

| Field | Description | Example |
|-------|-------------|---------|
| `recommendation.action` | What to do | `"BUY"` or `"NO_TRADE"` |
| `recommendation.side` | Which side | `"YES"` (price above strike) or `"NO"` (price below strike) |
| `recommendation.ticker` | **Exact market to trade** | `"KXBTCD-26JAN3122-T78749.99"` |
| `recommendation.marketPrice` | Cost in cents | `47` (meaning 47¢) |
| `recommendation.expiresInMinutes` | Time until settlement | `44` |
| `recommendation.urgency` | Time warning | `"HIGH"` (<15 min), `"MEDIUM"` (<30 min), `"LOW"` (>30 min) |
| `recommendation.confidence` | Model confidence % | `90` |
| `recommendation.edge` | Expected edge % | `43` (model prob - market price) |

## Raspberry Pi Cron Setup

The Kalshi BTC hourly markets settle on the hour (e.g., 10pm, 11pm, midnight...).

**Recommended cron schedule**: Run at **:55 of each hour** (5 minutes before settlement) to get the final recommendation:

```bash
# Edit crontab
crontab -e

# Add this line - runs at minute 55 of every hour
55 * * * * cd /home/pi/kalshi-btc-tool && node src/tool.js >> /home/pi/kalshi-output.json 2>&1
```

For more frequent updates (every 15 minutes):
```bash
# Runs at :00, :15, :30, :45 of each hour
*/15 * * * * cd /home/pi/kalshi-btc-tool && node src/tool.js >> /home/pi/kalshi-output.json 2>&1
```

## How Markets Work

Kalshi creates hourly BTC price markets:
- **Event**: `KXBTCD-26JAN3122` = "Bitcoin price on Jan 31, 2026 at 10pm EST?"
- **Markets**: Multiple strike prices ($78,000, $78,250, $78,500, etc.)
- **Settlement**: If BTC is above the strike at settlement → YES wins, otherwise NO wins

The tool automatically:
1. Picks the **next event** (soonest to expire)
2. Finds the **best strike** (closest to current BTC price)
3. Recommends **YES or NO** based on price position + TA signals

## Environment Variables (Optional)

For authenticated Kalshi API access (placing orders):

```bash
export KALSHI_API_KEY_ID="your-key-id"
export KALSHI_PRIVATE_KEY_FILE="/home/pi/.kalshi/key.pem"
```

For public market data (what this tool uses), no authentication is needed.

## Files

| File | Purpose |
|------|---------|
| `src/tool.js` | **Main entry point** - run this for JSON output |
| `src/data/coinbase.js` | Coinbase API (BTC price) |
| `src/data/kalshi.js` | Kalshi API (market data) |
| `src/config.js` | Configuration |
| `src/indicators/` | TA indicators (RSI, MACD, VWAP, Heiken Ashi) |
| `src/engines/` | Prediction engine |

## Requirements

- Node.js 18+ (uses native `fetch`)
- No npm dependencies required (zero dependencies!)

## License

MIT
