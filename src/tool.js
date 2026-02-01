#!/usr/bin/env node
/**
 * Kalshi BTC Tool
 * Single-execution tool for Claude moltbot integration
 * Outputs JSON with market data and TA signals
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

/**
 * Generate a clear recommendation for the moltbot
 * Tells it exactly what to buy (YES or NO), the ticker, and why
 * 
 * @param {Object} params
 * @param {number} params.currentPrice - Current BTC price
 * @param {number} params.strikePrice - Market strike price
 * @param {Object} params.market - Market object with pricing
 * @param {Object} params.ta - Technical analysis object with prediction
 * @param {Date|null} params.expiration - When this market expires
 * @returns {Object} Recommendation object
 */
function generateRecommendation({ currentPrice, strikePrice, market, ta, expiration }) {
    if (!currentPrice || !strikePrice || !market) {
        return {
            action: "NO_TRADE",
            reason: "Missing price or market data",
            ticker: null,
            side: null,
            confidence: 0,
            edge: null
        };
    }

    const priceDistance = currentPrice - strikePrice;
    const priceDistancePct = (priceDistance / strikePrice) * 100;

    // Determine initial bias from price position relative to strike
    // If price > strike: YES is favored (above strike)
    // If price < strike: NO is favored (below strike)
    const priceBasedSide = priceDistance > 0 ? "YES" : "NO";

    // Get TA prediction if available
    const taBias = ta?.prediction?.bias || "NEUTRAL";
    const upProb = ta?.prediction?.upProbability || 50;
    const downProb = ta?.prediction?.downProbability || 50;

    // Combine price position with TA signals
    // Price above strike + TA says UP = strong YES
    // Price below strike + TA says DOWN = strong NO
    // Conflicting signals = lower confidence

    let side, confidence, reasoning = [];

    // Strong agreement case
    if (priceDistance > 0 && taBias === "UP") {
        side = "YES";
        confidence = Math.min(95, 50 + Math.abs(priceDistancePct) * 5 + (upProb - 50));
        reasoning.push(`Price $${Math.abs(priceDistance).toFixed(2)} ABOVE strike`);
        reasoning.push(`TA confirms UP bias (${upProb.toFixed(1)}%)`);
    } else if (priceDistance < 0 && taBias === "DOWN") {
        side = "NO";
        confidence = Math.min(95, 50 + Math.abs(priceDistancePct) * 5 + (downProb - 50));
        reasoning.push(`Price $${Math.abs(priceDistance).toFixed(2)} BELOW strike`);
        reasoning.push(`TA confirms DOWN bias (${downProb.toFixed(1)}%)`);
    }
    // Moderate agreement - price position dominates
    else if (Math.abs(priceDistancePct) > 0.5) {
        side = priceBasedSide;
        confidence = Math.min(80, 40 + Math.abs(priceDistancePct) * 10);
        reasoning.push(`Price $${Math.abs(priceDistance).toFixed(2)} ${priceDistance > 0 ? "ABOVE" : "BELOW"} strike`);
        if (taBias !== "NEUTRAL" && taBias !== (priceDistance > 0 ? "UP" : "DOWN")) {
            reasoning.push(`⚠️ TA shows opposing ${taBias} bias`);
            confidence = Math.max(30, confidence - 20);
        }
    }
    // Close to strike - rely more on TA
    else if (taBias !== "NEUTRAL") {
        side = taBias === "UP" ? "YES" : "NO";
        confidence = Math.min(70, 40 + Math.abs(upProb - downProb));
        reasoning.push(`Price near strike (${priceDistancePct.toFixed(2)}% away)`);
        reasoning.push(`Using TA bias: ${taBias}`);
    }
    // No clear signal
    else {
        return {
            action: "NO_TRADE",
            reason: "No clear edge - price at strike with neutral TA",
            ticker: market.ticker,
            side: null,
            confidence: 0,
            edge: null
        };
    }

    // Calculate edge (model probability vs market price)
    const modelProb = side === "YES" ? upProb : downProb;
    const marketPrice = side === "YES"
        ? (market.yesAsk || market.yesBid || 50)
        : (market.noAsk || market.noBid || 50);
    const edge = modelProb - marketPrice;

    // Require minimum confidence and positive edge to trade
    if (confidence < 40 || edge < -5) {
        return {
            action: "NO_TRADE",
            reason: `Low confidence (${confidence.toFixed(0)}%) or negative edge (${edge.toFixed(1)}%)`,
            ticker: market.ticker,
            side,
            confidence: Math.round(confidence),
            edge: Math.round(edge * 10) / 10
        };
    }

    const expiresInMinutes = expiration ? Math.round((expiration.getTime() - Date.now()) / 60000) : null;

    // Warn if market expires soon - may not have time to exit
    const urgency = expiresInMinutes !== null && expiresInMinutes < 15 ? "HIGH" :
        expiresInMinutes !== null && expiresInMinutes < 30 ? "MEDIUM" : "LOW";

    return {
        action: "BUY",
        side,  // "YES" or "NO"
        ticker: market.ticker,
        eventTicker: market.ticker.split("-").slice(0, 2).join("-"),  // e.g., "KXBTCD-26JAN3122"
        strikePrice,
        currentPrice: Math.round(currentPrice * 100) / 100,
        marketPrice,  // What you'd pay in cents
        confidence: Math.round(confidence),
        edge: Math.round(edge * 10) / 10,
        expiration: expiration?.toISOString() || null,
        expiresInMinutes,
        urgency,  // HIGH = < 15 min, MEDIUM = < 30 min, LOW = > 30 min
        reasoning,
        summary: `BUY ${side} on ${market.ticker} @ ${marketPrice}¢ (${confidence.toFixed(0)}% conf, ${edge.toFixed(1)}% edge, ${expiresInMinutes}min left)`
    };
}

/**
 * Main tool execution
 */
async function run() {
    const result = {
        timestamp: new Date().toISOString(),
        success: true,
        error: null,
        data: null
    };

    try {
        // Fetch price data from Coinbase
        const [spotData, ticker, candles] = await Promise.all([
            fetchSpotPrice().catch(e => ({ error: e.message })),
            fetchTicker().catch(e => ({ error: e.message })),
            fetchCandles({ granularity: 60, limit: 240 }).catch(e => [])
        ]);

        const currentPrice = spotData.price || ticker.price || null;

        // Fetch Kalshi markets
        const markets = await fetchMarkets(CONFIG.kalshi.seriesTicker, "open").catch(() => []);

        // Get next event's markets
        const nextEventMarkets = getNextEventMarkets(markets);

        // Pick best market near current price
        const bestMarket = pickBestMarket(nextEventMarkets, currentPrice);

        // Fetch orderbook if we have a market
        let orderbook = null;
        let orderbookSummary = null;
        if (bestMarket?.ticker) {
            orderbook = await fetchOrderBook(bestMarket.ticker).catch(() => null);
            if (orderbook) {
                orderbookSummary = summarizeOrderBook(orderbook);
            }
        }

        // Compute TA indicators if we have candles
        let ta = null;
        if (candles.length > 0) {
            const closes = candles.map(c => c.close);

            // VWAP
            const vwapSeries = computeVwapSeries(candles);
            const vwapNow = vwapSeries[vwapSeries.length - 1] || null;
            const vwapSlope = vwapSeries.length >= CONFIG.vwapSlopeLookbackMinutes
                ? (vwapNow - vwapSeries[vwapSeries.length - CONFIG.vwapSlopeLookbackMinutes]) / CONFIG.vwapSlopeLookbackMinutes
                : null;
            const vwapDist = vwapNow && currentPrice ? (currentPrice - vwapNow) / vwapNow : null;

            // RSI
            const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
            const rsiSeries = [];
            for (let i = 0; i < closes.length; i++) {
                const r = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
                if (r !== null) rsiSeries.push(r);
            }
            const rsiSlope = slopeLast(rsiSeries, 3);

            // MACD
            const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

            // Heiken Ashi
            const ha = computeHeikenAshi(candles);
            const consec = countConsecutive(ha);

            // Regime detection
            const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
            const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

            const regime = detectRegime({
                price: currentPrice,
                vwap: vwapNow,
                vwapSlope,
                vwapCrossCount: null,
                volumeRecent,
                volumeAvg
            });

            // Delta (price change)
            const delta1m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : null;
            const delta3m = closes.length >= 4 ? closes[closes.length - 1] - closes[closes.length - 4] : null;
            const delta5m = closes.length >= 6 ? closes[closes.length - 1] - closes[closes.length - 6] : null;

            ta = {
                vwap: vwapNow ? Math.round(vwapNow * 100) / 100 : null,
                vwapSlope: vwapSlope ? Math.round(vwapSlope * 1000) / 1000 : null,
                vwapDistance: vwapDist ? Math.round(vwapDist * 10000) / 10000 : null,
                rsi: rsiNow ? Math.round(rsiNow * 10) / 10 : null,
                rsiSlope: rsiSlope ? Math.round(rsiSlope * 100) / 100 : null,
                macd: macd ? {
                    macd: Math.round(macd.macd * 100) / 100,
                    signal: Math.round(macd.signal * 100) / 100,
                    histogram: Math.round(macd.hist * 100) / 100,
                    histDelta: macd.histDelta ? Math.round(macd.histDelta * 100) / 100 : null
                } : null,
                heikenAshi: {
                    color: consec.color,
                    count: consec.count
                },
                regime: regime.regime,
                delta: {
                    "1m": delta1m ? Math.round(delta1m * 100) / 100 : null,
                    "3m": delta3m ? Math.round(delta3m * 100) / 100 : null,
                    "5m": delta5m ? Math.round(delta5m * 100) / 100 : null
                }
            };

            // Score direction
            const scored = scoreDirection({
                price: currentPrice,
                vwap: vwapNow,
                vwapSlope,
                rsi: rsiNow,
                rsiSlope,
                macd,
                heikenColor: consec.color,
                heikenCount: consec.count,
                failedVwapReclaim: false
            });

            // Time-aware probability (if we have market expiration)
            let timeLeftMin = null;
            if (bestMarket) {
                const exp = parseExpiration(bestMarket);
                if (exp) {
                    timeLeftMin = (exp.getTime() - Date.now()) / 60000;
                }
            }

            const timeAware = timeLeftMin !== null
                ? applyTimeAwareness(scored.rawUp, timeLeftMin, 15)
                : { adjustedUp: scored.rawUp, adjustedDown: scored.rawDown };

            ta.prediction = {
                upProbability: Math.round(timeAware.adjustedUp * 1000) / 10,
                downProbability: Math.round(timeAware.adjustedDown * 1000) / 10,
                bias: timeAware.adjustedUp > timeAware.adjustedDown ? "UP" :
                    timeAware.adjustedDown > timeAware.adjustedUp ? "DOWN" : "NEUTRAL"
            };
        }

        // Build market info
        let marketInfo = null;
        if (bestMarket) {
            const expiration = parseExpiration(bestMarket);
            const timeLeftMin = expiration ? (expiration.getTime() - Date.now()) / 60000 : null;

            // Kalshi uses yes_bid/yes_ask/no_bid/no_ask, not yes_price
            const yesBid = bestMarket.yes_bid ?? null;
            const yesAsk = bestMarket.yes_ask ?? null;
            const noBid = bestMarket.no_bid ?? null;
            const noAsk = bestMarket.no_ask ?? null;
            const lastPrice = bestMarket.last_price ?? null;

            marketInfo = {
                ticker: bestMarket.ticker,
                title: bestMarket.title,
                eventTicker: bestMarket.event_ticker,
                strikePrice: parseStrikePrice(bestMarket),
                expiration: expiration?.toISOString() || null,
                timeLeftMinutes: timeLeftMin ? Math.round(timeLeftMin * 10) / 10 : null,
                lastPrice,
                yesBid,
                yesAsk,
                noBid,
                noAsk,
                volume: bestMarket.volume,
                openInterest: bestMarket.open_interest,
                orderbook: orderbookSummary
            };
        }

        // Build all markets summary
        const allMarkets = nextEventMarkets.map(m => ({
            ticker: m.ticker,
            title: m.title,
            strikePrice: parseStrikePrice(m),
            lastPrice: m.last_price,
            yesBid: m.yes_bid,
            yesAsk: m.yes_ask,
            volume: m.volume
        }));

        // Generate recommendation - tells moltbot exactly what to do
        const strikePrice = bestMarket ? parseStrikePrice(bestMarket) : null;
        const marketExpiration = bestMarket ? parseExpiration(bestMarket) : null;
        const recommendation = generateRecommendation({
            currentPrice,
            strikePrice,
            market: bestMarket ? {
                ticker: bestMarket.ticker,
                yesBid: bestMarket.yes_bid,
                yesAsk: bestMarket.yes_ask,
                noBid: bestMarket.no_bid,
                noAsk: bestMarket.no_ask
            } : null,
            ta,
            expiration: marketExpiration
        });

        result.data = {
            // RECOMMENDATION - The most important field for moltbot
            recommendation,

            price: {
                current: currentPrice,
                bid: ticker.bid || null,
                ask: ticker.ask || null,
                source: "coinbase"
            },
            market: marketInfo,
            allMarkets: allMarkets.length > 0 ? allMarkets : null,
            technicalAnalysis: ta,
            meta: {
                seriesTicker: CONFIG.kalshi.seriesTicker,
                totalMarketsOpen: markets.length,
                nextEventMarketsCount: nextEventMarkets.length
            }
        };
    } catch (err) {
        result.success = false;
        result.error = err.message;
    }

    // Output JSON
    console.log(JSON.stringify(result, null, 2));
}

run().catch(err => {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        success: false,
        error: err.message,
        data: null
    }, null, 2));
    process.exit(1);
});
