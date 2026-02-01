#!/usr/bin/env node
/**
 * Kalshi BTC Tool v2 - Improved Accuracy
 * Outputs a simple "execute this" command for the moltbot
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
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";

/**
 * IMPROVED: Time-weighted prediction
 * Closer to expiry = price position matters more, TA matters less
 */
function calculatePrediction({ currentPrice, strikePrice, ta, expiresInMinutes, orderbook }) {
    if (!currentPrice || !strikePrice) {
        return { side: null, confidence: 0, reason: "Missing data" };
    }

    const priceDistance = currentPrice - strikePrice;
    const priceDistancePct = Math.abs(priceDistance / strikePrice) * 100;
    const isAboveStrike = priceDistance > 0;

    // === TIME WEIGHTING ===
    // With lots of time: TA = 60%, Price = 40%
    // With < 15 min: TA = 20%, Price = 80%
    // With < 5 min: TA = 5%, Price = 95%
    let taWeight, priceWeight;
    if (expiresInMinutes <= 5) {
        taWeight = 0.05;
        priceWeight = 0.95;
    } else if (expiresInMinutes <= 15) {
        taWeight = 0.20;
        priceWeight = 0.80;
    } else if (expiresInMinutes <= 30) {
        taWeight = 0.40;
        priceWeight = 0.60;
    } else {
        taWeight = 0.60;
        priceWeight = 0.40;
    }

    // === PRICE POSITION SCORE ===
    // How far from strike determines confidence
    let priceScore = 50; // neutral
    if (priceDistancePct > 0.5) priceScore = isAboveStrike ? 75 : 25;
    if (priceDistancePct > 1.0) priceScore = isAboveStrike ? 85 : 15;
    if (priceDistancePct > 2.0) priceScore = isAboveStrike ? 95 : 5;

    // === TA SCORE ===
    let taScore = 50; // neutral
    if (ta?.prediction?.upProbability) {
        taScore = ta.prediction.upProbability;
    }

    // === MOMENTUM ADJUSTMENT ===
    // If price is moving toward strike, reduce confidence
    let momentumAdj = 0;
    if (ta?.delta?.["1m"]) {
        const delta1m = ta.delta["1m"];
        // Moving toward strike = bad
        if (isAboveStrike && delta1m < 0) momentumAdj = -5;
        if (!isAboveStrike && delta1m > 0) momentumAdj = -5;
        // Moving away from strike = good
        if (isAboveStrike && delta1m > 0) momentumAdj = 5;
        if (!isAboveStrike && delta1m < 0) momentumAdj = 5;
    }

    // === ORDERBOOK SENTIMENT ===
    let orderbookAdj = 0;
    if (orderbook) {
        const yesLiq = orderbook.yesLiquidity || 0;
        const noLiq = orderbook.noLiquidity || 0;
        const total = yesLiq + noLiq;
        if (total > 0) {
            const yesBias = yesLiq / total;
            // If orderbook heavily favors one side, slight adjustment
            if (yesBias > 0.6) orderbookAdj = 3;
            if (yesBias < 0.4) orderbookAdj = -3;
        }
    }

    // === VOLATILITY PENALTY ===
    let volatilityPenalty = 0;
    if (ta?.delta?.["5m"]) {
        const absMove = Math.abs(ta.delta["5m"]);
        // If BTC moved > $200 in 5 min, reduce confidence
        if (absMove > 200) volatilityPenalty = 10;
        if (absMove > 400) volatilityPenalty = 20;
    }

    // === COMBINE SCORES ===
    const combinedScore = (priceScore * priceWeight) + (taScore * taWeight) + momentumAdj + orderbookAdj;
    const finalConfidence = Math.max(10, Math.min(95, combinedScore - volatilityPenalty));

    // Determine side
    const side = finalConfidence > 50 ? "YES" : "NO";
    const confidence = side === "YES" ? finalConfidence : (100 - finalConfidence);

    // Build reason
    const reasons = [];
    if (priceDistancePct > 0.1) {
        reasons.push(`Price $${Math.abs(priceDistance).toFixed(0)} ${isAboveStrike ? "ABOVE" : "BELOW"} strike`);
    }
    if (expiresInMinutes <= 15) {
        reasons.push(`${expiresInMinutes}min left (price-weighted)`);
    }
    if (momentumAdj !== 0) {
        reasons.push(`Momentum ${momentumAdj > 0 ? "favorable" : "unfavorable"}`);
    }

    return {
        side,
        confidence: Math.round(confidence),
        reasons,
        weights: { ta: taWeight, price: priceWeight }
    };
}

/**
 * Main execution
 */
async function run() {
    try {
        // Parallel fetch all data
        const [spotData, ticker, candles, markets] = await Promise.all([
            fetchSpotPrice().catch(e => ({ error: e.message })),
            fetchTicker().catch(e => ({ error: e.message })),
            fetchCandles({ granularity: 60, limit: 120 }).catch(e => []),
            fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => [])
        ]);

        const currentPrice = spotData.price || ticker.price || null;
        if (!currentPrice) {
            console.log(JSON.stringify({ error: "No price data", execute: null }));
            return;
        }

        // Get next event markets and pick best
        const nextEventMarkets = getNextEventMarkets(markets);
        const bestMarket = pickBestMarket(nextEventMarkets, currentPrice);

        if (!bestMarket) {
            console.log(JSON.stringify({ error: "No market available", execute: null }));
            return;
        }

        // Get orderbook
        const orderbook = await fetchOrderBook(bestMarket.ticker).catch(() => null);
        const orderbookSummary = orderbook ? summarizeOrderBook(orderbook) : null;

        // Calculate TA
        let ta = null;
        if (candles.length > 0) {
            const closes = candles.map(c => c.close);
            const vwapSeries = computeVwapSeries(candles);
            const rsiNow = computeRsi(closes, 14);
            const macd = computeMacd(closes, 12, 26, 9);
            const ha = computeHeikenAshi(candles);
            const consec = countConsecutive(ha);

            const delta1m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
            const delta5m = closes.length >= 6 ? closes[closes.length - 1] - closes[closes.length - 6] : 0;

            // Simple TA prediction
            let taUp = 50;
            if (rsiNow > 60) taUp += 10;
            if (rsiNow < 40) taUp -= 10;
            if (macd?.hist > 0) taUp += 10;
            if (macd?.hist < 0) taUp -= 10;
            if (consec.color === "green") taUp += 5 * Math.min(consec.count, 3);
            if (consec.color === "red") taUp -= 5 * Math.min(consec.count, 3);

            ta = {
                prediction: { upProbability: Math.max(10, Math.min(90, taUp)) },
                delta: { "1m": delta1m, "5m": delta5m }
            };
        }

        // Parse market info
        const strikePrice = parseStrikePrice(bestMarket);
        const expiration = parseExpiration(bestMarket);
        const expiresInMinutes = expiration ? Math.round((expiration.getTime() - Date.now()) / 60000) : 999;

        // Calculate prediction with improved algorithm
        const prediction = calculatePrediction({
            currentPrice,
            strikePrice,
            ta,
            expiresInMinutes,
            orderbook: orderbookSummary
        });

        // Get execution price (use ASK for guaranteed fill)
        const yesAsk = bestMarket.yes_ask || 50;
        const noAsk = bestMarket.no_ask || 50;
        const executePrice = prediction.side === "YES" ? yesAsk : noAsk;

        // === SIMPLE OUTPUT FOR MOLTBOT ===
        const output = {
            // EXECUTE THIS - no thinking required
            execute: {
                ticker: bestMarket.ticker,
                side: prediction.side.toLowerCase(),  // "yes" or "no"
                action: "buy",
                price: executePrice,  // Use this price or "market"
                count: 10  // Number of contracts (adjust as needed)
            },

            // Context (for logging/debugging)
            context: {
                btcPrice: Math.round(currentPrice * 100) / 100,
                strikePrice,
                priceVsStrike: currentPrice > strikePrice ? "ABOVE" : "BELOW",
                distanceFromStrike: Math.round(Math.abs(currentPrice - strikePrice) * 100) / 100,
                expiresInMinutes,
                confidence: prediction.confidence,
                reasons: prediction.reasons
            },

            // Timing
            timestamp: new Date().toISOString()
        };

        console.log(JSON.stringify(output, null, 2));

    } catch (err) {
        console.log(JSON.stringify({ error: err.message, execute: null }));
    }
}

run();
