#!/usr/bin/env node
/**
 * Ultra-Strong Multi-Timeframe SMC Signal Finder
 * + 5 timeframes (10s, 1m, 5m, 15m, 30m)
 * + Persistent confirmed signals
 * + ATR-based SL/TP
 * + Express HTML table
 * + Latest signal highlight + beep alert
 */

import express from "express";
import WebSocket from "ws";
import chalk from "chalk";
import { exec } from "child_process";

// ===== CONFIG =====
const API_TOKEN = "MrUiWBFYmsfrsjC";
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const MAX_HISTORY = 20;
const MINI_CANDLE_MS = 10_000;
const TIMEFRAMES = [60_000, 300_000, 900_000, 1_800_000]; // 1m, 5m, 15m, 30m
const EMA_FAST = 5;
const EMA_SLOW = 15;
const RSI_PERIOD = 14;

// ===== STATE =====
const miniCandles = {};
const timeframeCandles = {};
const confirmedSignals = {}; // persistent confirmed signal per symbol
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
    if (candles.length > 200) candles.shift();
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
}

function updateTimeframeCandles(symbol, price, ts) {
  if (!timeframeCandles[symbol]) timeframeCandles[symbol] = TIMEFRAMES.map(() => []);
  TIMEFRAMES.forEach((tf, idx) => {
    const candles = timeframeCandles[symbol][idx];
    const periodTs = Math.floor(ts / tf) * tf;
    let last = candles[candles.length - 1];
    if (!last || last.ts !== periodTs) {
      last = { open: price, high: price, low: price, close: price, ts: periodTs };
      candles.push(last);
      if (candles.length > 200) candles.shift();
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
  const mini = miniCandles[symbol];
  const tfs = timeframeCandles[symbol];
  if (!mini || !tfs) return;
  if (mini.length < EMA_SLOW) return;

  const closesMini = mini.map(c => c.close);
  const emaFastMini = EMA(closesMini, EMA_FAST);
  const emaSlowMini = EMA(closesMini, EMA_SLOW);
  const rsiMini = RSI(closesMini);
  const lastClose = closesMini[closesMini.length - 1];

  // Multi-timeframe trend check
  let trend = null; // BUY or SELL
  for (let idx = 0; idx < TIMEFRAMES.length; idx++) {
    const candles = tfs[idx];
    if (candles.length < EMA_SLOW) return;
    const closes = candles.map(c => c.close);
    const emaFast = EMA(closes, EMA_FAST);
    const emaSlow = EMA(closes, EMA_SLOW);
    const rsi = RSI(closes);
    if (emaFast > emaSlow && rsi > 50) {
      if (trend === null) trend = "BUY";
      else if (trend !== "BUY") return; // conflicting trend
    } else if (emaFast < emaSlow && rsi < 50) {
      if (trend === null) trend = "SELL";
      else if (trend !== "SELL") return; // conflicting trend
    } else return; // indecision
  }

  if (!trend) return;

  // Persist confirmed signal
  if (confirmedSignals[symbol] && confirmedSignals[symbol].action === trend) return; // already confirmed

  const atr = ATR(mini);
  const sl = trend === "BUY" ? lastClose - atr * 3 : lastClose + atr * 3;
  const tp = trend === "BUY" ? lastClose + atr * 6 : lastClose - atr * 6;

  const sig = { symbol, action: trend, entry: lastClose, sl, tp, atr, ts: now };
  confirmedSignals[symbol] = sig;
  signalsQueue.unshift(sig);
  if (signalsQueue.length > MAX_HISTORY) signalsQueue.splice(MAX_HISTORY);

  // Sound alert
  exec("termux-notification -t 'SMC Signal' -c '" + trend + " " + symbol + "'");

  // Terminal output
  console.log(chalk.yellowBright(`\n📢 ${symbol} CONFIRMED ${trend}`));
  console.log(`Entry: ${lastClose.toFixed(3)} | SL: ${sl.toFixed(3)} | TP: ${tp.toFixed(3)} | ATR: ${atr.toFixed(3)}`);
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
    updateTimeframeCandles(data.tick.symbol, data.tick.quote, ts);
  } else if (data.error) {
    console.log("❌", data.error.message);
  }
});

ws.on("close", () => {
  console.log("❌ Connection closed. Reconnecting in 5s...");
  setTimeout(() => ws.terminate(), 5000);
});

// ===== EXPRESS SERVER (PRETTY HTML) =====
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h2>✅ SMC Ultra Signal Finder Running</h2>
    <p>View live signals below:</p>
    <a href="/signals" style="font-size: 18px; text-decoration: none;">➡️ Open /signals</a>
  `);
});

app.get("/signals", (req, res) => {
  let tableRows = signalsQueue.map((sig, idx) => `
    <tr ${idx === 0 ? 'style="background:#fffbcc;"' : ''}>
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

  if (!tableRows) tableRows = `<tr><td colspan="6" style="text-align:center;">No signals yet ⚡</td></tr>`;

  res.send(`
    <html>
    <head>
      <title>SMC Ultra Signals</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial, sans-serif; background:#f0f2f5; padding:20px; }
        h2 { text-align:center; }
        table { border-collapse: collapse; width:100%; background:white; box-shadow:0 0
