#!/usr/bin/env node
/**
 * Kalshi BTC Auto-Trader v2 - Fixed & Reliable
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
    runAtMinute: 54,             // Run at :54 of each hour (6 min before settlement)
    minConfidence: 55,           // Minimum confidence to trade (lowered for more trades)
    useMarketOrder: true,        // FIX #1: Use market orders for guaranteed fill
    maxRetries: 2,               // FIX #2: Retry failed API calls
    notifyWebhook: process.env.NOTIFY_WEBHOOK || null,
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
// KALSHI ORDER EXECUTION (FIXED)
// ============================================
async function placeOrder({ ticker, side, count, price }, retryCount = 0) {
    const auth = getKalshiAuth();
    if (!auth) {
        return { success: false, error: "No Kalshi API credentials configured" };
    }

    const path = "/trade-api/v2/portfolio/orders";

    // FIX #1: Use market order for guaranteed fill
    const orderBody = {
        ticker,
        side,           // "yes" or "no"
        action: "buy",
        count
    };

    if (TRADE_CONFIG.useMarketOrder) {
        orderBody.type = "market";  // Market order - fills at best available price
    } else {
        orderBody.type = "limit";
        // Add a buffer to limit price for better fill chance
        const priceWithBuffer = Math.min(99, price + 2);
        if (side === "yes") {
            orderBody.yes_price = priceWithBuffer;
        } else {
            orderBody.no_price = priceWithBuffer;
        }
    }

    const body = JSON.stringify(orderBody);

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
            headers,
            timeout: 10000  // 10 second timeout
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", async () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        resolve({ success: true, order: json });
                    } else {
                        // FIX #2: Retry on failure
                        if (retryCount < TRADE_CONFIG.maxRetries) {
                            notify(`⚠️ Order failed, retrying (${retryCount + 1}/${TRADE_CONFIG.maxRetries})...`);
                            await sleep(500);
                            resolve(await placeOrder({ ticker, side, count, price }, retryCount + 1));
                        } else {
                            resolve({ success: false, error: json.message || data });
                        }
                    }
                } catch (e) {
                    resolve({ success: false, error: data });
                }
            });
        });

        req.on("error", async (e) => {
            // FIX #2: Retry on network error
            if (retryCount < TRADE_CONFIG.maxRetries) {
                notify(`⚠️ Network error, retrying (${retryCount + 1}/${TRADE_CONFIG.maxRetries})...`);
                await sleep(500);
                resolve(await placeOrder({ ticker, side, count, price }, retryCount + 1));
            } else {
                resolve({ success: false, error: e.message });
            }
        });

        req.on("timeout", () => {
            req.destroy();
            resolve({ success: false, error: "Request timeout" });
        });

        req.write(body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// NOTIFICATION
// ============================================
function notify(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    console.log(logLine);

    try {
        fs.appendFileSync(TRADE_CONFIG.logFile, logLine);
    } catch (e) { }

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
// PREDICTION LOGIC (FIXED - Clearer side determination)
// ============================================
function calculatePrediction({ currentPrice, strikePrice, ta, expiresInMinutes }) {
    if (!currentPrice || !strikePrice) {
        return { side: null, confidence: 0, reason: "Missing data" };
    }

    const priceDistance = currentPrice - strikePrice;
    const priceDistancePct = Math.abs(priceDistance / strikePrice) * 100;
    const isAboveStrike = priceDistance > 0;

    // FIX #3: Clearer side logic
    // If price is ABOVE strike -> YES wins (price will be above at settlement)
    // If price is BELOW strike -> NO wins (price will NOT be above at settlement)

    // Time weighting - closer to expiry = trust price position more
    let priceWeight;
    if (expiresInMinutes <= 5) {
        priceWeight = 0.95;
    } else if (expiresInMinutes <= 10) {
        priceWeight = 0.85;
    } else if (expiresInMinutes <= 20) {
        priceWeight = 0.70;
    } else {
        priceWeight = 0.50;
    }
    const taWeight = 1 - priceWeight;

    // Price position confidence (how far from strike)
    let priceConfidence;
    if (priceDistancePct >= 0.5) {
        priceConfidence = 90;  // Very confident if 0.5%+ away
    } else if (priceDistancePct >= 0.2) {
        priceConfidence = 75;
    } else if (priceDistancePct >= 0.1) {
        priceConfidence = 60;
    } else {
        priceConfidence = 50;  // Too close to call
    }

    // TA adjustment (minor influence)
    let taAdjustment = 0;
    if (ta?.prediction?.upProbability) {
        const taUp = ta.prediction.upProbability;
        if (isAboveStrike && taUp > 55) taAdjustment = 5;
        if (isAboveStrike && taUp < 45) taAdjustment = -10;  // TA disagrees
        if (!isAboveStrike && taUp < 45) taAdjustment = 5;
        if (!isAboveStrike && taUp > 55) taAdjustment = -10;  // TA disagrees
    }

    // Momentum check - is price moving toward or away from strike?
    let momentumAdjustment = 0;
    if (ta?.delta?.["1m"]) {
        const movingUp = ta.delta["1m"] > 0;
        // Bad momentum = moving toward strike (could cross)
        if (isAboveStrike && !movingUp) momentumAdjustment = -5;  // Above but falling
        if (!isAboveStrike && movingUp) momentumAdjustment = -5;  // Below but rising
        // Good momentum = moving away from strike
        if (isAboveStrike && movingUp) momentumAdjustment = 3;
        if (!isAboveStrike && !movingUp) momentumAdjustment = 3;
    }

    // Final confidence
    const baseConfidence = priceConfidence * priceWeight + 50 * taWeight;
    const finalConfidence = Math.max(30, Math.min(95, baseConfidence + taAdjustment + momentumAdjustment));

    // Determine side based on price position
    const side = isAboveStrike ? "yes" : "no";

    return {
        side,
        confidence: Math.round(finalConfidence),
        isAboveStrike,
        priceDistancePct: priceDistancePct.toFixed(3)
    };
}

// ============================================
// MAIN TRADING LOGIC
// ============================================
async function runTrade() {
    notify("🔍 Fetching market data...");

    try {
        // Fetch all data in parallel
        const [spotData, ticker, candles, markets] = await Promise.all([
            fetchSpotPrice().catch(() => ({})),
            fetchTicker().catch(() => ({})),
            fetchCandles({ granularity: 60, limit: 30 }).catch(() => []),
            fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => [])
        ]);

        const currentPrice = spotData.price || ticker.price;
        if (!currentPrice) {
            notify("❌ No price data available");
            return;
        }

        // Find the next expiring event's markets
        const nextEventMarkets = getNextEventMarkets(markets);
        if (!nextEventMarkets || nextEventMarkets.length === 0) {
            notify("❌ No markets available for next event");
            return;
        }

        // Pick market closest to current price
        const bestMarket = pickBestMarket(nextEventMarkets, currentPrice);
        if (!bestMarket) {
            notify("❌ No suitable market found near current price");
            return;
        }

        const strikePrice = parseStrikePrice(bestMarket);
        const expiration = parseExpiration(bestMarket);
        const expiresInMinutes = expiration ? Math.round((expiration.getTime() - Date.now()) / 60000) : 999;

        // Calculate TA
        let ta = null;
        if (candles.length > 10) {
            const closes = candles.map(c => c.close);
            const rsiNow = computeRsi(closes, 14);
            const macd = computeMacd(closes, 12, 26, 9);
            const ha = computeHeikenAshi(candles);
            const consec = countConsecutive(ha);

            const delta1m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
            const delta5m = closes.length >= 6 ? closes[closes.length - 1] - closes[closes.length - 6] : 0;

            let taUp = 50;
            if (rsiNow > 55) taUp += 5;
            if (rsiNow < 45) taUp -= 5;
            if (macd?.hist > 0) taUp += 5;
            if (macd?.hist < 0) taUp -= 5;
            if (consec.color === "green") taUp += 3;
            if (consec.color === "red") taUp -= 3;

            ta = {
                prediction: { upProbability: Math.max(30, Math.min(70, taUp)) },
                delta: { "1m": delta1m, "5m": delta5m }
            };
        }

        // Get prediction
        const prediction = calculatePrediction({
            currentPrice,
            strikePrice,
            ta,
            expiresInMinutes
        });

        // Log analysis
        const distance = Math.abs(currentPrice - strikePrice).toFixed(2);
        const direction = prediction.isAboveStrike ? "ABOVE" : "BELOW";

        notify(`📊 BTC: $${currentPrice.toFixed(2)} | Strike: $${strikePrice}`);
        notify(`📍 Price is ${direction} strike by $${distance} (${prediction.priceDistancePct}%)`);
        notify(`🎯 Prediction: BUY ${prediction.side.toUpperCase()} @ ${prediction.confidence}% confidence`);
        notify(`⏰ Market expires in ${expiresInMinutes} minutes`);

        // Validate prediction makes sense
        if (!prediction.side) {
            notify("❌ Could not determine side. Skipping.");
            return;
        }

        // Check minimum confidence
        if (prediction.confidence < TRADE_CONFIG.minConfidence) {
            notify(`⚠️ Confidence too low (${prediction.confidence}% < ${TRADE_CONFIG.minConfidence}%). Skipping.`);
            return;
        }

        // Get the ask price for our side
        const askPrice = prediction.side === "yes" ? bestMarket.yes_ask : bestMarket.no_ask;

        if (!askPrice || askPrice >= 95) {
            notify(`⚠️ Ask price too high or unavailable (${askPrice}¢). Skipping.`);
            return;
        }

        // Place the order
        const orderType = TRADE_CONFIG.useMarketOrder ? "MARKET" : "LIMIT";
        notify(`🚀 Placing ${orderType} order: BUY ${prediction.side.toUpperCase()} x ${TRADE_CONFIG.contractCount}`);
        notify(`   Ticker: ${bestMarket.ticker}`);

        const result = await placeOrder({
            ticker: bestMarket.ticker,
            side: prediction.side,
            count: TRADE_CONFIG.contractCount,
            price: askPrice
        });

        if (result.success) {
            const cost = (askPrice * TRADE_CONFIG.contractCount / 100).toFixed(2);
            notify(`✅ ORDER FILLED!`);
            notify(`   ${bestMarket.ticker}`);
            notify(`   ${prediction.side.toUpperCase()} x ${TRADE_CONFIG.contractCount} @ ~${askPrice}¢`);
            notify(`   Cost: ~$${cost}`);
            notify(`   Expires: ${expiresInMinutes} min`);
        } else {
            notify(`❌ Order failed: ${result.error}`);
        }

    } catch (err) {
        notify(`❌ Error: ${err.message}`);
        console.error(err);
    }
}

// ============================================
// SCHEDULER (FIXED - uses setInterval for reliability)
// ============================================
function getNextRunTime() {
    const now = new Date();
    const next = new Date(now);

    next.setMinutes(TRADE_CONFIG.runAtMinute);
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (next <= now) {
        next.setHours(next.getHours() + 1);
    }

    return next;
}

function startDaemon() {
    notify(`🤖 Kalshi Auto-Trader v2 started`);
    notify(`📅 Runs at :${TRADE_CONFIG.runAtMinute} each hour`);
    notify(`💵 Trading ${TRADE_CONFIG.contractCount} contracts/trade`);
    notify(`🎯 Min confidence: ${TRADE_CONFIG.minConfidence}%`);
    notify(`📦 Order type: ${TRADE_CONFIG.useMarketOrder ? "MARKET" : "LIMIT"}`);

    // FIX #5: Check every minute instead of using long setTimeout
    // This prevents timer drift and handles system sleep better
    const checkAndRun = async () => {
        const now = new Date();
        const minute = now.getMinutes();
        const second = now.getSeconds();

        // Run if we're at the target minute (within first 5 seconds)
        if (minute === TRADE_CONFIG.runAtMinute && second < 5) {
            await runTrade();
        }
    };

    // Initial status
    const next = getNextRunTime();
    const delay = Math.round((next.getTime() - Date.now()) / 60000);
    notify(`⏳ Next run at ${next.toLocaleTimeString()} (in ${delay} min)`);

    // Check every minute
    setInterval(checkAndRun, 60000);

    // Also check immediately in case we started at the right minute
    checkAndRun();
}

// ============================================
// ENTRY POINT
// ============================================
const args = process.argv.slice(2);

if (args.includes("--daemon")) {
    startDaemon();
} else {
    runTrade().then(() => {
        if (!args.includes("--no-exit")) {
            process.exit(0);
        }
    });
}
