/**
 * Kalshi API - US-regulated prediction market
 * Supports both authenticated and unauthenticated access
 */

import { CONFIG } from "../config.js";
import crypto from "node:crypto";

/**
 * Generate authentication headers for Kalshi API
 * @param {string} method - HTTP method
 * @param {string} path - API path (without query params)
 * @returns {Object} Headers object with authentication
 */
function getAuthHeaders(method, path) {
    const { apiKeyId, privateKey } = CONFIG.kalshi;

    if (!apiKeyId || !privateKey) {
        return {}; // Unauthenticated request
    }

    const timestamp = Date.now().toString();
    const message = `${timestamp}${method.toUpperCase()}${path}`;

    // Sign with RSA-PSS SHA256
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(message);
    const signature = sign.sign({
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, "base64");

    return {
        "KALSHI-ACCESS-KEY": apiKeyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature
    };
}

/**
 * Make a request to Kalshi API
 * @param {string} path - API path
 * @param {Object} options - Fetch options
 * @returns {Promise<any>}
 */
async function kalshiFetch(path, { method = "GET", authenticated = false } = {}) {
    const url = `${CONFIG.kalshi.baseUrl}${path}`;
    const headers = {
        "Content-Type": "application/json",
        ...(authenticated ? getAuthHeaders(method, path) : {})
    };

    const res = await fetch(url, { method, headers });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Kalshi API error ${res.status}: ${text}`);
    }
    return res.json();
}

/**
 * Fetch series information
 * @param {string} seriesTicker - e.g., "KXBTCD"
 * @returns {Promise<Object>}
 */
export async function fetchSeries(seriesTicker) {
    const data = await kalshiFetch(`/series/${seriesTicker}`);
    return data.series;
}

/**
 * Fetch all open markets for a series
 * @param {string} seriesTicker - e.g., "KXBTCD"
 * @param {string} status - "open", "closed", or "all"
 * @returns {Promise<Array>}
 */
export async function fetchMarkets(seriesTicker, status = "open") {
    const data = await kalshiFetch(`/markets?series_ticker=${seriesTicker}&status=${status}`);
    return data.markets || [];
}

/**
 * Fetch a specific market by ticker
 * @param {string} marketTicker - e.g., "KXBTCD-26JAN31-T105000"
 * @returns {Promise<Object>}
 */
export async function fetchMarket(marketTicker) {
    const data = await kalshiFetch(`/markets/${marketTicker}`);
    return data.market;
}

/**
 * Fetch event details
 * @param {string} eventTicker
 * @returns {Promise<Object>}
 */
export async function fetchEvent(eventTicker) {
    const data = await kalshiFetch(`/events/${eventTicker}`);
    return data.event;
}

/**
 * Fetch orderbook for a market
 * @param {string} marketTicker
 * @returns {Promise<{yes: Array, no: Array}>}
 */
export async function fetchOrderBook(marketTicker) {
    const data = await kalshiFetch(`/markets/${marketTicker}/orderbook`);
    return data.orderbook;
}

/**
 * Parse market title or ticker to extract strike price
 * Examples:
 *   - Title: "Bitcoin above $105,000?" -> 105000
 *   - Ticker: "KXBTCD-26JAN3122-T78499.99" -> 78499.99
 * @param {Object} market
 * @returns {number|null}
 */
export function parseStrikePrice(market) {
    // First try to extract from title
    const title = market?.title || market?.subtitle || "";
    const titleMatch = title.match(/\$?([\d,]+(?:\.\d+)?)/);
    if (titleMatch) {
        const numStr = titleMatch[1].replace(/,/g, "");
        const num = parseFloat(numStr);
        if (Number.isFinite(num) && num > 1000) return num;
    }

    // Fallback: extract from ticker (format: KXBTCD-26JAN3122-T78499.99)
    const ticker = market?.ticker || "";
    const tickerMatch = ticker.match(/-T(\d+(?:\.\d+)?)/i);
    if (tickerMatch) {
        const num = parseFloat(tickerMatch[1]);
        if (Number.isFinite(num) && num > 1000) return num;
    }

    // Try floor_strike or ceiling_strike fields
    const floor = parseFloat(market?.floor_strike);
    if (Number.isFinite(floor) && floor > 1000) return floor;

    const ceiling = parseFloat(market?.ceiling_strike);
    if (Number.isFinite(ceiling) && ceiling > 1000) return ceiling;

    return null;
}

/**
 * Parse market expiration/settlement time
 * Kalshi has multiple time fields:
 *   - close_time: When trading closes (use this!)
 *   - expected_expiration_time: When settlement happens
 *   - expiration_time: Latest possible expiration (misleading for hourly markets)
 * @param {Object} market
 * @returns {Date|null}
 */
export function parseExpiration(market) {
    // Prefer close_time (when trading stops) or expected_expiration_time (settlement)
    const expStr = market?.close_time || market?.expected_expiration_time || market?.expiration_time;
    if (!expStr) return null;
    const date = new Date(expStr);
    return isNaN(date.getTime()) ? null : date;
}

/**
 * Pick the best market to trade based on current price
 * Finds markets closest to current BTC price with soonest expiration
 * @param {Array} markets - Array of market objects
 * @param {number} currentPrice - Current BTC price
 * @returns {Object|null}
 */
export function pickBestMarket(markets, currentPrice) {
    if (!markets?.length || !currentPrice) return null;

    const now = Date.now();
    const candidates = markets
        .map(m => ({
            ...m,
            strike: parseStrikePrice(m),
            expiration: parseExpiration(m)
        }))
        .filter(m => m.strike && m.expiration && m.expiration.getTime() > now)
        .map(m => ({
            ...m,
            distanceFromPrice: Math.abs(m.strike - currentPrice),
            timeToExpiry: m.expiration.getTime() - now
        }))
        .sort((a, b) => {
            // Prefer markets expiring soon with strike near current price
            const timeWeight = 0.3;
            const priceWeight = 0.7;
            const scoreA = (priceWeight * a.distanceFromPrice / currentPrice) + (timeWeight * a.timeToExpiry / 3600000);
            const scoreB = (priceWeight * b.distanceFromPrice / currentPrice) + (timeWeight * b.timeToExpiry / 3600000);
            return scoreA - scoreB;
        });

    return candidates[0] || null;
}

/**
 * Pick all markets for an upcoming event (e.g., "9pm EST today")
 * Groups by event expiration time
 * @param {Array} markets
 * @returns {Object} Maps event_ticker -> array of markets
 */
export function groupMarketsByEvent(markets) {
    const groups = {};
    for (const m of markets) {
        const eventTicker = m.event_ticker;
        if (!eventTicker) continue;
        if (!groups[eventTicker]) groups[eventTicker] = [];
        groups[eventTicker].push(m);
    }
    return groups;
}

/**
 * Get the next upcoming event's markets
 * @param {Array} markets
 * @returns {Array}
 */
export function getNextEventMarkets(markets) {
    const groups = groupMarketsByEvent(markets);
    const now = Date.now();

    let earliest = null;
    let earliestMarkets = [];

    for (const [eventTicker, eventMarkets] of Object.entries(groups)) {
        const expiration = parseExpiration(eventMarkets[0]);
        if (!expiration || expiration.getTime() <= now) continue;

        if (!earliest || expiration.getTime() < earliest.getTime()) {
            earliest = expiration;
            earliestMarkets = eventMarkets;
        }
    }

    return earliestMarkets;
}

/**
 * Summarize orderbook for a market
 * @param {Object} orderbook - {yes: [[price, qty], ...], no: [[price, qty], ...]}
 * @returns {Object}
 */
export function summarizeOrderBook(orderbook) {
    const yes = orderbook?.yes || [];
    const no = orderbook?.no || [];

    const bestYesBid = yes.length ? yes[0][0] : null;
    const bestNoBid = no.length ? no[0][0] : null;

    const yesLiquidity = yes.reduce((sum, [p, q]) => sum + q, 0);
    const noLiquidity = no.reduce((sum, [p, q]) => sum + q, 0);

    return {
        bestYesBid,
        bestNoBid,
        yesLiquidity,
        noLiquidity,
        spread: bestYesBid && bestNoBid ? Math.abs(100 - bestYesBid - bestNoBid) : null
    };
}
