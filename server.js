const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 8877;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CACHE_TTL = 120_000; // 2 min cache, refresh takes ~12s for 31k markets

// ── Cache ──────────────────────────────────────────────────────────
let cache = { events: null, markets: null, stats: null, ts: 0, refreshing: false };

// ── Middleware ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Helpers ────────────────────────────────────────────────────────
function parseJsonStr(s) {
  if (typeof s === 'string') try { return JSON.parse(s); } catch { return s; }
  return s;
}

function formatUSD(v) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// ── Category detection ─────────────────────────────────────────────
const CAT_RULES = [
  { cat: 'Politics', kw: ['president','election','democrat','republican','congress','senate','governor','trump','biden','political','legislation','government','geopolit','war','peace','ukraine','russia','china','nato','immigration','tariff','executive order','white house','supreme court','veto','impeach','parliament'] },
  { cat: 'Sports', kw: ['nba','nfl','mlb','nhl','soccer','football','basketball','baseball','tennis','mma','ufc','boxing','cricket','f1','formula','golf','hockey','ncaa','super bowl','world cup','olympics','premier league','champions league','la liga','serie a','bundesliga','atp','wta','pga','nascar','world series','stanley cup','grand prix','match','game','playoff'] },
  { cat: 'Crypto', kw: ['bitcoin','ethereum','crypto','btc','eth','solana','defi','nft','web3','blockchain','altcoin','memecoin','token','stablecoin','binance','coinbase','halving','airdrop','dao'] },
  { cat: 'Entertainment', kw: ['oscar','grammy','emmy','movie','film','tv show','box office','streaming','celebrity','album','song','artist','netflix','disney','spotify','concert','award show','reality tv','golden globe','bafta','billboard'] },
  { cat: 'Science', kw: ['ai ','artificial intelligence','openai','space','spacex','nasa','climate','fda','health','medicine','vaccine','research','science','technology','google','apple','microsoft','meta','amazon','robot','quantum','fusion','mars','moon'] },
  { cat: 'Economics', kw: ['fed ','federal reserve','inflation','recession','interest rate','gdp','unemployment','stock','s&p','dow','nasdaq','treasury','cpi','jobs report','trade','economic','housing','debt ceiling','default'] },
];

function categorize(title, tags) {
  const lower = (title || '').toLowerCase();
  const tagStr = (tags || []).map(t => (t.label || t.slug || '').toLowerCase()).join(' ');
  const text = lower + ' ' + tagStr;
  for (const { cat, kw } of CAT_RULES) {
    for (const k of kw) {
      if (text.includes(k)) return cat;
    }
  }
  return 'Other';
}

const CAT_ICONS = { Politics: '🏛️', Sports: '⚽', Crypto: '₿', Entertainment: '🎬', Science: '🔬', Economics: '📈', Other: '📦' };

// ── Data fetch & processing ────────────────────────────────────────
async function fetchAllEvents() {
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${GAMMA_BASE}/events?active=true&closed=false&order=volume&ascending=false&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    const events = await res.json();
    if (!events.length) break;
    all.push(...events);
    if (events.length < limit) break;
    offset += limit;
  }
  return all;
}

function processEvents(events) {
  const markets = [];
  for (const ev of events) {
    if (!ev.markets?.length) continue;
    const cat = categorize(ev.title, ev.tags);
    for (const m of ev.markets) {
      if (m.closed || !m.active) continue;
      const outcomes = parseJsonStr(m.outcomes) || ['Yes', 'No'];
      const prices = (parseJsonStr(m.outcomePrices) || ['0', '0']).map(Number);
      const yes = prices[0] || 0;
      const no = prices[1] || (1 - yes);
      const vol = m.volumeNum || parseFloat(m.volume) || 0;
      const vol24 = m.volume24hr || 0;
      const liq = m.liquidityNum || parseFloat(m.liquidity) || 0;
      const change1d = m.oneDayPriceChange ?? null;
      const change1w = m.oneWeekPriceChange ?? null;

      // Hard quality gates — skip garbage markets
      if (liq < 10000) continue;        // No liquidity = manipulation risk
      if (vol24 < 1000) continue;       // Dead market
      if (yes <= 0.05 || yes >= 0.95) continue;  // No upside / foregone conclusion

      // Research-backed curation score (0-100)
      // Weights: Prob deviation 30%, Liquidity 30%, Volume 20%, Time pressure 20%

      // Probability deviation from 50% (sweet spot: 15-85% range)
      const probDeviation = 1 - Math.abs(yes - 0.5) * 2;

      // Liquidity score (log-scaled, $10k floor already applied)
      const liqNorm = Math.min(Math.log10(liq / 10000) / 4, 1);

      // Volume momentum (24h vol relative to total — fresh activity signal)
      const volNorm = Math.min(Math.log10(Math.max(vol24, 1)) / 6, 1);

      // Time pressure (markets resolving in 1-14 days score highest)
      const daysLeft = m.endDate ? Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000) : 30;
      const timePressure = daysLeft <= 1 ? 0.5 :   // too close, risky
                           daysLeft <= 14 ? 1 :
                           daysLeft <= 30 ? 0.7 :
                           daysLeft <= 60 ? 0.4 : 0.1;

      const edge = Math.round(
        ((probDeviation * 0.30) + (liqNorm * 0.30) + (volNorm * 0.20) + (timePressure * 0.20)) * 100 * 10
      ) / 10;

      // News lag: stale price relative to resolution proximity
      const newsLag = (change1d !== null && Math.abs(change1d) < 0.005 && daysLeft < 3) ? 'HIGH' :
                      (change1d !== null && Math.abs(change1d) < 0.02 && daysLeft < 7) ? 'MEDIUM' : 'LOW';

      markets.push({
        id: m.id,
        eventId: ev.id,
        eventTitle: ev.title,
        eventSlug: ev.slug,
        question: m.groupItemTitle || m.question || ev.title,
        slug: m.slug,
        description: m.description || ev.description || '',
        category: cat,
        categoryIcon: CAT_ICONS[cat] || '📦',
        outcomes,
        prices,
        yesPrice: yes,
        noPrice: no,
        volume: vol,
        volume24hr: vol24,
        volume24hrFmt: formatUSD(vol24),
        volume1wk: m.volume1wk || 0,
        liquidity: liq,
        liquidityFmt: formatUSD(liq),
        endDate: m.endDate || ev.endDate,
        lastTradePrice: m.lastTradePrice || yes,
        bestBid: m.bestBid || 0,
        bestAsk: m.bestAsk || 0,
        spread: m.spread || 0,
        priceChange1d: change1d,
        priceChange1w: change1w,
        priceChange1m: m.oneMonthPriceChange ?? null,
        image: m.image || m.icon || ev.image || ev.icon || '',
        competitive: m.competitive || 0,
        conditionId: m.conditionId || '',
        clobTokenIds: (() => { try { return JSON.parse(m.clobTokenIds || '[]'); } catch { return []; } })(),
        polymarketUrl: `https://polymarket.com/event/${ev.slug}`,
        volumeRatio: vol > 0 ? vol24 / vol : 0,
        edge,
        newsLag,
        daysLeft: Math.round(daysLeft * 10) / 10,
        acceptingOrders: m.acceptingOrders ?? true,
        newsSignal: null,
        smartMoneySignal: null,
      });
    }
  }
  return markets;
}

function categorizeColumns(markets) {
  const now = Date.now();

  // 🎯 Best Bets: Top 10 by combined score
  const bestBets = markets
    .filter(m => m.liquidity >= 20000 && m.volume24hr >= 3000 && m.daysLeft <= 30)
    .map(m => {
      const vol24Norm = Math.min(Math.log10(Math.max(m.volume24hr, 1)) / 6, 1);
      const timePressure = m.daysLeft <= 1 ? 0.5 : m.daysLeft <= 14 ? 1 : m.daysLeft <= 30 ? 0.7 : 0.4;
      const newsBoost = m.newsSignal?.opportunity ? 0.2 : 0;
      const smBoost = m.smartMoneySignal?.alert ? 0.1 : 0;
      const score = (m.edge / 100) * 0.4 + vol24Norm * 0.3 + timePressure * 0.2 + newsBoost + smBoost;
      return { ...m, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);

  // 📰 News Edge: News contradicts current price
  const newsEdge = markets
    .filter(m => m.newsSignal?.opportunity === true)
    .sort((a, b) => (b.newsSignal?.confidence || 0) - (a.newsSignal?.confidence || 0))
    .slice(0, 15);

  // 🐋 Smart Money: Large trades in last 4h
  const smartMoney = markets
    .filter(m => m.smartMoneySignal?.alert === true)
    .sort((a, b) => (b.smartMoneySignal?.largestTrade?.size || 0) - (a.smartMoneySignal?.largestTrade?.size || 0))
    .slice(0, 15);

  // ⚡ Closing Soon: Resolving in ≤48h
  const closingSoon = markets
    .filter(m => { const e = new Date(m.endDate).getTime(); return e > now && (e - now) <= 172800000; })
    .filter(m => m.liquidity >= 10000)
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
    .slice(0, 15);

  // 📈 Momentum: Price moved 3%+ today
  const momentum = markets
    .filter(m => m.priceChange1d !== null && Math.abs(m.priceChange1d) > 0.03)
    .filter(m => m.volume24hr >= 3000)
    .sort((a, b) => Math.abs(b.priceChange1d) - Math.abs(a.priceChange1d))
    .slice(0, 15);

  return { bestBets, newsEdge, smartMoney, closingSoon, momentum };
}

async function refreshCache() {
  if (Date.now() - cache.ts < CACHE_TTL && cache.markets) return;
  if (cache.refreshing) {
    // Wait for in-progress refresh
    while (cache.refreshing) await new Promise(r => setTimeout(r, 500));
    return;
  }
  cache.refreshing = true;
  try {
    console.log(`[${new Date().toISOString()}] Refreshing cache...`);
    const events = await fetchAllEvents();
    const markets = processEvents(events);

    // Enrich with news + smart money (non-blocking)
    const { fetchNewsSignals } = require('./api/news');
    const { fetchSmartMoneySignals } = require('./api/smartmoney');
    const [newsMap, smMap] = await Promise.all([
      fetchNewsSignals(markets).catch(() => new Map()),
      fetchSmartMoneySignals(markets).catch(() => new Map()),
    ]);
    for (const m of markets) {
      m.newsSignal = newsMap.get(m.id) || null;
      m.smartMoneySignal = smMap.get(m.id) || null;
    }

    const columns = categorizeColumns(markets);
    const now = Date.now();
    const eod = new Date(); eod.setHours(23, 59, 59, 999);

    const stats = {
      totalMarkets: markets.length,
      totalVolume24h: markets.reduce((s, m) => s + m.volume24hr, 0),
      totalVolume24hFmt: formatUSD(markets.reduce((s, m) => s + m.volume24hr, 0)),
      closingToday: markets.filter(m => { const e = new Date(m.endDate).getTime(); return e > now && e <= eod.getTime(); }).length,
      totalEvents: events.length,
      lastRefresh: new Date().toISOString(),
      newsOpportunities: columns.newsEdge.length,
      smartMoneyAlerts: columns.smartMoney.length,
      columnCounts: {
        bestBets: columns.bestBets.length,
        newsEdge: columns.newsEdge.length,
        smartMoney: columns.smartMoney.length,
        closingSoon: columns.closingSoon.length,
        momentum: columns.momentum.length,
      },
    };

    cache = { events, markets, columns, stats, ts: Date.now(), refreshing: false };
    console.log(`[${new Date().toISOString()}] Cache refreshed: ${markets.length} markets from ${events.length} events`);
  } catch (err) {
    cache.refreshing = false;
    console.error(`[${new Date().toISOString()}] Cache refresh failed:`, err.message);
    if (!cache.markets) throw err;
  }
}

// ── Routes ─────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    await refreshCache();
    const { search, category, sort, limit } = req.query;
    let results = [...cache.markets];

    if (search) {
      const q = search.toLowerCase();
      results = results.filter(m =>
        m.question.toLowerCase().includes(q) ||
        m.eventTitle.toLowerCase().includes(q)
      );
    }
    if (category && category !== 'All') {
      results = results.filter(m => m.category === category);
    }
    if (sort) {
      const sorters = {
        volume24hr: (a, b) => b.volume24hr - a.volume24hr,
        endDate: (a, b) => new Date(a.endDate) - new Date(b.endDate),
        liquidity: (a, b) => b.liquidity - a.liquidity,
        edge: (a, b) => b.edge - a.edge,
        newest: (a, b) => new Date(b.endDate) - new Date(a.endDate),
      };
      if (sorters[sort]) results.sort(sorters[sort]);
    }
    results = results.slice(0, Math.min(parseInt(limit) || 500, 2000));

    res.json({ markets: results, total: results.length });
  } catch (err) {
    console.error('GET /api/markets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/columns', async (_req, res) => {
  try {
    await refreshCache();
    res.json(cache.columns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/market/:id', async (req, res) => {
  try {
    await refreshCache();
    const market = cache.markets.find(m => m.id === req.params.id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trending', async (_req, res) => {
  try {
    await refreshCache();
    res.json(cache.columns.trending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/closing-soon', async (_req, res) => {
  try {
    await refreshCache();
    res.json(cache.columns.closingSoon);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whales', async (_req, res) => {
  try {
    await refreshCache();
    res.json(cache.columns.newsLag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    await refreshCache();
    res.json(cache.stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Kalshi Arbitrage ───────────────────────────────────────────────
app.get('/api/arb', async (_req, res) => {
  try {
    await refreshCache();
    const arbs = [];
    try {
      const kr = await fetch('https://trading-api.kalshi.com/trade-api/v2/markets?limit=200&status=open', { headers: { 'Accept': 'application/json' } });
      if (kr.ok) {
        const kd = await kr.json();
        for (const km of (kd.markets || [])) {
          const kalshiYes = (km.yes_ask || km.yes_bid || 0) / 100;
          if (!kalshiYes) continue;
          const kmTitle = (km.title || km.subtitle || '').toLowerCase();
          const words = kmTitle.split(' ').filter(w => w.length > 4);
          const polyMatch = cache.markets.find(pm => {
            const pt = pm.question.toLowerCase();
            return words.filter(w => pt.includes(w)).length >= 2;
          });
          if (polyMatch) {
            const gap = Math.abs(polyMatch.yesPrice - kalshiYes);
            if (gap > 0.03) {
              arbs.push({
                polymarket: polyMatch.question,
                polyUrl: polyMatch.polymarketUrl,
                kalshiTitle: km.title,
                polyPrice: polyMatch.yesPrice,
                kalshiPrice: kalshiYes,
                gap: Math.round(gap * 10000) / 100,
                profitPer100: Math.round(gap * 100 * 100) / 100,
                direction: polyMatch.yesPrice > kalshiYes ? 'Buy Kalshi YES' : 'Buy Polymarket YES',
              });
            }
          }
        }
      }
    } catch (e) { /* Kalshi unavailable */ }
    arbs.sort((a, b) => b.gap - a.gap);
    res.json({ arbs: arbs.slice(0, 20) });
  } catch (err) {
    res.json({ arbs: [], error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 PolyIntel server running on http://0.0.0.0:${PORT}\n`);
  // Pre-warm cache
  refreshCache().catch(err => console.error('Initial cache failed:', err.message));
});
