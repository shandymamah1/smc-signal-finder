#!/usr/bin/env node
/**
 * 🚀 SMC Volatility Signal Finder
 * Matches browser signals (10s candles)
 */

import express from "express";
import WebSocket from "ws";
import chalk from "chalk";

const API_TOKEN = "MrUiWBFYmsfrsjC"; // ✅ your Deriv token
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const SERVER_PORT = 3000;

let latestCandles = {};
let signals = [];

const app = express();

app.get("/", (req, res) => {
  res.send(`
  <h3 style="color:#007bff;">🚀 SMC Volatility Signals (10s Mini-Candles)</h3>
  <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;text-align:center;">
  <thead style="background-color:#007bff;color:white;">
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
  ${signals
    .slice(-5)
    .reverse()
    .map(
      (s) => `
      <tr>
        <td>${s.symbol}</td>
        <td style="color:${s.action === "BUY" ? "green" : "red"};">${s.action}</td>
        <td>${s.entry.toFixed(6)}</td>
        <td>${s.stopLoss.toFixed(6)}</td>
        <td>${s.takeProfit.toFixed(6)}</td>
        <td>${s.atr.toFixed(6)}</td>
        <td>${s.time}</td>
      </tr>`
    )
    .join("")}
  </tbody>
  </table>
  <p style="text-align:center;">Auto-refreshes every 5 seconds. Showing last 5 signals.</p>
  <script>setTimeout(()=>location.reload(),5000)</script>
  `);
});

app.listen(SERVER_PORT, () =>
  console.log(chalk.green(`🌐 Server running at http://localhost:${SERVER_PORT}`))
);

const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

ws.on("open", () => {
  console.log(chalk.cyan("🔗 Connected. Authorizing..."));
  ws.send(JSON.stringify({ authorize: API_TOKEN }));
});

ws.on("message", (msg) => {
  const data = JSON.parse(msg);

  if (data.msg_type === "authorize") {
    console.log(chalk.green("✅ Authorized."));
    subscribeAll();
  }

  if (data.msg_type === "candles") {
    handleCandle(data.echo_req.ticks_history, data.candles);
  }

  if (data.msg_type === "ohlc") {
    handleLiveCandle(data.ohlc);
  }
});

function subscribeAll() {
  SYMBOLS.forEach((symbol) => {
    ws.send(
      JSON.stringify({
        ticks_history: symbol,
        style: "candles",
        granularity: 10,
        count: 10,
      })
    );

    ws.send(
      JSON.stringify({
        subscribe: 1,
        ticks_history: symbol,
        style: "candles",
        granularity: 10,
      })
    );
  });
}

function handleCandle(symbol, candles) {
  latestCandles[symbol] = candles.map((c) => ({
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

function handleLiveCandle(candle) {
  const symbol = candle.symbol;
  if (!latestCandles[symbol]) return;

  const newCandle = {
    open: parseFloat(candle.open),
    high: parseFloat(candle.high),
    low: parseFloat(candle.low),
    close: parseFloat(candle.close),
  };

  const candles = latestCandles[symbol];
  if (candles.length >= 10) candles.shift();
  candles.push(newCandle);
  latestCandles[symbol] = candles;

  const signal = checkSignal(symbol, candles);
  if (signal) {
    signals.push(signal);
    showSignal(signal);
  }
}

function checkSignal(symbol, candles) {
  if (candles.length < 3) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const atr = calcATR(candles);

  if (last.close > prev.high) {
    return {
      symbol,
      action: "BUY",
      entry: last.close,
      stopLoss: last.close - atr * 3,
      takeProfit: last.close + atr * 3,
      atr,
      time: new Date().toLocaleTimeString(),
    };
  } else if (last.close < prev.low) {
    return {
      symbol,
      action: "SELL",
      entry: last.close,
      stopLoss: last.close + atr * 3,
      takeProfit: last.close - atr * 3,
      atr,
      time: new Date().toLocaleTimeString(),
    };
  }

  return null;
}

function calcATR(candles) {
  let total = 0;
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    total += tr;
  }
  return total / (candles.length - 1);
}

function showSignal(sig) {
  const color = sig.action === "BUY" ? chalk.green : chalk.red;
  console.log(
    color(
      `[${sig.time}] ${sig.symbol} ${sig.action} @ ${sig.entry.toFixed(
        5
      )} | SL: ${sig.stopLoss.toFixed(5)} | TP: ${sig.takeProfit.toFixed(5)} | ATR: ${sig.atr.toFixed(
        5
      )}`
    )
  );
}

// ✅ keep process alive
setInterval(() => {}, 1000);
