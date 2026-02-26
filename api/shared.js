const fetch = require('node-fetch');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
let cache = { markets: null, columns: null, stats: null, ts: 0, refreshing: null };
const CACHE_TTL = 45_000;

function parseJsonStr(s) {
  if (typeof s === 'string') try { return JSON.parse(s); } catch { return s; }
  return s;
}

function formatUSD(v) {
  if (v >= 1e9) return `$${(v/1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v/1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v/1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

const CAT_RULES = [
  { cat:'Politics', kw:['president','election','democrat','republican','congress','senate','governor','trump','biden','political','legislation','government','geopolit','war','peace','ukraine','russia','china','nato','immigration','tariff','executive order','white house','supreme court','veto','impeach','parliament'] },
  { cat:'Sports', kw:['nba','nfl','mlb','nhl','soccer','football','basketball','baseball','tennis','mma','ufc','boxing','cricket','f1','formula','golf','hockey','ncaa','super bowl','world cup','olympics','premier league','champions league','la liga','serie a','bundesliga','atp','wta','pga','nascar','world series','stanley cup','grand prix','match','game','playoff'] },
  { cat:'Crypto', kw:['bitcoin','ethereum','crypto','btc','eth','solana','defi','nft','web3','blockchain','altcoin','memecoin','token','stablecoin','binance','coinbase','halving','airdrop','dao'] },
  { cat:'Entertainment', kw:['oscar','grammy','emmy','movie','film','tv show','box office','streaming','celebrity','album','song','artist','netflix','disney','spotify','concert','award show','reality tv','golden globe','bafta','billboard'] },
  { cat:'Science', kw:['ai ','artificial intelligence','openai','space','spacex','nasa','climate','fda','health','medicine','vaccine','research','science','technology','google','apple','microsoft','meta','amazon','robot','quantum','fusion','mars','moon'] },
  { cat:'Economics', kw:['fed ','federal reserve','inflation','recession','interest rate','gdp','unemployment','stock','s&p','dow','nasdaq','treasury','cpi','jobs report','trade','economic','housing','debt ceiling','default'] },
];

const CAT_ICONS = { Politics:'🏛️', Sports:'⚽', Crypto:'₿', Entertainment:'🎬', Science:'🔬', Economics:'📈', Other:'📦' };

function categorize(title, tags) {
  const text = ((title||'') + ' ' + (tags||[]).map(t=>(t.label||t.slug||'')).join(' ')).toLowerCase();
  for (const {cat,kw} of CAT_RULES) for (const k of kw) if (text.includes(k)) return cat;
  return 'Other';
}

async function fetchAllEvents() {
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(`${GAMMA_BASE}/events?active=true&closed=false&order=volume&ascending=false&limit=${limit}&offset=${offset}`);
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
      const prices = (parseJsonStr(m.outcomePrices)||['0','0']).map(Number);
      const yes = prices[0]||0, no = prices[1]||(1-yes);
      const vol = m.volumeNum||parseFloat(m.volume)||0;
      const vol24 = m.volume24hr||0;
      const liq = m.liquidityNum||parseFloat(m.liquidity)||0;
      // Hard quality gates
      if (liq < 10000) continue;
      if (vol24 < 1000) continue;
      if (yes <= 0.05 || yes >= 0.95) continue;

      // Research-backed curation score
      const change1d = m.oneDayPriceChange ?? null;
      const probDeviation = 1 - Math.abs(yes - 0.5) * 2;
      const liqNorm = Math.min(Math.log10(liq / 10000) / 4, 1);
      const volNorm = Math.min(Math.log10(Math.max(vol24, 1)) / 6, 1);
      const daysLeft = (m.endDate||ev.endDate) ? Math.max(0, (new Date(m.endDate||ev.endDate) - Date.now()) / 86400000) : 30;
      const timePressure = daysLeft <= 1 ? 0.5 : daysLeft <= 14 ? 1 : daysLeft <= 30 ? 0.7 : daysLeft <= 60 ? 0.4 : 0.1;
      const edge = Math.round(((probDeviation*0.30)+(liqNorm*0.30)+(volNorm*0.20)+(timePressure*0.20))*1000)/10;
      const newsLag = (change1d !== null && Math.abs(change1d) < 0.005 && daysLeft < 3) ? 'HIGH' :
                      (change1d !== null && Math.abs(change1d) < 0.02 && daysLeft < 7) ? 'MEDIUM' : 'LOW';

      markets.push({
        id:m.id, eventId:ev.id, eventTitle:ev.title, eventSlug:ev.slug,
        question:m.groupItemTitle||m.question||ev.title, slug:m.slug,
        description:(m.description||ev.description||'').substring(0,500),
        category:cat, categoryIcon:CAT_ICONS[cat]||'📦',
        outcomes:parseJsonStr(m.outcomes)||['Yes','No'], prices, yesPrice:yes, noPrice:no,
        volume:vol, volume24hr:vol24, volume24hrFmt:formatUSD(vol24),
        volume1wk:m.volume1wk||0, liquidity:liq, liquidityFmt:formatUSD(liq),
        endDate:m.endDate||ev.endDate, daysLeft:Math.round(daysLeft*10)/10,
        lastTradePrice:m.lastTradePrice||yes, bestBid:m.bestBid||0, bestAsk:m.bestAsk||0, spread:m.spread||0,
        priceChange1d:change1d, priceChange1w:m.oneWeekPriceChange??null, priceChange1m:m.oneMonthPriceChange??null,
        image:m.image||m.icon||ev.image||ev.icon||'',
        competitive:m.competitive||0,
        polymarketUrl:`https://polymarket.com/event/${ev.slug}`,
        volumeRatio:vol>0?vol24/vol:0, edge, newsLag,
      });
    }
  }
  return markets;
}

function categorizeColumns(markets) {
  const now = Date.now();
  return {
    dontMiss: markets.filter(m=>m.yesPrice>=0.20&&m.yesPrice<=0.80&&m.liquidity>=25000&&m.volume24hr>=5000&&m.daysLeft<=30).sort((a,b)=>b.edge-a.edge).slice(0,20),
    highRisk: markets.filter(m=>m.yesPrice>=0.35&&m.yesPrice<=0.65&&m.volume24hr>=2000&&m.liquidity>=15000).sort((a,b)=>b.volume24hr-a.volume24hr).slice(0,20),
    safePlays: markets.filter(m=>(m.yesPrice>0.75||m.yesPrice<0.25)&&m.liquidity>=20000&&m.volume24hr>=3000&&m.daysLeft<=21).sort((a,b)=>b.volume24hr-a.volume24hr).slice(0,20),
    closingSoon: markets.filter(m=>{const e=new Date(m.endDate).getTime();return e>now&&(e-now)<=172800000;}).filter(m=>m.liquidity>=10000).sort((a,b)=>new Date(a.endDate)-new Date(b.endDate)).slice(0,20),
    trending: markets.filter(m=>m.priceChange1d!==null&&Math.abs(m.priceChange1d)>0.02&&m.volume24hr>=3000).sort((a,b)=>Math.abs(b.priceChange1d)-Math.abs(a.priceChange1d)).slice(0,20),
    newsLag: markets.filter(m=>(m.newsLag==='HIGH'||m.newsLag==='MEDIUM')&&m.liquidity>=15000).sort((a,b)=>a.daysLeft-b.daysLeft).slice(0,20),
  };
}

async function getData() {
  if (Date.now() - cache.ts < CACHE_TTL && cache.markets) return cache;
  if (cache.refreshing) { await cache.refreshing; return cache; }
  const p = (async () => {
    const events = await fetchAllEvents();
    const markets = processEvents(events);
    const columns = categorizeColumns(markets);
    const now = Date.now(), eod = new Date(); eod.setHours(23,59,59,999);
    cache = {
      markets, columns,
      stats: {
        totalMarkets:markets.length,
        totalVolume24h:markets.reduce((s,m)=>s+m.volume24hr,0),
        totalVolume24hFmt:formatUSD(markets.reduce((s,m)=>s+m.volume24hr,0)),
        closingToday:markets.filter(m=>{const e=new Date(m.endDate).getTime();return e>now&&e<=eod.getTime();}).length,
        totalEvents:events.length, lastRefresh:new Date().toISOString(),
        columnCounts:Object.fromEntries(Object.entries(columns).map(([k,v])=>[k,v.length])),
      },
      ts:Date.now(), refreshing:null
    };
  })();
  cache.refreshing = p;
  await p;
  return cache;
}

module.exports = { getData };
