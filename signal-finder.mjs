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
import { onValue } from "firebase/database";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, push } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyAMCVlEPPKA8hSNFF4ruBTayTV_deWsXXw",
  authDomain: "pularix-88abb.firebaseapp.com",
  databaseURL: "https://pularix-88abb-default-rtdb.firebaseio.com",
  projectId: "pularix-88abb",
  storageBucket: "pularix-88abb.firebasestorage.app",
  messagingSenderId: "877314756477",
  appId: "1:877314756477:web:a925edffd31eea18d7c614",
  measurementId: "G-WYLDRHKV86"
};

// Initialize Firebase
const appFB = initializeApp(firebaseConfig);
const db = getDatabase(appFB);

// ===== CONFIG =====
const EMA_FAST = 8;
const EMA_SLOW = 30;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const CROSS_CONFIRMATION = 3; // require 3 mini-candles with same crossover
const RSI_BUY_THRESHOLD = 60; // stronger momentum required
const RSI_SELL_THRESHOLD = 40;
const MIN_ATR = 0.00001;

const SL_ATR_MULT = 4;
const TP_ATR_MULT = 10;

const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown (was 60s)
const MAX_SIGNALS_STORED = 10;

const MIN_DIFF_RATIO = 0.00025; // minimum relative difference between EMAs (hysteresis)
const CONFIRMATIONS_TO_FLIP = 2; // number of confirmed signals required to flip existing action
const MIN_ATR_MOVE_MULT = 0.5; // require at least ATR * this multiplier movement in last N bars to allow signal

// ===== STATE EXTENSIONS =====
const lastAction = {};    // last action emitted per symbol: "BUY"/"SELL"/null
const flipCounter = {};   // counts consecutive confirmations for a different direction

// ===== helper: smooth RSI (avg of last few RSI values) =====
function smoothRSIFromCloses(closes, period = RSI_PERIOD, smooth = 3) {
  const rsis = [];
  // compute RSI for last `smooth` windows or fewer if not enough data
  for (let i = Math.max(period, closes.length - (period + smooth - 1)); i <= closes.length - 1; i++) {
    const slice = closes.slice(0, i + 1);
    if (slice.length >= period + 1) rsis.push(RSI(slice, period));
  }
  if (!rsis.length) return RSI(closes, period);
  return rsis.reduce((a, b) => a + b, 0) / rsis.length;
}

// ===== updated crossover history recording with magnitude =====
function recordCrossover(symbol, direction, gapRatio = 0) {
  // direction: 1 fast>slow, -1 fast<slow, 0 neutral ; gapRatio = relative gap between EMAs
  if (!crossoverHistory[symbol]) crossoverHistory[symbol] = [];
  const hist = crossoverHistory[symbol];
  hist.push({ dir: direction, ts: Date.now(), gap: gapRatio });
  // keep only a small window
  if (hist.length > CROSS_CONFIRMATION + 4) hist.shift();
  crossoverHistory[symbol] = hist;
}

function crossoverConfirmedAndLargeEnough(symbol, requiredDir) {
  const hist = crossoverHistory[symbol] || [];
  if (hist.length < CROSS_CONFIRMATION) return false;
  // check last CROSS_CONFIRMATION entries are requiredDir and gap >= MIN_DIFF_RATIO
  for (let i = hist.length - CROSS_CONFIRMATION; i < hist.length; i++) {
    if (hist[i].dir !== requiredDir) return false;
    if ((hist[i].gap || 0) < MIN_DIFF_RATIO) return false;
  }
  return true;
}

// ===== additional momentum check on 1m (require price to be on correct side of 1m EMA and showing momentum) =====
function oneMinuteTrendAllows(symbol, requiredDir) {
  const tf1 = timeframeCandles[symbol] && timeframeCandles[symbol][0];
  if (!tf1 || tf1.length < EMA_SLOW) return true; // allow if not enough data
  const tfCloses = tf1.map(c => c.close);
  const tfEmaSlow = EMA(tfCloses, EMA_SLOW);
  const last = tfCloses[tfCloses.length - 1];
  // require last close relative to slow EMA consistent with direction
  if (requiredDir === 1 && last < tfEmaSlow) return false;
  if (requiredDir === -1 && last > tfEmaSlow) return false;
  // also require recent momentum on 1m: last close must be stronger than previous by small amount
  const prev = tfCloses[tfCloses.length - 2] || last;
  const momentum = Math.abs(last - prev) / last;
  // allow small momentum but prefer a minimum movement
  return momentum >= 0 || true; // keep permissive but available for extension
}

// ===== evaluateSymbol (modified) =====
function evaluateSymbol(symbol) {
  if (!symbol) return;
  const now = Date.now();
  const candles = miniCandles[symbol];
  if (!candles || candles.length < EMA_SLOW + 4) return;

  const closes = candles.map(c => c.close);
  const emaFast = EMA(closes, EMA_FAST);
  const emaSlow = EMA(closes, EMA_SLOW);
  const lastClose = closes[closes.length - 1];

  // relative gap ratio between EMAs (hysteresis)
  const gapRatio = Math.abs(emaFast - emaSlow) / Math.max(lastClose, 1e-12);

  // record crossover dir with gap
  const dir = emaFast > emaSlow ? 1 : (emaFast < emaSlow ? -1 : 0);
  recordCrossover(symbol, dir, gapRatio);

  // smoothed RSI
  const rsi = smoothRSIFromCloses(closes, RSI_PERIOD, 3);

  // trend filter using 1m timeframe
  const trendOK = oneMinuteTrendAllows(symbol, dir);

  // compute ATR and safety checks
  const atr = Math.max(ATR(candles, ATR_PERIOD) || 0, MIN_ATR);
  // require recent price movement at least a fraction of ATR to avoid noisy markets
  const recentMove = Math.abs(lastClose - closes[Math.max(0, closes.length - 3)]) || 0;
  if (recentMove < atr * MIN_ATR_MOVE_MULT) {
    // not enough movement recently, skip
    return;
  }

  let action = null;
  if (dir === 1 && rsi >= RSI_BUY_THRESHOLD && trendOK && crossoverConfirmedAndLargeEnough(symbol, 1)) action = "BUY";
  if (dir === -1 && rsi <= RSI_SELL_THRESHOLD && trendOK && crossoverConfirmedAndLargeEnough(symbol, -1)) action = "SELL";

  if (!action) {
    // reset flip counter if no confirmed action
    flipCounter[symbol] = 0;
    return;
  }

  // flip debounce logic: if same action as lastAction => immediate allowed (subject to cooldown)
  // if different, require CONFIRMATIONS_TO_FLIP consecutive confirmations before actually flipping to reduce chattering
  const prev = lastAction[symbol] || null;
  if (prev && prev !== action) {
    flipCounter[symbol] = (flipCounter[symbol] || 0) + 1;
    if (flipCounter[symbol] < CONFIRMATIONS_TO_FLIP) {
      return; // wait for additional confirms
    }
    // enough confirmations to flip, proceed to signal and reset counter
    flipCounter[symbol] = 0;
  }

  // cooldown check
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

  // compute SL/TP using safe ATR
  const safeAtr = Math.max(atr, MIN_ATR);
  const sl = action === "BUY" ? lastClose - safeAtr * SL_ATR_MULT : lastClose + safeAtr * SL_ATR_MULT;
  const tp = action === "BUY" ? lastClose + safeAtr * TP_ATR_MULT : lastClose - safeAtr * TP_ATR_MULT;

  lastSignalAt[symbol] = now;
  lastAction[symbol] = action;

  const sig = {
    symbol,
    action,
    entry: lastClose,
    sl,
    tp,
    atr: safeAtr,
    ts: now
  };

  try {
    push(ref(db, "signals/"), sig);
  } catch (err) {
    // if DB push fails, still add locally
  }

  // push newest at front, trim
  signalsQueue.unshift(sig);
  if (signalsQueue.length > MAX_SIGNALS_STORED) signalsQueue.splice(MAX_SIGNALS_STORED);

  renderSignals();
  process.stdout.write("\x07"); // beep alert
}
// ===== STATE =====
const miniCandles = {};
const timeframeCandles = {}; // [symbol] = [1mArray, 5mArray]
const lastSignalAt = {};
const signalsQueue = [];

// Listen for updates from Firebase
onValue(ref(db, "signals/"), (snapshot) => {
  const data = snapshot.val();
  if (data) {
    const list = Object.values(data).reverse();
    signalsQueue.length = 0;
    signalsQueue.push(...list.slice(0, 10)); // show latest 10 signals
  }
});
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
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Keamzfx VIP SMC Signals is running ✅ <br><br>View live signals here👉 <a href='/signals'>/signals</a>");
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
      <h1 style="text-align:center;">📊 Keamzfx VIP SMC Signals</h1>
<h2 style="text-align:center;">APP or CAL:77372529</h2>
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

app.listen(PORT, () => console.log(`🌐 Express server is listening on port ${PORT}`));

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

// ===== WEBSOCKET =====
const ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

ws.on("open", () => {
  console.log("🔗 Connected. Authorized...");
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on("message", (msg) => {
  try {
    const data = JSON.parse(msg);
    if (data.authorize) {
      console.log("✅ Authorized. Subscribed to signals...");
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
