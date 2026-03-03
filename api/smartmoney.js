const fetch = require('node-fetch');

const smCache = new Map(); // conditionId -> { signal, ts }
const CACHE_TTL = 10 * 60 * 1000;
const MIN_TRADE_SIZE = 2000;
const LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours

async function fetchSmartMoneyForMarket(market) {
  if (!market.conditionId) return null;
  const cached = smCache.get(market.conditionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.signal;

  try {
    const url = `https://data-api.polymarket.com/trades?market=${encodeURIComponent(market.conditionId)}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const trades = await res.json();
    if (!Array.isArray(trades) || !trades.length) return null;

    const cutoff = Date.now() - LOOKBACK_MS;
    const recent = trades.filter(t => {
      const ts = (t.timestamp || 0) * 1000;
      return ts > cutoff && (t.size || 0) >= MIN_TRADE_SIZE;
    });

    if (!recent.length) return null;

    // Map asset token to YES/NO side
    const yesTokenId = (market.clobTokenIds || [])[0];
    const enriched = recent.map(t => {
      const isYesToken = yesTokenId && String(t.asset) === String(yesTokenId);
      // SELL of NO token = buying YES effectively, SELL of YES = selling YES
      let side;
      if (t.side === 'BUY')  side = isYesToken ? 'YES' : 'NO';
      else                    side = isYesToken ? 'NO'  : 'YES';
      return {
        wallet: t.proxyWallet,
        side,
        size: Math.round(t.size || 0),
        price: t.price,
        timestamp: (t.timestamp || 0) * 1000,
        timeAgo: formatTimeAgo((t.timestamp || 0) * 1000),
      };
    }).sort((a, b) => b.size - a.size);

    const largest = enriched[0];
    const total4h = enriched.reduce((s, t) => s + t.size, 0);

    const signal = { trades: enriched.slice(0, 5), largestTrade: largest, total4h, alert: true };
    smCache.set(market.conditionId, { signal, ts: Date.now() });
    return signal;
  } catch(e) {
    return null;
  }
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff/1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff/60000)}m ago`;
  return `${Math.round(diff/3600000)}h ago`;
}

async function fetchSmartMoneySignals(markets) {
  const top = [...markets].sort((a,b) => b.volume24hr - a.volume24hr).slice(0, 40);
  const results = await Promise.allSettled(top.map(m => fetchSmartMoneyForMarket(m)));
  const map = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) map.set(top[i].id, r.value);
  });
  return map;
}

module.exports = { fetchSmartMoneySignals };
