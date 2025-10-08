import WebSocket from 'ws';

// 🔌 Connect to Deriv public feed (App ID 1089 = free demo)
const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

// 🎯 Market symbol (change if needed)
const SYMBOL = 'BOOM1000';

// 📈 Spike detection settings
const SPIKE_JUMP = 30; // points difference to detect spike
let lastPrice = null;

console.log(`🔗 Connecting to Deriv WebSocket feed for ${SYMBOL}...`);

const ws = new WebSocket(DERIV_WS_URL);

ws.on('open', () => {
  console.log('✅ Connected! Subscribing to tick feed...');
  ws.send(JSON.stringify({ ticks: SYMBOL }));
});

ws.on('message', (msg) => {
  const data = JSON.parse(msg);

  if (data.msg_type === 'tick' && data.tick) {
    const price = data.tick.quote;
    if (lastPrice !== null) {
      const diff = price - lastPrice;
      if (Math.abs(diff) >= SPIKE_JUMP) {
        console.log(`🚀 Spike detected on ${SYMBOL}! Jump: ${diff.toFixed(2)} points`);
      }
    }
    lastPrice = price;
  }
});

ws.on('close', () => console.log('❌ Connection closed'));
ws.on('error', (err) => console.error('⚠️ WebSocket error:', err.message));
