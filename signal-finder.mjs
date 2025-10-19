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
const MAX_HISTORY = 200;
const MINI_CANDLE_MS = 10_000;
const MAX_SIGNALS_STORED = 10;
const COOLDOWN_MS = 60 * 1000;

const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

// ===== STATE =====
const miniCandles = {};
const timeframeCandles = {};
const lastSignalAt = {};
const signalsQueue = [];

// Listen for updates from Firebase
onValue(ref(db, "signals/"), (snapshot) => {
  const data = snapshot.val();
  if (data) {
    const list = Object.values(data).reverse();
    signalsQueue.length = 0;
    signalsQueue.push(...list.slice(0, 10));
  }
});

const crossoverHistory = {};

// ===== READLINE =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === "list") renderSignals();
  if (cmd === "refresh") signalsQueue.length = 0;
});

// ===== EXPRESS =====
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    Keamzfx VIP SMC Signals is running ✅
    <br><br>
    View live signals here 👉 
    <a href="https://smc-signal-finder.onrender.com/signals" target="_blank">
      /signals
    </a>
  `);
});

app.get("/signals", (req, res) => {
  let latest = signalsQueue[0]?.ts || 0;

  const symbolMap = {
    "R_10": "v10",
    "R_25": "v25",
    "R_50": "v50",
    "R_75": "v75",
    "R_100": "v100"
  };

let tableRows = signalsQueue.map((sig) => {
    const highlightClass = sig.ts === latest ? "highlight" : "";
    const botswanaTime = new Date(sig.ts + 2 * 3600 * 1000).toISOString().substr(11, 8);
    return `<tr class="${highlightClass}">
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
 <html>
    <head>
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
      <h2 style="text-align: center;">📊 Keamzfx VIP SMC Signals</h2>
<h3 style="text-align: center;">📞 APP or CALL: 77372529</h3>
      <table>
        <tr>
          <th>Symbol</th><th>Action</th><th>Entry</th><th>Stop Loss</th><th>Take Profit</th><th>ATR</th><th>When</th>
        </tr>
        ${tableRows}
      </table>
      <div class="small">Auto-refreshes every 5s. Keeps last ${MAX_SIGNALS_STORED} signals.</div>
      <audio id="alertSound">
        <source src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" type="audio/ogg">
      </audio>
      <script>
  // Play sound when a new signal appears
  const sound = document.getElementById("alertSound");
  if (document.querySelector(".highlight")) {
    sound.volume = 0.4;
    sound.play().catch(()=>{});
  }

  // Auto-refresh page every 5 seconds
  setTimeout(() => {
    location.reload();
  }, 5000);
</script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`🌐 Express server is listening on port ${PORT}`));

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
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
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
  if (emaFast > emaSlow && rsi > 50) action = "BUY";
  if (emaFast < emaSlow && rsi < 50) action = "SELL";

  if (!action) return;
  if (lastSignalAt[symbol] && now - lastSignalAt[symbol] < COOLDOWN_MS) return;

  lastSignalAt[symbol] = now;

  const atr = ATR(candles);
  const sl = action === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = action === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = { symbol, action, entry: lastClose, sl, tp, atr };
  signalsQueue.unshift(sig);
  if (signalsQueue.length > 5) signalsQueue.splice(5);

  renderSignals();
  process.stdout.write("\x07"); // beep alert
}

function renderSignals() {
  console.clear();
  console.log(chalk.blue.bold("🚀 KeamzFx Signals (Mini-Candles 10s)\n"));
  if (!signalsQueue.length) console.log("Waiting for signals...\n");
  signalsQueue.forEach((s, i) => {
    const color = s.action === "BUY" ? chalk.green : chalk.red;
    console.log(`${i + 1}. ${color(s.action)} ${s.symbol}`);
    console.log(`   Entry: ${s.entry.toFixed(5)} | SL: ${s.sl.toFixed(5)} | TP: ${s.tp.toFixed(5)} | ATR: ${s.atr.toFixed(5)}\n`);
  });
  console.log(chalk.yellow("Commands: refresh | list"));
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
