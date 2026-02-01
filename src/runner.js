#!/usr/bin/env node
/**
 * Kalshi BTC Auto-Trader
 * Runs on a schedule, places orders, notifies on fill
 * 
 * Usage:
 *   node src/runner.js              # Run once now
 *   node src/runner.js --daemon     # Run continuously on schedule
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
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";

// ============================================
// CONFIGURATION
// ============================================
const TRADE_CONFIG = {
    contractCount: 10,           // Number of contracts per trade
    runAtMinute: 56,             // Run at :56 of each hour (4 min before settlement)
    minConfidence: 60,           // Minimum confidence to trade
    notifyWebhook: process.env.NOTIFY_WEBHOOK || null,  // Optional webhook for notifications
    logFile: "./trades.log"
};

// ============================================
// KALSHI API AUTH
// ============================================
function getKalshiAuth() {
    const keyId = process.env.KALSHI_API_KEY_ID;
    const keyFile = process.env.KALSHI_PRIVATE_KEY_FILE;

    if (!keyId || !keyFile) {
        return null;
    }

    try {
        const privateKey = fs.readFileSync(keyFile, "utf8");
        return { keyId, privateKey };
    } catch (e) {
        console.error("Failed to read Kalshi private key:", e.message);
        return null;
    }
}

function signRequest(method, path, body, auth) {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `${timestamp}${method}${path}${body || ""}`;

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(message);
    const signature = sign.sign(auth.privateKey, "base64");

    return {
        "KALSHI-ACCESS-KEY": auth.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp.toString()
    };
}

// ============================================
// KALSHI ORDER EXECUTION
// ============================================
async function placeOrder({ ticker, side, count, price }) {
    const auth = getKalshiAuth();
    if (!auth) {
        return { success: false, error: "No Kalshi API credentials configured" };
    }

    const path = "/trade-api/v2/portfolio/orders";
    const body = JSON.stringify({
        ticker,
        side,           // "yes" or "no"
        action: "buy",
        type: "limit",
        count,
        yes_price: side === "yes" ? price : undefined,
        no_price: side === "no" ? price : undefined
    });

    const headers = {
        ...signRequest("POST", path, body, auth),
        "Content-Type": "application/json"
    };

    return new Promise((resolve) => {
        const req = https.request({
            hostname: "trading-api.kalshi.com",
            port: 443,
            path,
            method: "POST",
            headers
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        resolve({ success: true, order: json });
                    } else {
                        resolve({ success: false, error: json.message || data });
                    }
                } catch (e) {
                    resolve({ success: false, error: data });
                }
            });
        });

        req.on("error", (e) => {
            resolve({ success: false, error: e.message });
        });

        req.write(body);
        req.end();
    });
}

// ============================================
// NOTIFICATION
// ============================================
function notify(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    // Log to console
    console.log(logLine);

    // Log to file
    try {
        fs.appendFileSync(TRADE_CONFIG.logFile, logLine);
    } catch (e) { }

    // Send webhook notification if configured
    if (TRADE_CONFIG.notifyWebhook) {
        const url = new URL(TRADE_CONFIG.notifyWebhook);
        const body = JSON.stringify({ text: message });

        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        req.write(body);
        req.end();
    }
}

// ============================================
// PREDICTION LOGIC (Time-Weighted)
// ============================================
function calculatePrediction({ currentPrice, strikePrice, ta, expiresInMinutes, orderbook }) {
    if (!currentPrice || !strikePrice) {
        return { side: null, confidence: 0, reason: "Missing data" };
    }

    const priceDistance = currentPrice - strikePrice;
    const priceDistancePct = Math.abs(priceDistance / strikePrice) * 100;
    const isAboveStrike = priceDistance > 0;

    // Time weighting
    let taWeight, priceWeight;
    if (expiresInMinutes <= 5) {
        taWeight = 0.05; priceWeight = 0.95;
    } else if (expiresInMinutes <= 15) {
        taWeight = 0.20; priceWeight = 0.80;
    } else if (expiresInMinutes <= 30) {
        taWeight = 0.40; priceWeight = 0.60;
    } else {
        taWeight = 0.60; priceWeight = 0.40;
    }

    // Price score
    let priceScore = 50;
    if (priceDistancePct > 0.5) priceScore = isAboveStrike ? 75 : 25;
    if (priceDistancePct > 1.0) priceScore = isAboveStrike ? 85 : 15;
    if (priceDistancePct > 2.0) priceScore = isAboveStrike ? 95 : 5;

    // TA score
    let taScore = ta?.prediction?.upProbability || 50;

    // Momentum
    let momentumAdj = 0;
    if (ta?.delta?.["1m"]) {
        const delta1m = ta.delta["1m"];
        if (isAboveStrike && delta1m < 0) momentumAdj = -5;
        if (!isAboveStrike && delta1m > 0) momentumAdj = -5;
        if (isAboveStrike && delta1m > 0) momentumAdj = 5;
        if (!isAboveStrike && delta1m < 0) momentumAdj = 5;
    }

    // Volatility penalty
    let volatilityPenalty = 0;
    if (ta?.delta?.["5m"]) {
        const absMove = Math.abs(ta.delta["5m"]);
        if (absMove > 200) volatilityPenalty = 10;
        if (absMove > 400) volatilityPenalty = 20;
    }

    // Combine
    const combinedScore = (priceScore * priceWeight) + (taScore * taWeight) + momentumAdj;
    const finalConfidence = Math.max(10, Math.min(95, combinedScore - volatilityPenalty));

    const side = finalConfidence > 50 ? "yes" : "no";
    const confidence = side === "yes" ? finalConfidence : (100 - finalConfidence);

    return { side, confidence: Math.round(confidence) };
}

// ============================================
// MAIN TRADING LOGIC
// ============================================
async function runTrade() {
    notify("🔍 Fetching market data...");

    try {
        // Fetch all data
        const [spotData, ticker, candles, markets] = await Promise.all([
            fetchSpotPrice().catch(() => ({})),
            fetchTicker().catch(() => ({})),
            fetchCandles({ granularity: 60, limit: 60 }).catch(() => []),
            fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => [])
        ]);

        const currentPrice = spotData.price || ticker.price;
        if (!currentPrice) {
            notify("❌ No price data available");
            return;
        }

        // Find best market
        const nextEventMarkets = getNextEventMarkets(markets);
        const bestMarket = pickBestMarket(nextEventMarkets, currentPrice);

        if (!bestMarket) {
            notify("❌ No market available");
            return;
        }

        const strikePrice = parseStrikePrice(bestMarket);
        const expiration = parseExpiration(bestMarket);
        const expiresInMinutes = expiration ? Math.round((expiration.getTime() - Date.now()) / 60000) : 999;

        // Get orderbook
        const orderbook = await fetchOrderBook(bestMarket.ticker).catch(() => null);

        // Calculate TA
        let ta = null;
        if (candles.length > 0) {
            const closes = candles.map(c => c.close);
            const rsiNow = computeRsi(closes, 14);
            const macd = computeMacd(closes, 12, 26, 9);
            const ha = computeHeikenAshi(candles);
            const consec = countConsecutive(ha);

            const delta1m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
            const delta5m = closes.length >= 6 ? closes[closes.length - 1] - closes[closes.length - 6] : 0;

            let taUp = 50;
            if (rsiNow > 60) taUp += 10;
            if (rsiNow < 40) taUp -= 10;
            if (macd?.hist > 0) taUp += 10;
            if (macd?.hist < 0) taUp -= 10;
            if (consec.color === "green") taUp += 5;
            if (consec.color === "red") taUp -= 5;

            ta = {
                prediction: { upProbability: Math.max(10, Math.min(90, taUp)) },
                delta: { "1m": delta1m, "5m": delta5m }
            };
        }

        // Get prediction
        const prediction = calculatePrediction({
            currentPrice,
            strikePrice,
            ta,
            expiresInMinutes,
            orderbook: orderbook ? summarizeOrderBook(orderbook) : null
        });

        // Log analysis
        const priceVsStrike = currentPrice > strikePrice ? "ABOVE" : "BELOW";
        const distance = Math.abs(currentPrice - strikePrice).toFixed(2);

        notify(`📊 BTC: $${currentPrice.toFixed(2)} | Strike: $${strikePrice} | ${priceVsStrike} by $${distance}`);
        notify(`📈 Prediction: ${prediction.side.toUpperCase()} with ${prediction.confidence}% confidence`);
        notify(`⏰ Expires in ${expiresInMinutes} minutes`);

        // Check if we should trade
        if (prediction.confidence < TRADE_CONFIG.minConfidence) {
            notify(`⚠️ Confidence too low (${prediction.confidence}% < ${TRADE_CONFIG.minConfidence}%). Skipping trade.`);
            return;
        }

        // Get execution price (use ask for guaranteed fill)
        const price = prediction.side === "yes" ? bestMarket.yes_ask : bestMarket.no_ask;

        if (!price || price > 95) {
            notify(`⚠️ Price unavailable or too high (${price}¢). Skipping.`);
            return;
        }

        // Place order
        notify(`🚀 Placing order: BUY ${prediction.side.toUpperCase()} @ ${price}¢ x ${TRADE_CONFIG.contractCount}`);

        const result = await placeOrder({
            ticker: bestMarket.ticker,
            side: prediction.side,
            count: TRADE_CONFIG.contractCount,
            price
        });

        if (result.success) {
            notify(`✅ ORDER FILLED! ${bestMarket.ticker} ${prediction.side.toUpperCase()} @ ${price}¢ x ${TRADE_CONFIG.contractCount}`);
            notify(`💰 Cost: $${(price * TRADE_CONFIG.contractCount / 100).toFixed(2)}`);
        } else {
            notify(`❌ Order failed: ${result.error}`);
        }

    } catch (err) {
        notify(`❌ Error: ${err.message}`);
    }
}

// ============================================
// SCHEDULER
// ============================================
function getNextRunTime() {
    const now = new Date();
    const next = new Date(now);

    // Set to target minute
    next.setMinutes(TRADE_CONFIG.runAtMinute);
    next.setSeconds(0);
    next.setMilliseconds(0);

    // If we've passed this minute, go to next hour
    if (next <= now) {
        next.setHours(next.getHours() + 1);
    }

    return next;
}

function startDaemon() {
    notify(`🤖 Kalshi Auto-Trader started`);
    notify(`📅 Will run at :${TRADE_CONFIG.runAtMinute} of each hour`);
    notify(`💵 Trading ${TRADE_CONFIG.contractCount} contracts per trade`);
    notify(`🎯 Min confidence: ${TRADE_CONFIG.minConfidence}%`);

    const scheduleNext = () => {
        const next = getNextRunTime();
        const delay = next.getTime() - Date.now();

        notify(`⏳ Next run at ${next.toLocaleTimeString()} (in ${Math.round(delay / 60000)} minutes)`);

        setTimeout(async () => {
            await runTrade();
            scheduleNext();  // Schedule next run
        }, delay);
    };

    scheduleNext();
}

// ============================================
// ENTRY POINT
// ============================================
const args = process.argv.slice(2);

if (args.includes("--daemon")) {
    startDaemon();
} else {
    // Single run
    runTrade().then(() => {
        if (!args.includes("--no-exit")) {
            process.exit(0);
        }
    });
}
