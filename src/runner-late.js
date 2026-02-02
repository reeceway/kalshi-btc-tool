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
import * as http from "http";
import * as crypto from "crypto";

// ============================================
// HTTP AGENTS WITH KEEP-ALIVE (SPEED OPTIMIZATION)
// ============================================
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10
});
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10
});

// ============================================
// CONFIGURATION
// ============================================
const TRADE_CONFIG = {
    positionSizePct: 10,         // Position size as % of portfolio
    minContracts: 1,             // Minimum contracts per trade
    maxContracts: 100,           // Maximum contracts per trade
    runAtMinute: 50,             // Run at :54 of each hour (6 min before settlement)
    minConfidence: 50,           // Minimum confidence to trade
    minEdge: 0,                  // Minimum edge vs market (0 = trade if any edge)

    // ACCURACY IMPROVEMENTS
    coinFlipThreshold: 20,       // Skip if price within $X of strike (lowered for more trades)
    momentumPenalty: 10,         // Reduce confidence by X% if momentum against us
    maxVolatility: 0.8,          // Skip if 5-min volatility > X% (raised for more trades)

    maxRetries: 2,
    notifyWebhook: process.env.NOTIFY_WEBHOOK || null,
    logFile: "./trades-late.log"
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

function signRequest(method, path, auth) {
    // Kalshi requires:
    // 1. RSA-PSS with SHA256
    // 2. Timestamp in MILLISECONDS
    // 3. Message = timestamp + method + path (NO body)
    const timestamp = Date.now();
    const message = `${timestamp}${method}${path}`;

    // Use RSA-PSS with SHA256
    const signature = crypto.sign("sha256", Buffer.from(message), {
        key: auth.privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    });

    return {
        "KALSHI-ACCESS-KEY": auth.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
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

    // Use limit order just slightly above ask for fast fill without overpaying
    const fillPrice = Math.min(99, price + 1);  // Only +1¢ buffer

    const orderBody = {
        ticker,
        side,           // "yes" or "no"
        action: "buy",
        count,
        type: "limit"
    };

    // Must provide exactly one price field
    if (side === "yes") {
        orderBody.yes_price = fillPrice;
    } else {
        orderBody.no_price = fillPrice;
    }

    const body = JSON.stringify(orderBody);

    const headers = {
        ...signRequest("POST", path, auth),
        "Content-Type": "application/json"
    };

    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.elections.kalshi.com",
            port: 443,
            path,
            method: "POST",
            headers,
            agent: httpsAgent,  // Keep-alive for speed
            timeout: 5000  // Reduced timeout for speed
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
// FETCH PORTFOLIO BALANCE
// ============================================
async function fetchBalance() {
    const auth = getKalshiAuth();
    if (!auth) {
        return null;
    }

    const path = "/trade-api/v2/portfolio/balance";
    const headers = signRequest("GET", path, auth);

    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.elections.kalshi.com",
            port: 443,
            path,
            method: "GET",
            headers,
            agent: httpsAgent,  // Keep-alive for speed
            timeout: 3000  // Fast timeout
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    // Balance is in cents, convert to dollars
                    resolve(json.balance ? json.balance / 100 : null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null));
        req.end();
    });
}

/**
 * Calculate position size based on portfolio balance
 * @param {number} balanceDollars - Portfolio balance in dollars
 * @param {number} pricePerContract - Price per contract in cents
 * @returns {number} Number of contracts to buy
 */
function calculatePositionSize(balanceDollars, pricePerContract) {
    if (!balanceDollars || !pricePerContract) return TRADE_CONFIG.minContracts;

    // Calculate 10% of portfolio in cents
    const maxSpendCents = balanceDollars * 100 * (TRADE_CONFIG.positionSizePct / 100);

    // How many contracts can we buy?
    const contracts = Math.floor(maxSpendCents / pricePerContract);

    // Clamp to min/max
    return Math.max(TRADE_CONFIG.minContracts, Math.min(TRADE_CONFIG.maxContracts, contracts));
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
        const startTime = Date.now();

        // SPEED OPTIMIZATION: Fetch ALL data in parallel including balance
        const [spotData, ticker, candles, markets, balance] = await Promise.all([
            fetchSpotPrice().catch(() => ({})),
            fetchTicker().catch(() => ({})),
            fetchCandles({ granularity: 60, limit: 30 }).catch(() => []),
            fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => []),
            fetchBalance().catch(() => null)  // Fetch balance in parallel!
        ]);

        const fetchTime = Date.now() - startTime;
        notify(`⚡ Data fetched in ${fetchTime}ms`);

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

        // ============================================
        // ACCURACY IMPROVEMENT #1: Skip coin flips
        // ============================================
        const distanceFromStrike = Math.abs(currentPrice - strikePrice);
        if (distanceFromStrike < TRADE_CONFIG.coinFlipThreshold) {
            notify(`🎲 COIN FLIP: Price only $${distanceFromStrike.toFixed(0)} from strike (< $${TRADE_CONFIG.coinFlipThreshold}). Skipping.`);
            return;
        }

        // ============================================
        // ACCURACY IMPROVEMENT #2: Momentum check
        // ============================================
        let adjustedConfidence = prediction.confidence;
        if (candles.length >= 3) {
            const recentCloses = candles.slice(-3).map(c => c.close);
            const momentum = recentCloses[2] - recentCloses[0];  // Last 3 min movement
            const movingTowardStrike = (prediction.isAboveStrike && momentum < 0) ||
                (!prediction.isAboveStrike && momentum > 0);

            if (movingTowardStrike) {
                adjustedConfidence -= TRADE_CONFIG.momentumPenalty;
                notify(`⚠️ Momentum against us! Confidence adjusted: ${prediction.confidence}% → ${adjustedConfidence}%`);
            }
        }

        // ============================================
        // ACCURACY IMPROVEMENT #3: Volatility filter
        // ============================================
        if (candles.length >= 5) {
            const recentCandles = candles.slice(-5);
            const high = Math.max(...recentCandles.map(c => c.high));
            const low = Math.min(...recentCandles.map(c => c.low));
            const volatilityPct = ((high - low) / currentPrice) * 100;

            if (volatilityPct > TRADE_CONFIG.maxVolatility) {
                notify(`🌊 HIGH VOLATILITY: ${volatilityPct.toFixed(2)}% in last 5 min (> ${TRADE_CONFIG.maxVolatility}%). Skipping.`);
                return;
            }
        }

        // Validate prediction makes sense
        if (!prediction.side) {
            notify("❌ Could not determine side. Skipping.");
            return;
        }

        // Check minimum confidence (using adjusted)
        if (adjustedConfidence < TRADE_CONFIG.minConfidence) {
            notify(`⚠️ Confidence too low (${adjustedConfidence}% < ${TRADE_CONFIG.minConfidence}%). Skipping.`);
            return;
        }

        // Get the ask price for our side (market's implied probability)
        const askPrice = prediction.side === "yes" ? bestMarket.yes_ask : bestMarket.no_ask;

        if (!askPrice || askPrice >= 100) {
            notify(`⚠️ Ask price too high or unavailable (${askPrice}¢). Skipping.`);
            return;
        }

        // EDGE CALCULATION: Compare our prediction vs market price
        // askPrice = market's implied probability (in cents = %)
        // Our confidence = our calculated probability
        // Edge = how much we disagree with the market
        const marketProb = askPrice;  // 60¢ = market thinks 60% chance
        const ourProb = prediction.confidence;
        const edge = ourProb - marketProb;

        notify(`📊 Market odds: ${marketProb}% | Our calc: ${ourProb}% | Edge: ${edge > 0 ? '+' : ''}${edge}%`);

        // REMOVED: Edge requirement - trade regardless of market pricing
        // Trust our prediction, not the market
        if (edge > 0) {
            notify(`✅ Positive edge: +${edge}%`);
        } else {
            notify(`📉 Negative edge: ${edge}% (trading anyway!)`);
        }

        // Balance already fetched in parallel above - check it's valid
        if (!balance) {
            notify("❌ Could not fetch portfolio balance. Skipping.");
            return;
        }

        const contractCount = calculatePositionSize(balance, askPrice);
        const estimatedCost = (askPrice * contractCount / 100).toFixed(2);
        const pctOfPortfolio = ((askPrice * contractCount / 100) / balance * 100).toFixed(1);

        notify(`💰 Portfolio: $${balance.toFixed(2)} | Sizing: ${TRADE_CONFIG.positionSizePct}% = ${contractCount} contracts`);

        // Place the order
        notify(`🚀 Placing order: BUY ${prediction.side.toUpperCase()} x ${contractCount}`);
        notify(`   Ticker: ${bestMarket.ticker}`);

        const result = await placeOrder({
            ticker: bestMarket.ticker,
            side: prediction.side,
            count: contractCount,
            price: askPrice
        });

        if (result.success) {
            notify(`✅ ORDER FILLED!`);
            notify(`   ${bestMarket.ticker}`);
            notify(`   ${prediction.side.toUpperCase()} x ${contractCount} @ ~${askPrice}¢`);
            notify(`   Cost: ~$${estimatedCost} (${pctOfPortfolio}% of portfolio)`);
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
    notify(`💵 Position sizing: ${TRADE_CONFIG.positionSizePct}% of portfolio`);
    notify(`🎯 Min confidence: ${TRADE_CONFIG.minConfidence}%`);

    let lastRunHour = -1;  // Track last run to prevent double-runs

    // Check every 10 seconds for reliable triggering
    const checkAndRun = async () => {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        // Run if we're at the target minute and haven't run this hour yet
        if (minute === TRADE_CONFIG.runAtMinute && lastRunHour !== hour) {
            lastRunHour = hour;
            notify(`⏰ Triggered at ${now.toLocaleTimeString()}`);
            await runTrade();
        }
    };

    // Initial status
    const next = getNextRunTime();
    const delay = Math.round((next.getTime() - Date.now()) / 60000);
    notify(`⏳ Next run at ${next.toLocaleTimeString()} (in ${delay} min)`);

    // Check every 1 second for FASTEST triggering
    setInterval(checkAndRun, 1000);

    // Also check immediately
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
