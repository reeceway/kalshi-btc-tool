/**
 * Coinbase API - US-based BTC price data
 * No authentication required for public endpoints
 */

import { CONFIG } from "../config.js";

/**
 * Fetch current BTC-USD spot price from Coinbase
 * @returns {Promise<{price: number, currency: string, timestamp: string}>}
 */
export async function fetchSpotPrice() {
    const url = `${CONFIG.coinbase.baseUrl}/prices/BTC-USD/spot`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase spot price error: ${res.status}`);
    }
    const data = await res.json();
    return {
        price: parseFloat(data.data.amount),
        currency: data.data.currency,
        timestamp: new Date().toISOString()
    };
}

/**
 * Fetch BTC-USD ticker from Coinbase Exchange (more detailed)
 * @returns {Promise<{price: number, bid: number, ask: number, volume: number, timestamp: string}>}
 */
export async function fetchTicker() {
    const url = `${CONFIG.coinbase.exchangeUrl}/products/BTC-USD/ticker`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase ticker error: ${res.status}`);
    }
    const data = await res.json();
    return {
        price: parseFloat(data.price),
        bid: parseFloat(data.bid),
        ask: parseFloat(data.ask),
        volume: parseFloat(data.volume),
        timestamp: data.time
    };
}

/**
 * Fetch historical candles from Coinbase Exchange
 * @param {Object} options
 * @param {number} options.granularity - Candle size in seconds (60, 300, 900, 3600, 21600, 86400)
 * @param {number} options.limit - Number of candles to fetch (max 300)
 * @returns {Promise<Array<{time: number, open: number, high: number, low: number, close: number, volume: number}>>}
 */
export async function fetchCandles({ granularity = 60, limit = 240 } = {}) {
    // Coinbase Exchange returns candles in reverse chronological order
    // Each candle: [timestamp, low, high, open, close, volume]
    const url = `${CONFIG.coinbase.exchangeUrl}/products/BTC-USD/candles?granularity=${granularity}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase candles error: ${res.status}`);
    }
    const data = await res.json();

    // Transform to standard OHLCV format and reverse to chronological order
    const candles = data
        .slice(0, limit)
        .reverse()
        .map(([time, low, high, open, close, volume]) => ({
            time: time * 1000, // Convert to milliseconds
            open,
            high,
            low,
            close,
            volume
        }));

    return candles;
}

/**
 * Fetch 24-hour stats from Coinbase Exchange
 * @returns {Promise<{open: number, high: number, low: number, volume: number, last: number}>}
 */
export async function fetch24hrStats() {
    const url = `${CONFIG.coinbase.exchangeUrl}/products/BTC-USD/stats`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase stats error: ${res.status}`);
    }
    const data = await res.json();
    return {
        open: parseFloat(data.open),
        high: parseFloat(data.high),
        low: parseFloat(data.low),
        volume: parseFloat(data.volume),
        last: parseFloat(data.last)
    };
}
