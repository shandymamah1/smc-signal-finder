import WebSocket from 'ws';
import fs from 'fs';

// 🔌 Deriv WebSocket URL (demo App ID)
const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

// 📌 Symbols to monitor
const SYMBOLS = ['BOOM1000', 'BOOM500', 'CRASH1000', 'CRASH500'];

// 📈 Jump threshold per symbol (points)
const SPIKE_JUMPS = {
  BOOM1000: 30,
  BOOM500: 15,
  CRASH1000: 30,
  CRASH500: 15
};

// Store last price per symbol
const lastPrices = {};

// Create WebSocket connection
const ws = new WebSocket(DERIV_WS_URL);

ws.on('open', () => {
  console.log('🔗 Connected! Subscribing to symbols...');
  SYMBOLS.forEach(symbol => {
    ws.send(JSON.stringify({ ticks: symbol }));
    console.log(`📡 Subscribed to ${symbol}`);
  });
});

// Handle incoming ticks
ws.on('message', (msg) => {
  const data = JSON.parse(msg);

  if (data.msg_type === 'tick' && data.tick) {
    const symbol = data.tick.symbol;
    const price = data.tick.quote;

    if (lastPrices[symbol] !== undefined) {
      const diff = price - lastPrices[symbol];
      if (Math.abs(diff) >= SPIKE_JUMPS[symbol]) {
        const spikeMsg = `🚀 Spike detected on ${symbol}! Jump: ${diff.toFixed(2)} points`;
        console.log(spikeMsg);

        // Log spike to file
        fs.appendFileSync('spikes.log', `${new Date().toISOString()} | ${spikeMsg}\n`);
      }
    }
    lastPrices[symbol] = price;
  }
});

ws.on('close', () => console.log('❌ Connection closed'));
ws.on('error', (err) => console.error('⚠️ WebSocket error:', err.message));
