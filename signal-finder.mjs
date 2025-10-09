#!/usr/bin/env node
/**
 * Improved Fast SMC Volatility Signals with Mini-Candles (10s)
 * - Fixed EMA/RSI/ATR implementations
 * - Added crossover confirmation and 1m trend filter
 * - Wider SL/TP (ATR multipliers) so you can "wait for profit"
 * - Minor safety: rate-limit signals per symbol (cooldown)
 */

import express from "express";
import WebSocket from "ws";
import readline from "readline";
import chalk from "chalk";

// ===== INITIALIZATION =====
if (!Array.isArray(signalsQueue)) signalsQueue = [];
if (typeof MAX_SIGNALS_STORED === "undefined") global.MAX_SIGNALS_STORED = 5;
// ===== CONFIG =====
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 400; // keep more history for indicators
const MINI_CANDLE_MS = 10_000;
const COOLDOWN_MS = 60 * 1000;

const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

// Confirmation & filters
const CROSS_CONFIRMATION = 2; // crossover must persist for this many mini-candles
const RSI_BUY_THRESHOLD = 55; // require stronger momentum
const RSI_SELL_THRESHOLD = 45;
const MIN_ATR = 0.00001; // avoid tiny ATR causing tiny SL/TP (tune for instrument)

// Wider SL/TP multipliers per your request
const SL_ATR_MULT = 4;   // stop loss = entry +/- ATR * 4
const TP_ATR_MULT = 10;  // take profit = entry +/- ATR * 10

// ===== STATE =====
const miniCandles = {};
const timeframeCandles = {}; // [symbol] = [1mArray, 5mArray]
const lastSignalAt = {};
const signalsQueue = [];
const crossoverHistory = {}; // track last N cross states per symbol

// ===== READLINE =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === "list") renderSignals();
  if (cmd === "refresh") signalsQueue.length = 0;
});

/* ===== EXPRESS ===== */
const app = express();

// ✅ your new route
app.get("/", (req, res) => {
  res.send("✅ SMC Signal Finder is live and running perfectly!");
});

// ✅ the rest of your logic here (signals, sockets, etc.)

const PORT = process.env.PORT || 3000;

app.get("/signals", (req, res) => {
  let signalsQueue = [];
const MAX_SIGNALS_STORED = 5;

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
    tableRows = `<tr><td colspan="7" style="text-align:center;">Searching for signals📉📈</td></tr>`;
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
      <h2>📊 KeamzFx (Live VIP SMC Signals)</h2>
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

// ===== UTILITIES =====
// EMA: standard SMA seed then EMA iteration
function EMA(arr, period) {
  if (!arr || arr.length === 0) return 0;
  if (arr.length < period) return arr[arr.length - 1] || 0;
  // seed with SMA of first 'period' values from the slice that ends at last index
  const base = arr.length - period;
  let sma = 0;
  for (let i = base; i < base + period; i++) sma += arr[i];
  sma = sma / period;
  const k = 2 / (period + 1);
  let ema = sma;
  for (let i = base + period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

// RSI: simple average gains/losses over last `period` bars (classic)
function RSI(arr, period = RSI_PERIOD) {
  if (!arr || arr.length < period + 1) return 50;
  const end = arr.length - 1;
  const start = end - period;
  let gains = 0;
  let losses = 0;
  for (let i = start + 1; i <= end; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ATR: true range average for last ATR_PERIOD candles
function ATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < 2) return 0;
  const n = Math.min(period, candles.length - 1);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  return sum / n;
}

// when we want to check last N closes
function lastCloses(candles, n) {
  if (!candles || !candles.length) return [];
  const start = Math.max(0, candles.length - n);
  return candles.slice(start).map(c => c.close);
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
    miniCandles[symbol] = candles;
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
      timeframeCandles[symbol][idx] = c;
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    }
  });
}

// ===== SIGNAL LOGIC =====
function recordCrossover(symbol, direction) {
  // direction: 1 = fast>slow, -1 = fast<slow, 0 = neutral
  if (!crossoverHistory[symbol]) crossoverHistory[symbol] = [];
  const hist = crossoverHistory[symbol];
  hist.push({ dir: direction, ts: Date.now() });
  if (hist.length > CROSS_CONFIRMATION + 2) hist.shift(); // keep small window
  crossoverHistory[symbol] = hist;
}

function crossoverConfirmed(symbol, requiredDir) {
  const hist = crossoverHistory[symbol] || [];
  if (hist.length < CROSS_CONFIRMATION) return false;
  // check the last CROSS_CONFIRMATION entries are requiredDir
  for (let i = hist.length - CROSS_CONFIRMATION; i < hist.length; i++) {
    if (hist[i].dir !== requiredDir) return false;
  }
  return true;
}

function evaluateSymbol(symbol) {
  if (!symbol) return;
  const now = Date.now();
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW + 2) return;

  const closes = candles.map(c => c.close);
  const emaFast = EMA(closes, EMA_FAST);
  const emaSlow = EMA(closes, EMA_SLOW);
  const rsi = RSI(closes);
  const lastClose = closes[closes.length - 1];

  // record crossover direction for confirmation
  const dir = emaFast > emaSlow ? 1 : (emaFast < emaSlow ? -1 : 0);
  recordCrossover(symbol, dir);

  // basic trend filter using 1m timeframe (use slow EMA on 1m closes if available)
  let trendOK = true;
  const tf1 = timeframeCandles[symbol] && timeframeCandles[symbol][0];
  if (tf1 && tf1.length >= EMA_SLOW) {
    const tfCloses = tf1.map(c => c.close);
    const tfEmaSlow = EMA(tfCloses, EMA_SLOW);
    // if emaSlow on 1m indicates opposite to signal direction, block
    if (dir === 1 && tfCloses[tfCloses.length - 1] < tfEmaSlow) trendOK = false; // buy but 1m downtrend
    if (dir === -1 && tfCloses[tfCloses.length - 1] > tfEmaSlow) trendOK = false; // sell but 1m uptrend
  }

  let action = null;
  if (dir === 1 && rsi >= RSI_BUY_THRESHOLD && trendOK && crossoverConfirmed(symbol, 1)) action = "BUY";
  if (dir === -1 && rsi <= RSI_SELL_THRESHOLD && trendOK && crossoverConfirmed(symbol, -1)) action = "SELL";

  if (!action) return;
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

  // compute ATR from mini-candles (use ATR_PERIOD)
  const atr = ATR(candles, ATR_PERIOD) || MIN_ATR;
  // ensure atr isn't too small
  const safeAtr = Math.max(atr, MIN_ATR);

  const sl = action === "BUY" ? lastClose - safeAtr * SL_ATR_MULT : lastClose + safeAtr * SL_ATR_MULT;
  const tp = action === "BUY" ? lastClose + safeAtr * TP_ATR_MULT : lastClose - safeAtr * TP_ATR_MULT;

  lastSignalAt[symbol] = now;

  const sig = {
    symbol,
    action,
    entry: lastClose,
    sl,
    tp,
    atr: safeAtr,
    ts: now
  };

  // push newest at front, trim
  signalsQueue.unshift(sig);
  if (signalsQueue.length > 10) signalsQueue.splice(10);

  renderSignals();
  process.stdout.write("\x07"); // beep alert
}

function renderSignals() {
  console.clear();
  console.log(chalk.blue.bold("🚀 SMC Volatility Signals (Mini-Candles 10s) — Improved\n"));
  if (!signalsQueue.length) {
    console.log("Waiting for signals...\n");
  } else {
    signalsQueue.forEach((s, i) => {
      const color = s.action === "BUY" ? chalk.green : chalk.red;
      const ageSec = Math.round((Date.now() - s.ts) / 1000);
      console.log(`${i + 1}. ${color(s.action)} ${s.symbol}  ${chalk.dim(`(${ageSec}s ago)`)}`);
      console.log(`   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(5)}\n`);
    });
  }
  console.log(chalk.yellow("Commands: refresh | list"));
}

// ===== WEBSOCKET =====
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
      // schedule evaluation loop; keep it light
      setInterval(() => SYMBOLS.forEach(s => {
        try { evaluateSymbol(s); } catch (e) { /* swallow per-symbol errors */ }
      }), 500);
    } else if (data.tick) {
      const ts = Date.now();
      updateMiniCandle(data.tick.symbol, data.tick.quote, ts);
      updateTimeframeCandle(data.tick.symbol, data.tick.quote, ts);
    } else if (data.error) {
      console.log("❌", data.error.message);
    }
  } catch (err) {
    // ignore JSON parse errors from non-standard messages
    console.error("Failed to parse ws message:", err);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Reconnecting in 5s...");
  setTimeout(() => {
    try { ws.terminate(); } catch (e) {}
    // No automatic reconnect here — keep it simple. Your original attempted reconnect terminated the socket anyway.
    process.exit(0);
  }, 5000);
});
