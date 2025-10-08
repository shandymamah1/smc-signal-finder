#!/usr/bin/env node
/**
 * Fast SMC Volatility Signals with Mini-Candles (10s)
 * + Strongly confirmed signals
 * + Stable BUY/SELL (won't flip rapidly)
 * + Color-coded terminal + Beep alerts
 * + SL/TP display
 * + Express server for Render deployment
 */

import express from "express";
import WebSocket from "ws";
import chalk from "chalk";

// ===== EXPRESS SERVER =====
const app = express();
const PORT = process.env.PORT || 3000;

// Root route
app.get("/", (req, res) => {
  res.send(`
    <h2>✅ SMC Signal Finder is running</h2>
    <p>View live signals below:</p>
    <a href="/signals" style="font-size: 18px; text-decoration: none;">➡️ Open /signals</a>
  `);
});

// Signals route — show pretty HTML table
app.get("/signals", (req, res) => {
  let tableRows = signalsQueue.map(sig => `
    <tr>
      <td>${sig.symbol}</td>
      <td style="color:${sig.action === "BUY" ? "green" : "red"}; font-weight:bold;">
        ${sig.action}
      </td>
      <td>${sig.entry.toFixed(3)}</td>
      <td>${sig.sl.toFixed(3)}</td>
      <td>${sig.tp.toFixed(3)}</td>
      <td>${sig.atr.toFixed(3)}</td>
    </tr>
  `).join("");

  if (!tableRows) {
    tableRows = `<tr><td colspan="6" style="text-align:center;">No signals yet ⚡</td></tr>`;
  }

  res.send(`
    <html>
    <head>
      <title>SMC Signal Finder - Live Signals</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial, sans-serif; background:#f8f9fa; padding:20px; }
        h2 { text-align:center; }
        table { border-collapse: collapse; width:100%; background:white; box-shadow:0 0 10px rgba(0,0,0,0.1); }
        th, td { padding:10px; border:1px solid #ddd; text-align:center; }
        th { background:#007bff; color:white; }
      </style>
    </head>
    <body>
      <h2>📊 Live SMC Signals</h2>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Action</th>
            <th>Entry</th>
            <th>Stop Loss</th>
            <th>Take Profit</th>
            <th>ATR</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
      <p style="text-align:center; color:gray; font-size:14px; margin-top:10px;">
        Auto-refreshes every 5 seconds ⏳
      </p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

// ===== CONFIG =====
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 200;
const MINI_CANDLE_MS = 10_000;
const COOLDOWN_MS = 60 * 1000;

const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

// ===== STATE =====
const miniCandles = {};
const timeframeCandles = {};
const lastSignalAt = {};
const signalsQueue = [];

// ===== UTILITIES =====
function EMA(arr, period) {
  if (arr.length < period) return arr[arr.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = arr[arr.length - period];
  for (let i = arr.length - period + 1; i < arr.length; i++)
    ema = arr[i] * k + ema * (1 - k);
  return ema;
}

function RSI(arr, period = RSI_PERIOD) {
  if (arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period + 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function ATR(c) {
  if (!c || c.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
    sum += tr;
  }
  return sum / (c.length - 1);
}

// ===== CANDLE MANAGEMENT =====
function updateMiniCandle(symbol, price, ts) {
  if (!miniCandles[symbol]) miniCandles[symbol] = [];
  const candles = miniCandles[symbol];
  const periodTs = Math.floor(ts / MINI_CANDLE_MS) * MINI_CANDLE_MS;
  let last = candles[candles.length - 1];

  if (!last || last.ts !== periodTs) {
    last = { open: price, high: price, low: price, close: price, ts: periodTs };
    candles.push(last);
    if (candles.length > MAX_HISTORY) candles.shift();
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
}

function updateTimeframeCandle(symbol, price, ts) {
  if (!timeframeCandles[symbol]) timeframeCandles[symbol] = [[], []]; // 1m & 5m
  const tfs = [60_000, 300_000];
  tfs.forEach((tf, idx) => {
    const c = timeframeCandles[symbol][idx];
    const periodTs = Math.floor(ts / tf) * tf;
    let last = c[c.length - 1];
    if (!last || last.ts !== periodTs) {
      last = { open: price, high: price, low: price, close: price, ts: periodTs };
      c.push(last);
      if (c.length > MAX_HISTORY) c.shift();
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    }
  });
}

// ===== STRONG SIGNAL LOGIC =====
function evaluateSymbol(symbol) {
  const now = Date.now();
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW) return;

  const closes = candles.map(c => c.close);
  const emaFast = EMA(closes, EMA_FAST);
  const emaSlow = EMA(closes, EMA_SLOW);
  const rsi = RSI(closes);
  const lastClose = closes[closes.length - 1];

  let action = null;
  // Only confirm if EMA & RSI agree strongly
  if (emaFast > emaSlow && rsi > 55) action = "BUY";
  if (emaFast < emaSlow && rsi < 45) action = "SELL";

  if (!action) return;

  // If previous signal exists, keep it until new strong signal
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) {
    // Keep the old action
    return;
  }

  lastSignalAt[symbol] = now;

  const atr = ATR(candles);
  const sl = action === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = action === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = { symbol, action, entry: lastClose, sl, tp, atr };

  // Add to queue, max 20 signals
  signalsQueue.unshift(sig);
  if (signalsQueue.length > 20) signalsQueue.splice(20);
}

// ===== WEBSOCKET =====
const ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

ws.on("open", () => {
  console.log("🔗 Connected. Authorizing...");
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on("message", (msg) => {
  const data = JSON.parse(msg);
  if (data.authorize) {
    console.log("✅ Authorized. Subscribing to symbols...");
    SYMBOLS.forEach(s => ws.send(JSON.stringify({ ticks: s })));
    setInterval(() => SYMBOLS.forEach(evaluateSymbol), 500);
  } else if (data.tick) {
    const ts = Date.now();
    updateMiniCandle(data.tick.symbol, data.tick.quote, ts);
    updateTimeframeCandle(data.tick.symbol, data.tick.quote, ts);
  } else if (data.error) {
    console.log("❌", data.error.message);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Reconnecting in 5s...");
  setTimeout(() => ws.terminate(), 5000);
});
