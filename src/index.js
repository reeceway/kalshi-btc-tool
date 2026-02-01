#!/usr/bin/env node
/**
 * Kalshi BTC Tool - Watch Mode
 * Continuous monitoring with console output
 */

import { CONFIG } from "./config.js";
import { fetchSpotPrice, fetchCandles, fetchTicker } from "./data/coinbase.js";
import {
  fetchMarkets,
  fetchOrderBook,
  getNextEventMarkets,
  pickBestMarket,
  parseStrikePrice,
  parseExpiration,
  summarizeOrderBook
} from "./data/kalshi.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { sleep, formatNumber, formatPct } from "./utils.js";
import readline from "node:readline";

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  return `${ANSI.white}${ch.repeat(screenWidth())}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function fmtTimeLeft(mins) {
  if (mins === null || mins === undefined) return "--:--";
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

async function main() {
  console.log("Starting Kalshi BTC Tool (Watch Mode)...\n");

  while (true) {
    try {
      // Fetch price data
      const [spotData, ticker, candles] = await Promise.all([
        fetchSpotPrice().catch(e => ({ error: e.message })),
        fetchTicker().catch(e => ({ error: e.message })),
        fetchCandles({ granularity: 60, limit: 240 }).catch(() => [])
      ]);

      const currentPrice = spotData.price || ticker.price || null;

      // Fetch Kalshi markets
      const markets = await fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => []);
      const nextEventMarkets = getNextEventMarkets(markets);
      const bestMarket = pickBestMarket(nextEventMarkets, currentPrice);

      // TA
      let ta = null;
      if (candles.length > 0) {
        const closes = candles.map(c => c.close);
        const vwapSeries = computeVwapSeries(candles);
        const vwapNow = vwapSeries[vwapSeries.length - 1] || null;
        const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
        const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
        const ha = computeHeikenAshi(candles);
        const consec = countConsecutive(ha);

        ta = { vwap: vwapNow, rsi: rsiNow, macd, heikenAshi: consec };
      }

      // Market info
      let expiration = null;
      let timeLeftMin = null;
      if (bestMarket) {
        expiration = parseExpiration(bestMarket);
        if (expiration) {
          timeLeftMin = (expiration.getTime() - Date.now()) / 60000;
        }
      }

      // Build display
      const lines = [
        sepLine("═"),
        `${ANSI.white}KALSHI BTC TOOL${ANSI.reset}  |  ${fmtEtTime()}`,
        sepLine(),
        "",
        `BTC Price:       ${ANSI.green}$${formatNumber(currentPrice, 2)}${ANSI.reset}  (Coinbase)`,
        "",
        sepLine(),
        "",
        bestMarket ? `Market:          ${bestMarket.ticker}` : "Market:          (no open markets)",
        bestMarket ? `Strike:          $${formatNumber(parseStrikePrice(bestMarket), 0)}` : "",
        bestMarket ? `Time Left:       ${fmtTimeLeft(timeLeftMin)}` : "",
        bestMarket ? `YES Price:       ${bestMarket.yes_price}¢` : "",
        bestMarket ? `NO Price:        ${100 - (bestMarket.yes_price || 0)}¢` : "",
        "",
        sepLine(),
        "",
        ta ? `VWAP:            $${formatNumber(ta.vwap, 2)}` : "",
        ta ? `RSI:             ${formatNumber(ta.rsi, 1)}` : "",
        ta?.macd ? `MACD Hist:       ${formatNumber(ta.macd.hist, 2)}` : "",
        ta?.heikenAshi ? `Heiken Ashi:     ${ta.heikenAshi.color} x${ta.heikenAshi.count}` : "",
        "",
        sepLine(),
        `${ANSI.dim}${ANSI.gray}Next update in ${CONFIG.pollIntervalMs / 1000}s...${ANSI.reset}`
      ].filter(Boolean);

      renderScreen(lines.join("\n") + "\n");
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
