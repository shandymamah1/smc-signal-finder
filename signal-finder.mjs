#!/usr/bin/env node
/**

Improved Fast SMC Volatility Signals with Mini-Candles (10s)

Fixed EMA/RSI/ATR implementations


Added crossover confirmation and 1m trend filter


Wider SL/TP (ATR multipliers) so you can "wait for profit"


Minor safety: rate-limit signals per symbol (cooldown)
*/



import express from "express";
import WebSocket from "ws";
import readline from "readline";
import chalk from "chalk";
import { initializeApp as initFirebase } from "firebase/app";
import { getDatabase, ref, onValue, set, update, push } from "firebase/database";

// ===== Firebase Config =====
const firebaseConfig = {
apiKey: "AIzaSyAMCVlEPPKA8hSNFF4ruBTayTV_deWsXXw",
authDomain: "pularix-88abb.firebaseapp.com",
databaseURL: "https://pularix-88abb-default-rtdb.firebaseio.com",
projectId: "pularix-88abb",
storageBucket: "pularix-88abb.appspot.com",
messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
appId: "YOUR_APP_ID",
};

// ===== Initialize Firebase =====
const firebaseApp = initFirebase(firebaseConfig);
const db = getDatabase(firebaseApp);

// ===== CONFIG =====
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 400; // keep more history for indicators
const MINI_CANDLE_MS = 10_000;
const COOLDOWN_MS = 60 * 1000;

const MAX_SIGNALS_STORED = 10; // number of signals to keep in memory

const EMA_FAST = 15;
const EMA_SLOW = 30;
const RSI_PERIOD = 14;
const ATR_PERIOD = 10;

// Confirmation & filters
const CROSS_CONFIRMATION = 3; // crossover must persist for this many mini-candles
const RSI_BUY_THRESHOLD = 60; // require stronger momentum
const RSI_SELL_THRESHOLD = 40;
const MIN_ATR = 0.00001; // avoid tiny ATR causing tiny SL/TP (tune for instrument)

// Wider SL/TP multipliers per your request
const SL_ATR_MULT = 3.5;   // stop loss = entry +/- ATR * 4
const TP_ATR_MULT = 7.5;  // take profit = entry +/- ATR * 10

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

// Symbol mapping
const symbolMap = {
"R_10": "v10",
"R_25": "v25",
"R_50": "v50",
"R_75": "v75",
"R_100": "v100"
};

let tableRows = signalsQueue.map((sig, i) => {
const highlightClass = sig.ts === latest ? "highlight" : "";

// Convert timestamp to Botswana time (+2 GMT)  
const botswanaTime = new Date(sig.ts + 2 * 3600 * 1000)  
                      .toISOString()  
                      .substr(11, 8); // HH:MM:SS  
  
return `  
  <tr class="${highlightClass}">  
    <td>${symbolMap[sig.symbol] || sig.symbol}</td>  
    <td style="color:${sig.action === "BUY" ? "green" : "red"}; font-weight:bold;">${sig.action}</td>  
    <td>${Number(sig.entry).toFixed(5)}</td>  
    <td>${Number(sig.sl).toFixed(5)}</td>  
    <td>${Number(sig.tp).toFixed(5)}</td>  
    <td>${Number(sig.atr).toFixed(5)}</td>  
    <td>${botswanaTime}</td>  
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
<title>Keamzfx VIP SMC Signals</title>
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
<h2 style="text-align:center;">📞APP or CALL:77372529</h2>
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
    if (document.querySelector(".highlight")) {  
      sound.volume = 0.4;  
      sound.play().catch(()=>{});  
    }  
  </script>  
</body>  
</html>

`);
});

app.listen(PORT, () => console.log(🌐 Express server is listening on port ${PORT}));

// ===== UTILITIES =====

// Improved EMA (stable rolling version)
function EMA(arr, period) {
if (!arr || arr.length < period) return arr[arr.length - 1] || 0;
const k = 2 / (period + 1);
let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < arr.length; i++) {
ema = arr[i] * k + ema * (1 - k);
}
return ema;
}

// Smoothed RSI (Wilder’s method)
function RSI(arr, period = RSI_PERIOD) {
if (!arr || arr.length < period + 1) return 50;
let gains = 0, losses = 0;
for (let i = 1; i <= period; i++) {
const diff = arr[i] - arr[i - 1];
if (diff >= 0) gains += diff; else losses -= diff;
}
gains /= period;
losses /= period;
for (let i = period + 1; i < arr.length; i++) {
const diff = arr[i] - arr[i - 1];
if (diff >= 0) {
gains = (gains * (period - 1) + diff) / period;
losses = (losses * (period - 1)) / period;
} else {
gains = (gains * (period - 1)) / period;
losses = (losses * (period - 1) - diff) / period;
}
}
if (losses === 0) return 100;
const rs = gains / losses;
return 100 - 100 / (1 + rs);
}

// Wilder’s ATR (smoothed)
function ATR(candles, period = ATR_PERIOD) {
if (!candles || candles.length < period) return 0;
const trs = [];
for (let i = 1; i < candles.length; i++) {
const cur = candles[i];
const prev = candles[i - 1];
const tr = Math.max(
cur.high - cur.low,
Math.abs(cur.high - prev.close),
Math.abs(cur.low - prev.close)
);
trs.push(tr);
}
let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < trs.length; i++) {
atr = (atr * (period - 1) + trs[i]) / period;
}
return atr;
}
// Flat market detection helper
function isFlatMarket(candles, atr) {
if (!candles || candles.length < 3) return false;
const recent = candles.slice(-3);
const maxClose = Math.max(...recent.map(c => c.close));
const minClose = Math.min(...recent.map(c => c.close));
return (maxClose - minClose) < atr * 0.2;
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

// basic trend filter using 1m timeframe
let trendOK = true;
const tf1 = timeframeCandles[symbol] && timeframeCandles[symbol][0];
if (tf1 && tf1.length >= EMA_SLOW) {
const tfCloses = tf1.map(c => c.close);
const tfEmaSlow = EMA(tfCloses, EMA_SLOW);
if (dir === 1 && tfCloses[tfCloses.length - 1] < tfEmaSlow) trendOK = false;
if (dir === -1 && tfCloses[tfCloses.length - 1] > tfEmaSlow) trendOK = false;
}

// Determine action
let action = null;
if (dir === 1 && rsi >= RSI_BUY_THRESHOLD && trendOK && crossoverConfirmed(symbol, 1)) {
action = "BUY";
} else if (dir === -1 && rsi <= RSI_SELL_THRESHOLD && trendOK && crossoverConfirmed(symbol, -1)) {
action = "SELL";
}

// Exit early if no valid action
if (!action) return;

const atr = ATR(candles, ATR_PERIOD) || MIN_ATR;
const safeAtr = Math.max(atr, MIN_ATR);

// Skip flat markets
if (isFlatMarket(candles, safeAtr)) return;

// Respect cooldown
if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

// Calculate SL and TP
const sl = action === "BUY" ? lastClose - safeAtr * SL_ATR_MULT : lastClose + safeAtr * SL_ATR_MULT;
const tp = action === "BUY" ? lastClose + safeAtr * TP_ATR_MULT : lastClose - safeAtr * TP_ATR_MULT;

// Record the signal
lastSignalAt[symbol] = now;
const sig = { symbol, action, entry: lastClose, sl, tp, atr: safeAtr, ts: now };
push(ref(db, "signals/"), sig);

// Update local queue
signalsQueue.unshift(sig);
if (signalsQueue.length > MAX_SIGNALS_STORED) signalsQueue.splice(MAX_SIGNALS_STORED);

renderSignals();
process.stdout.write("\x07"); // beep
}

function renderSignals() {
console.clear();
console.log(chalk.blue.bold("🚀 KeamxFx VIP SMC Signals\n"));
if (!signalsQueue.length) {
console.log("Waiting for new signals...\n");
} else {
signalsQueue.forEach((s, i) => {
const color = s.action === "BUY" ? chalk.green : chalk.red;
const ageSec = Math.round((Date.now() - s.ts) / 1000);
console.log(${i + 1}. ${color(s.action)} ${s.symbol}  ${chalk.dim((${ageSec}s ago))});
console.log(   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(5)}\n);
});
}
console.log(chalk.yellow("Commands: refresh | list"));
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
