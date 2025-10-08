#!/usr/bin/env node
/**
 * signal-finder.mjs
 * Stable + Strongly Confirmed Signals + Browser Alert + Highlight
 */

import express from "express";
import WebSocket from "ws";
import readline from "readline";
import chalk from "chalk";

/* ===== CONFIG ===== */
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 200;
const MINI_CANDLE_MS = 10_000;
const COOLDOWN_MS = 60 * 1000;
const MIN_HOLD_MS = 30 * 1000;
const MAX_SIGNALS_STORED = 20;
const CONFIRM_SET = 3;
const CONFIRM_FLIP = 2;
const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

/* ===== STATE ===== */
const miniCandles = {};
const timeframeCandles = {};
const lastSignalAt = {};
const currentSignal = {};
const candidateCounts = {};
const signalsQueue = [];

/* ===== READLINE ===== */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === "list") renderSignals();
  if (cmd === "refresh") signalsQueue.length = 0;
});

/* ===== EXPRESS ===== */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("SMC Signal Finder is running ✅ <br><br>View live signals at <a href='/signals'>/signals</a>");
});

app.get("/signals", (req, res) => {
  let latest = signalsQueue[0]?.ts || 0;

  let tableRows = signalsQueue.map((sig, i) => {
    const highlightClass = sig.ts === latest ? "highlight" : "";
    return `
      <tr class="${highlightClass}">
        <td>${sig.symbol}</td>
        <td style="color:${sig.action === "BUY" ? "green" : "red"}; font-weight:bold;">${sig.action}</td>
        <td>${Number(sig.entry).toFixed(5)}</td>
        <td>${Number(sig.sl).toFixed(5)}</td>
        <td>${Number(sig.tp).toFixed(5)}</td>
        <td>${Number(sig.atr).toFixed(5)}</td>
        <td>${new Date(sig.ts).toLocaleTimeString()}</td>
      </tr>`;
  }).join("");

  if (!tableRows) {
    tableRows = `<tr><td colspan="7" style="text-align:center;">No signals yet ⚡</td></tr>`;
  }

  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta http-equiv="refresh" content="5" />
      <title>SMC Signal Finder - Live Signals</title>
      <style>
        body { font-family: Arial, sans-serif; background:#f8f9fa; padding:20px; }
        h2 { text-align:center; }
        table { border-collapse: collapse; width:100%; background:white; box-shadow:0 0 10px rgba(0,0,0,0.1); }
        th, td { padding:10px; border:1px solid #ddd; text-align:center; }
        th { background:#007bff; color:white; }
        tr.highlight { animation: flash 2s ease-in-out; }
        @keyframes flash {
          0% { background: #fff7c2; }
          50% { background: #fff2a8; }
          100% { background: white; }
        }
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
          ${tableRows}
        </tbody>
      </table>
      <p class="small">Auto-refreshes every 5s. Keeps last ${MAX_SIGNALS_STORED} signals.</p>

      <audio id="alertSound">
        <source src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" type="audio/ogg">
      </audio>
      <script>
        const sound = document.getElementById("alertSound");
        // play alert if highlighted signal exists
        if (document.querySelector(".highlight")) {
          sound.volume = 0.4;
          sound.play().catch(()=>{});
        }
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`🌐 Express server on port ${PORT}`));

/* ===== INDICATORS ===== */
function EMA(arr, period) {
  if (!arr.length) return [];
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function RSI(arr, period = RSI_PERIOD) {
  if (arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
}

function ATR(c) {
  if (c.length < 2) return 0;
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

/* ===== CANDLE MANAGEMENT ===== */
function updateMiniCandle(symbol, price, ts) {
  if (!miniCandles[symbol]) miniCandles[symbol] = [];
  const candles = miniCandles[symbol];
  const periodTs = Math.floor(ts / MINI_CANDLE_MS) * MINI_CANDLE_MS;
  const last = candles[candles.length - 1];
  if (!last || last.ts !== periodTs) {
    if (last) evaluateConfirmations(symbol);
    candles.push({ open: price, high: price, low: price, close: price, ts: periodTs });
    if (candles.length > MAX_HISTORY) candles.shift();
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
}

/* ===== CONFIRMATION LOGIC ===== */
function evaluateConfirmations(symbol) {
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW + 1) return;

  const closed = candles.slice(0, -1);
  const closes = closed.map(c => c.close);
  const emaFast = EMA(closes, EMA_FAST);
  const emaSlow = EMA(closes, EMA_SLOW);
  const rsi = RSI(closes);

  const buy = emaFast.at(-1) > emaSlow.at(-1) && rsi > 55;
  const sell = emaFast.at(-1) < emaSlow.at(-1) && rsi < 45;

  if (!candidateCounts[symbol]) candidateCounts[symbol] = { BUY: 0, SELL: 0 };
  if (buy && !sell) {
    candidateCounts[symbol].BUY++;
    candidateCounts[symbol].SELL = 0;
  } else if (sell && !buy) {
    candidateCounts[symbol].SELL++;
    candidateCounts[symbol].BUY = 0;
  } else {
    candidateCounts[symbol].BUY = candidateCounts[symbol].SELL = 0;
  }

  const now = Date.now();
  const cur = currentSignal[symbol];

  if (!cur) {
    if (candidateCounts[symbol].BUY >= CONFIRM_SET) return createSignal(symbol, "BUY", closed);
    if (candidateCounts[symbol].SELL >= CONFIRM_SET) return createSignal(symbol, "SELL", closed);
  } else {
    if (cur.action === "BUY" && candidateCounts[symbol].SELL >= CONFIRM_FLIP && now - cur.ts >= MIN_HOLD_MS)
      return createSignal(symbol, "SELL", closed);
    if (cur.action === "SELL" && candidateCounts[symbol].BUY >= CONFIRM_FLIP && now - cur.ts >= MIN_HOLD_MS)
      return createSignal(symbol, "BUY", closed);
  }
}

/* ===== SIGNAL CREATION ===== */
function createSignal(symbol, action, closed) {
  const closes = closed.map(c => c.close);
  const lastClose = closes.at(-1);
  const atr = ATR(closed.slice(-20)) || 0.00001;
  const sl = action === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = action === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = { symbol, action, entry: lastClose, sl, tp, atr, ts: Date.now() };
  currentSignal[symbol] = { action, ts: sig.ts };
  lastSignalAt[symbol] = sig.ts;
  signalsQueue.unshift(sig);
  if (signalsQueue.length > MAX_SIGNALS_STORED) signalsQueue.splice(MAX_SIGNALS_STORED);
  renderSignals();
  process.stdout.write("\x07");
}

/* ===== TERMINAL RENDER ===== */
function renderSignals() {
  console.clear();
  console.log(chalk.blue.bold("🚀 SMC Confirmed Volatility Signals (10s Candles)\n"));
  if (!signalsQueue.length) console.log("Waiting for signals...\n");
  signalsQueue.forEach((s, i) => {
    const col = s.action === "BUY" ? chalk.green : chalk.red;
    console.log(`${i + 1}. ${col(s.action)} ${s.symbol}`);
    console.log(`   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(5)} | ${new Date(s.ts).toLocaleTimeString()}\n`);
  });
}

/* ===== WEBSOCKET ===== */
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
  } else if (data.tick) {
    const ts = Date.now();
    updateMiniCandle(data.tick.symbol, data.tick.quote, ts);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Restarting...");
  setTimeout(() => process.exit(1), 5000);
});
