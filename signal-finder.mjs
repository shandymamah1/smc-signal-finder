#!/usr/bin/env node
/**
 * signal-finder.mjs
 * SUPER ULTRA STRONG ACCURACY MODE
 *
 * - 10s mini-candles (original)
 * - EMAs: 20 vs 50 (strong trend)
 * - RSI thresholds: 60/40
 * - Confirmation to set: 5 consecutive candles
 * - Confirmation to flip: 5 consecutive candles (and min hold)
 * - Min hold before flip: 60 seconds
 * - ATR strength filter: ATR must be > (avgATR * 0.6)
 * - Entry requires close beyond both EMAs (post-candle close)
 * - SL = 3 * ATR, TP = 9 * ATR (1:3 RR)
 * - Keeps terminal beep, browser sound, highlight, and pretty /signals page
 * - Keeps history up to 20 signals
 */

import express from "express";
import WebSocket from "ws";
import readline from "readline";
import chalk from "chalk";

/* ===== CONFIG ===== */
const API_TOKEN = "MrUiWBFYmsfrsjC"; // keep safe, or move to env var
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 500;               // candle history length (large enough)
const MINI_CANDLE_MS = 10_000;         // 10s mini-candles
const MAX_SIGNALS_STORED = 20;         // history for UI
const PAGE_REFRESH = 5;                // seconds for HTML meta refresh

// Strong strategy parameters
const EMA_FAST_PERIOD = 20;
const EMA_SLOW_PERIOD = 50;
const RSI_PERIOD = 14;
const CONFIRM_SET = 5;                 // require 5 consecutive confirmations to set
const CONFIRM_FLIP = 5;                // require 5 consecutive confirmations to flip
const MIN_HOLD_MS = 60 * 1000;         // 60 seconds minimum hold before flip
const ATR_LOOKBACK = 20;               // ATR lookback
const ATR_STRENGTH_FACTOR = 0.6;       // require ATR > avgATR * ATR_STRENGTH_FACTOR
const SL_MULT = 3;                     // stop loss multiple of ATR
const TP_MULT = 9;                     // take profit multiple of ATR

/* ===== STATE ===== */
const miniCandles = {};      // { symbol: [ {open,high,low,close,ts}, ... ] }
const timeframeCandles = {}; // (not used in logic but kept)
const candidateCounts = {};  // { symbol: { BUY: n, SELL: n } }
const currentSignal = {};    // { symbol: { action: 'BUY'|'SELL', ts } }
const lastSignalAt = {};     // timestamp of last confirmed signal per symbol
const signalsQueue = [];     // confirmed signals history newest first

/* ===== READLINE (terminal) ===== */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === "list") renderSignals();
  if (cmd === "refresh") signalsQueue.length = 0;
});

/* ===== EXPRESS UI ===== */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h2>✅ SMC Signal Finder (Super Ultra Strong Mode)</h2>
    <p>View live signals: <a href="/signals">/signals</a></p>
    <p style="color:#666; font-size:13px;">EMA20/50, RSI60/40, ATR filter, 5-candle confirmation, TP=9×ATR SL=3×ATR</p>
  `);
});

app.get("/signals", (req, res) => {
  const latestTs = signalsQueue[0]?.ts || 0;
  let rows = signalsQueue.map(s => {
    const isLatest = s.ts === latestTs;
    const cls = isLatest ? "highlight" : "";
    return `
      <tr class="${cls}">
        <td>${s.symbol}</td>
        <td style="color:${s.action === 'BUY' ? 'green' : 'red'}; font-weight:bold">${s.action}</td>
        <td>${Number(s.entry).toFixed(5)}</td>
        <td>${Number(s.sl).toFixed(5)}</td>
        <td>${Number(s.tp).toFixed(5)}</td>
        <td>${Number(s.atr).toFixed(6)}</td>
        <td>${new Date(s.ts).toLocaleTimeString()}</td>
      </tr>
    `;
  }).join("");

  if (!rows) rows = `<tr><td colspan="7" style="text-align:center;">No strong signals yet ⚡</td></tr>`;

  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <meta http-equiv="refresh" content="${PAGE_REFRESH}">
      <title>SMC Signal Finder - Live Signals</title>
      <style>
        body { font-family: Arial, sans-serif; background:#f8f9fa; padding:20px; color:#222; }
        h2 { text-align:center; }
        table { border-collapse: collapse; width:100%; max-width:1000px; margin:12px auto; background:white; box-shadow:0 0 8px rgba(0,0,0,0.08); }
        th, td { padding:10px; border:1px solid #eee; text-align:center; }
        th { background:#007bff; color:#fff; }
        tr.highlight { animation: flash 2.2s ease-in-out; }
        @keyframes flash {
          0% { background: #fff7c2; }
          50% { background: #fff2a8; }
          100% { background: white; }
        }
        .small { font-size:12px; color:#666; text-align:center; margin-top:10px; }
      </style>
    </head>
    <body>
      <h2>📊 Live SMC Signals — SUPER ACCURACY</h2>
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Action</th><th>Entry</th><th>Stop Loss</th><th>Take Profit</th><th>ATR</th><th>When</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p class="small">Auto-refresh every ${PAGE_REFRESH}s. Strong filter: EMA20/50, RSI60/40, ATR strength, 5 confirmation candles.</p>

      <audio id="alert" preload="auto">
        <source src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" type="audio/ogg">
      </audio>

      <script>
        // play sound if there's any highlighted row (newest)
        (function(){
          const el = document.querySelector('.highlight');
          if (el) {
            const a = document.getElementById('alert');
            a.volume = 0.45;
            a.play().catch(()=>{ /* autoplay may be blocked */ });
          }
        })();
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(chalk.green(`🌐 Express server listening on port ${PORT}`));
});

/* ===== INDICATORS ===== */
function calcEMA(arr, period) {
  if (!arr || arr.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcRSI(arr, period = RSI_PERIOD) {
  if (!arr || arr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles) {
  if (!candles || candles.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / (candles.length - 1);
}

/* ===== CANDLE MANAGEMENT (10s mini-candles) ===== */
function updateMiniCandle(symbol, price, ts) {
  if (!miniCandles[symbol]) miniCandles[symbol] = [];
  const list = miniCandles[symbol];
  const period = Math.floor(ts / MINI_CANDLE_MS) * MINI_CANDLE_MS;
  const last = list[list.length - 1];

  if (!last || last.ts !== period) {
    // closed previous candle -> evaluate confirmations on closed set
    if (last) evaluateConfirmations(symbol);
    // push new candle
    list.push({ open: price, high: price, low: price, close: price, ts: period });
    if (list.length > MAX_HISTORY) list.shift();
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
}

/* keep timeframe candles for compatibility (not used by strategy) */
function updateTimeframeCandle(symbol, price, ts) {
  if (!timeframeCandles[symbol]) timeframeCandles[symbol] = [[], []];
  const tfs = [60_000, 300_000];
  tfs.forEach((tf, idx) => {
    const arr = timeframeCandles[symbol][idx];
    const period = Math.floor(ts / tf) * tf;
    let last = arr[arr.length - 1];
    if (!last || last.ts !== period) {
      arr.push({ open: price, high: price, low: price, close: price, ts: period });
      if (arr.length > MAX_HISTORY) arr.shift();
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    }
  });
}

/* ===== CONFIRMATION & SIGNAL LOGIC (strong) ===== */
function evaluateConfirmations(symbol) {
  const list = miniCandles[symbol];
  if (!list || list.length < EMA_SLOW_PERIOD + 2) return; // need enough candles

  // Use only closed candles (exclude current active candle)
  const closed = list.slice(0, -1);
  if (closed.length < EMA_SLOW_PERIOD + 2) return;

  const closes = closed.map(c => c.close);

  // EMAs / RSI on closed candles
  const emaFastArr = calcEMA(closes, EMA_FAST_PERIOD);
  const emaSlowArr = calcEMA(closes, EMA_SLOW_PERIOD);
  const rsi = calcRSI(closes, RSI_PERIOD);

  // ATR calculations for strength filter
  const atr = calcATR(closed.slice(-ATR_LOOKBACK));
  // compute avg ATR across longer history (if available)
  let avgATR = atr;
  if (closed.length >= ATR_LOOKBACK * 3) {
    const atrs = [];
    for (let i = ATR_LOOKBACK; i < closed.length; i += ATR_LOOKBACK) {
      atrs.push(calcATR(closed.slice(i - ATR_LOOKBACK, i)));
    }
    if (atrs.length) avgATR = atrs.reduce((a,b) => a+b, 0) / atrs.length;
  }

  // ATR strength check: require ATR > avgATR * factor (if avgATR exists)
  const atrOk = avgATR > 0 ? (atr > avgATR * ATR_STRENGTH_FACTOR) : true;

  // Determine condition on the last closed candle
  const idx = emaFastArr.length - 1;
  const fast = emaFastArr[idx];
  const slow = emaSlowArr[idx];
  const lastClose = closes[closes.length - 1];

  // Need close to be beyond both EMAs for entry (clear breakout)
  const buyCloseBeyondEMAs = lastClose > fast && lastClose > slow;
  const sellCloseBeyondEMAs = lastClose < fast && lastClose < slow;

  // RSI strict thresholds
  const buyRsiOk = rsi >= 60;
  const sellRsiOk = rsi <= 40;

  const buyConfirmedNow = fast > slow && buyRsiOk && buyCloseBeyondEMAs && atrOk;
  const sellConfirmedNow = fast < slow && sellRsiOk && sellCloseBeyondEMAs && atrOk;

  // init candidate counters
  if (!candidateCounts[symbol]) candidateCounts[symbol] = { BUY: 0, SELL: 0 };

  if (buyConfirmedNow && !sellConfirmedNow) {
    candidateCounts[symbol].BUY += 1;
    candidateCounts[symbol].SELL = 0;
  } else if (sellConfirmedNow && !buyConfirmedNow) {
    candidateCounts[symbol].SELL += 1;
    candidateCounts[symbol].BUY = 0;
  } else {
    // ambiguous => reset counters (avoid noise)
    candidateCounts[symbol].BUY = 0;
    candidateCounts[symbol].SELL = 0;
  }

  // evaluate candidateCounts against thresholds
  const now = Date.now();
  const cur = currentSignal[symbol]; // existing confirmed signal

  // If no current signal, set only after CONFIRM_SET consecutive confirmations
  if (!cur) {
    if (candidateCounts[symbol].BUY >= CONFIRM_SET) {
      createConfirmedSignal(symbol, "BUY", closed, atr);
      candidateCounts[symbol].BUY = 0;
    } else if (candidateCounts[symbol].SELL >= CONFIRM_SET) {
      createConfirmedSignal(symbol, "SELL", closed, atr);
      candidateCounts[symbol].SELL = 0;
    }
    return;
  }

  // If there's current signal of same direction, do nothing (keep)
  if (cur.action === "BUY" && candidateCounts[symbol].BUY > 0) return;
  if (cur.action === "SELL" && candidateCounts[symbol].SELL > 0) return;

  // If opposite direction accumulated enough confirmations AND previous held long enough -> flip
  if (cur.action === "BUY" && candidateCounts[symbol].SELL >= CONFIRM_FLIP && (now - cur.ts) >= MIN_HOLD_MS) {
    createConfirmedSignal(symbol, "SELL", closed, atr);
    candidateCounts[symbol].SELL = 0;
    candidateCounts[symbol].BUY = 0;
    return;
  }
  if (cur.action === "SELL" && candidateCounts[symbol].BUY >= CONFIRM_FLIP && (now - cur.ts) >= MIN_HOLD_MS) {
    createConfirmedSignal(symbol, "BUY", closed, atr);
    candidateCounts[symbol].BUY = 0;
    candidateCounts[symbol].SELL = 0;
    return;
  }

  // otherwise wait for further confirmations
}

/* create confirmed signal, record history, terminal beep/visual */
function createConfirmedSignal(symbol, action, closedCandles, atrValue) {
  const closes = closedCandles.map(c => c.close);
  const entry = closes[closes.length - 1];
  const atr = atrValue || calcATR(closedCandles.slice(-ATR_LOOKBACK)) || 0.000001;
  const sl = action === "BUY" ? entry - SL_MULT * atr : entry + SL_MULT * atr;
  const tp = action === "BUY" ? entry + TP_MULT * atr : entry - TP_MULT * atr;

  const sig = { symbol, action, entry, sl, tp, atr, ts: Date.now() };

  // update currentSignal and lastSignalAt
  currentSignal[symbol] = { action, ts: sig.ts };
  lastSignalAt[symbol] = sig.ts;

  // push to history (newest first)
  signalsQueue.unshift(sig);
  if (signalsQueue.length > MAX_SIGNALS_STORED) signalsQueue.splice(MAX_SIGNALS_STORED);

  // terminal render & beep
  renderSignals();
  try { process.stdout.write("\x07"); } catch (e) { /* ignore on unsupported consoles */ }
}

/* ===== render to terminal ===== */
function renderSignals() {
  console.clear();
  console.log(chalk.cyan.bold("🚀 SMC Super-Ultra Signals (EMA20/50, RSI60/40, ATR filter)\n"));
  if (!signalsQueue.length) console.log("Waiting for strong signals...\n");
  signalsQueue.slice(0, MAX_SIGNALS_STORED).forEach((s, i) => {
    const col = s.action === "BUY" ? chalk.green : chalk.red;
    console.log(`${i + 1}. ${col(s.action)} ${s.symbol}`);
    console.log(`   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(6)} | ${new Date(s.ts).toLocaleTimeString()}\n`);
  });
  console.log(chalk.yellow("Terminal commands: 'list' to show | 'refresh' to clear history"));
}

/* ===== WEBSOCKET (BinaryWS ticks) ===== */
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
      console.log("❌ WebSocket error:", data.error.message || data.error);
    }
  } catch (e) {
    console.log("⚠️ ws parse error:", e.message);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Restarting in 5s...");
  setTimeout(() => { try { process.exit(1); } catch(e){} }, 5000);
});

/* ===== Notes =====
- This version is extremely conservative: expect fewer trades but far stronger trend alignment.
- No change to UI layout (pretty table), browser sound + highlight present.
- You can tweak CONFIRM_SET / CONFIRM_FLIP / MIN_HOLD_MS / ATR_STRENGTH_FACTOR to be more/less aggressive.
- No strategy is 100% accurate — this raises probability substantially, but you must still manage risk and size positions.
*/
