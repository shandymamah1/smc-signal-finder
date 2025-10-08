#!/usr/bin/env node
/**
 * SMC Signal Finder (Stable + Accurate)
 * - No rapid flip signals
 * - ATR, SL, TP restored
 * - Express HTML output
 */

import express from "express";
import WebSocket from "ws";
import chalk from "chalk";

// ===== EXPRESS SERVER =====
const app = express();
const PORT = process.env.PORT || 3000;

// Show HTML
app.get("/", (req, res) => {
  res.send(`
    <h2>✅ SMC Signal Finder Running</h2>
    <p>View live signals: <a href="/signals">/signals</a></p>
  `);
});

// HTML Table view
app.get("/signals", (req, res) => {
  const rows = signalsQueue.map(sig => `
    <tr>
      <td>${sig.symbol}</td>
      <td>${sig.action}</td>
      <td>${sig.entry.toFixed(5)}</td>
      <td>${sig.sl.toFixed(5)}</td>
      <td>${sig.tp.toFixed(5)}</td>
      <td>${sig.atr.toFixed(5)}</td>
      <td>${new Date(sig.time).toLocaleTimeString()}</td>
    </tr>
  `).join("");

  res.send(`
    <h2>📡 Live SMC Signals</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Symbol</th><th>Action</th><th>Entry</th><th>SL</th><th>TP</th><th>ATR</th><th>Time</th></tr>
      ${rows || "<tr><td colspan='7'>No signals yet...</td></tr>"}
    </table>
  `);
});

app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// ===== CONFIG =====
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 200;
const MINI_CANDLE_MS = 10_000;
const COOLDOWN_MS = 120_000; // 2 minutes

const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

// ===== STATE =====
const miniCandles = {};
const lastSignalAt = {};
const lastAction = {};
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

// ===== CANDLE MGMT =====
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

// ===== SIGNAL LOGIC =====
function evaluateSymbol(symbol) {
  const now = Date.now();
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW) return;

  const closes = candles.map(c => c.close);
  const emaFast = EMA(closes, EMA_FAST);
  const emaSlow = EMA(closes, EMA_SLOW);
  const rsi = RSI(closes);
  const atr = ATR(candles.slice(-20));
  const lastClose = closes[closes.length - 1];

  // Trend filter (check last 4 candles)
  const recent = closes.slice(-5);
  const bullish = recent.filter((v, i) => i && v > recent[i - 1]).length >= 3;
  const bearish = recent.filter((v, i) => i && v < recent[i - 1]).length >= 3;

  let action = null;
  if (emaFast > emaSlow && rsi > 55 && bullish) action = "BUY";
  if (emaFast < emaSlow && rsi < 45 && bearish) action = "SELL";

  if (!action) return;

  // Prevent flip-flop (keep same direction until confirmed reverse)
  if (lastAction[symbol] && lastAction[symbol] !== action) {
    // only change if strong reversal
    if (Math.abs(emaFast - emaSlow) < atr * 0.1) return;
  }

  // Cooldown
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

  lastSignalAt[symbol] = now;
  lastAction[symbol] = action;

  const sl = action === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = action === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = {
    symbol,
    action,
    entry: lastClose,
    sl,
    tp,
    atr,
    time: now
  };

  signalsQueue.unshift(sig);
  if (signalsQueue.length > 20) signalsQueue.splice(20);

  console.log(
    (action === "BUY" ? chalk.green("🟢 BUY") : chalk.red("🔴 SELL")),
    symbol,
    "Entry:", lastClose.toFixed(5),
    "SL:", sl.toFixed(5),
    "TP:", tp.toFixed(5)
  );
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
    console.log("✅ Authorized. Subscribing...");
    SYMBOLS.forEach(s => ws.send(JSON.stringify({ ticks: s })));
    setInterval(() => SYMBOLS.forEach(evaluateSymbol), 2000);
  } else if (data.tick) {
    const ts = Date.now();
    updateMiniCandle(data.tick.symbol, data.tick.quote, ts);
  } else if (data.error) {
    console.log("❌", data.error.message);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Retrying...");
  setTimeout(() => ws.terminate(), 5000);
});
