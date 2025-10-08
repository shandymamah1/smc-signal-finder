#!/usr/bin/env node
/**
 * Full, merged signal-finder.mjs
 * - Restores ATR, SL, TP, beep and console rendering
 * - Evaluates signals only on mini-candle close (prevents flip)
 * - Per-symbol cooldown
 * - Pretty HTML /signals page (auto-refresh)
 * - Readline terminal commands kept
 */

import express from "express";
import WebSocket from "ws";
import readline from "readline";
import chalk from "chalk";

/* ===== CONFIG ===== */
const API_TOKEN = "MrUiWBFYmsfrsjC"; // your token in code (keep safe)
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 200;
const MINI_CANDLE_MS = 10_000; // 10s mini-candles (original)
const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown per symbol
const MAX_SIGNALS_STORED = 100;

const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

/* ===== STATE ===== */
const miniCandles = {};         // per-symbol mini candles (10s)
const timeframeCandles = {};    // optional 1m & 5m (still kept)
const lastSignalAt = {};        // per-symbol cooldown timestamp
const signalsQueue = [];        // store recent signals (keeps history)

/* ===== READLINE (terminal) ===== */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === "list") renderSignals();
  if (cmd === "refresh") signalsQueue.length = 0;
});

/* ===== EXPRESS SERVER (root + pretty /signals) ===== */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h2>✅ SMC Signal Finder is running</h2>
    <p>View live signals below:</p>
    <a href="/signals" style="font-size: 18px; text-decoration: none;">➡️ Open /signals</a>
  `);
});

// Pretty HTML table for signals (auto-refresh every 5s)
app.get("/signals", (req, res) => {
  const now = Date.now();
  let rows = signalsQueue.map(sig => {
    const recent = now - sig.ts < 30_000; // highlight if within 30s
    const bg = recent ? "#eaffea" : "white";
    const actionColor = sig.action === "BUY" ? "green" : "red";
    return `
      <tr style="background:${bg}">
        <td>${sig.symbol}</td>
        <td style="color:${actionColor}; font-weight:bold;">${sig.action}</td>
        <td>${Number(sig.entry).toFixed(5)}</td>
        <td>${Number(sig.sl).toFixed(5)}</td>
        <td>${Number(sig.tp).toFixed(5)}</td>
        <td>${Number(sig.atr).toFixed(5)}</td>
        <td>${new Date(sig.ts).toLocaleTimeString()}</td>
      </tr>
    `;
  }).join("");

  if (!rows) rows = `<tr><td colspan="7" style="text-align:center;">No signals yet ⚡</td></tr>`;

  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta http-equiv="refresh" content="5" />
      <title>SMC Signal Finder - Live Signals</title>
      <style>
        body { font-family: Arial, sans-serif; background:#f3f4f6; padding:18px; }
        h2 { text-align:center; }
        table { width:100%; max-width:980px; margin:12px auto; border-collapse:collapse; background:white; box-shadow:0 6px 18px rgba(0,0,0,0.08); }
        th, td { padding:10px 12px; border:1px solid #e6e6e6; text-align:center; }
        th { background:#0d6efd; color:white; }
        tr.noise { background:#fafafa; }
        .small { font-size:12px; color:#666; text-align:center; margin-top:8px; }
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
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p class="small">Auto-refresh every 5s. Recent signals (last 30s) are highlighted.</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

/* ===== UTILITIES (EMA, RSI, ATR) ===== */
function EMA(arr, period) {
  if (!arr || arr.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function RSI(arr, period = RSI_PERIOD) {
  if (!arr || arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
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

/* ===== CANDLE MANAGEMENT (mini candles + timeframe candles) ===== */
function updateMiniCandle(symbol, price, ts) {
  if (!miniCandles[symbol]) miniCandles[symbol] = [];
  const candles = miniCandles[symbol];
  const periodTs = Math.floor(ts / MINI_CANDLE_MS) * MINI_CANDLE_MS;
  const last = candles[candles.length - 1];

  // New candle period started -> previous candle just closed
  if (!last || last.ts !== periodTs) {
    // Evaluate using the existing candles (the last is the just-closed candle)
    // Only evaluate if we have enough history (evaluateSymbol will check)
    if (last) {
      evaluateSymbol(symbol); // evaluate on candle close
    }

    // create new candle for current period
    const newCandle = { open: price, high: price, low: price, close: price, ts: periodTs };
    candles.push(newCandle);
    if (candles.length > MAX_HISTORY) candles.shift();
    miniCandles[symbol] = candles;
  } else {
    // update existing current candle
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
      timeframeCandles[symbol][idx] = c;
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    }
  });
}

/* ===== SIGNAL LOGIC ===== */
function evaluateSymbol(symbol) {
  const now = Date.now();
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW) return; // not enough history

  // Use all *closed* mini-candles (we call evaluate before pushing new candle)
  const closes = candles.map(c => c.close);
  const emaFastArr = EMA(closes, EMA_FAST);
  const emaSlowArr = EMA(closes, EMA_SLOW);
  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const rsi = RSI(closes);
  const lastClose = closes[closes.length - 1];

  let action = null;
  if (emaFast > emaSlow && rsi > 50) action = "BUY";
  if (emaFast < emaSlow && rsi < 50) action = "SELL";
  if (!action) return;

  // cooldown per symbol — prevents immediate flips
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

  lastSignalAt[symbol] = now;

  // compute ATR, SL, TP
  const atr = ATR(candles);
  const sl = action === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = action === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = {
    symbol,
    action,
    entry: lastClose,
    sl,
    tp,
    atr,
    ts: now
  };

  // add to queue and keep history
  signalsQueue.unshift(sig);
  if (signalsQueue.length > MAX_SIGNALS_STORED) signalsQueue.pop();

  // terminal rendering + beep
  renderSignals();
  try { process.stdout.write("\x07"); } catch (e) { /* ignore if not supported */ }
}

/* ===== RENDER TO CONSOLE ===== */
function renderSignals() {
  console.clear();
  console.log(chalk.blue.bold("🚀 SMC Volatility Signals (Mini-Candles 10s)\n"));
  if (!signalsQueue.length) console.log("Waiting for signals...\n");
  signalsQueue.slice(0, 20).forEach((s, i) => {
    const color = s.action === "BUY" ? chalk.green : chalk.red;
    console.log(`${i + 1}. ${color(s.action)} ${s.symbol}`);
    console.log(`   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(5)} | ${new Date(s.ts).toLocaleTimeString()}\n`);
  });
  console.log(chalk.yellow("Commands (terminal): refresh | list"));
}

/* ===== WEBSOCKET (BinaryWS) ===== */
const ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

ws.on("open", () => {
  console.log("🔗 Connected. Authorizing...");
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on("message", (msg) => {
  try {
    const data = JSON.parse(msg);
    if (data.authorize) {
      console.log("✅ Authorized. Subscribing to symbols...");
      SYMBOLS.forEach(s => ws.send(JSON.stringify({ ticks: s })));
    } else if (data.tick) {
      const ts = Date.now();
      const symbol = data.tick.symbol;
      const price = data.tick.quote;
      updateMiniCandle(symbol, price, ts);
      updateTimeframeCandle(symbol, price, ts);
    } else if (data.error) {
      console.log("❌", data.error.message || data.error);
    }
  } catch (err) {
    console.log("⚠️ ws parse error:", err.message);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Will attempt reconnect in 5s...");
  setTimeout(() => {
    // small reconnect attempt - create a new WebSocket object by reloading process
    // simplest approach: exit so a process manager or Render will restart (Render restarts automatically)
    try { process.exit(1); } catch (e) { /* ignore */ }
  }, 5000);
});
