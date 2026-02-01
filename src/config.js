/**
 * Configuration for Kalshi BTC Tool
 * US-based prediction market and price data
 */

import fs from "node:fs";
import path from "node:path";

// Load private key from file if KALSHI_PRIVATE_KEY_FILE is set
function loadPrivateKey() {
  const keyFile = process.env.KALSHI_PRIVATE_KEY_FILE;
  if (keyFile) {
    try {
      return fs.readFileSync(path.resolve(keyFile), "utf8").trim();
    } catch (err) {
      console.error(`Warning: Could not load private key from ${keyFile}: ${err.message}`);
    }
  }
  return process.env.KALSHI_PRIVATE_KEY || "";
}

export const CONFIG = {
  symbol: "BTC-USD",

  // Coinbase - US-based price source
  coinbase: {
    baseUrl: process.env.COINBASE_BASE_URL || "https://api.coinbase.com/v2",
    exchangeUrl: process.env.COINBASE_EXCHANGE_URL || "https://api.exchange.coinbase.com"
  },

  // Kalshi - US-regulated prediction market
  kalshi: {
    baseUrl: process.env.KALSHI_BASE_URL || "https://api.elections.kalshi.com/trade-api/v2",
    seriesTicker: process.env.KALSHI_SERIES_TICKER || "KXBTCD",
    apiKeyId: process.env.KALSHI_API_KEY_ID || "",
    privateKey: loadPrivateKey(),
    autoSelectNextEvent: (process.env.KALSHI_AUTO_SELECT_NEXT_EVENT || "true").toLowerCase() === "true"
  },

  // Polling and timing
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),

  // TA Indicators
  rsiPeriod: parseInt(process.env.RSI_PERIOD || "14", 10),
  rsiMaPeriod: parseInt(process.env.RSI_MA_PERIOD || "14", 10),
  macdFast: parseInt(process.env.MACD_FAST || "12", 10),
  macdSlow: parseInt(process.env.MACD_SLOW || "26", 10),
  macdSignal: parseInt(process.env.MACD_SIGNAL || "9", 10),
  vwapSlopeLookbackMinutes: parseInt(process.env.VWAP_SLOPE_LOOKBACK || "5", 10),

  // Output
  outputFormat: process.env.OUTPUT_FORMAT || "json", // "json" or "text"
  logDir: process.env.LOG_DIR || "./logs"
};
