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
      const oddsFactor = 1 - Math.abs(yes - 0.5)*2;
      const edge = ((oddsFactor*0.3)+(Math.log10(Math.max(vol24,1))/7*0.4)+(Math.log10(Math.max(liq,1))/7*0.3))*100;
      markets.push({
        id:m.id, eventId:ev.id, eventTitle:ev.title, eventSlug:ev.slug,
        question:m.groupItemTitle||m.question||ev.title, slug:m.slug,
        description:(m.description||ev.description||'').substring(0,500),
        category:cat, categoryIcon:CAT_ICONS[cat]||'📦',
        outcomes:parseJsonStr(m.outcomes)||['Yes','No'], prices, yesPrice:yes, noPrice:no,
        volume:vol, volume24hr:vol24, volume24hrFmt:formatUSD(vol24),
        volume1wk:m.volume1wk||0, liquidity:liq, liquidityFmt:formatUSD(liq),
        endDate:m.endDate||ev.endDate,
        lastTradePrice:m.lastTradePrice||yes, bestBid:m.bestBid||0, bestAsk:m.bestAsk||0, spread:m.spread||0,
        priceChange1d:m.oneDayPriceChange??null, priceChange1w:m.oneWeekPriceChange??null, priceChange1m:m.oneMonthPriceChange??null,
        image:m.image||m.icon||ev.image||ev.icon||'',
        competitive:m.competitive||0,
        polymarketUrl:`https://polymarket.com/event/${ev.slug}`,
        volumeRatio:vol>0?vol24/vol:0, edge:Math.round(edge*10)/10,
      });
    }
  }
  return markets;
}

function categorizeColumns(markets) {
  const now = Date.now(), h48 = 48*3600*1000;
  return {
    dontMiss: markets.filter(m=>m.yesPrice>=0.55&&m.yesPrice<=0.85&&m.volume24hr>10000&&m.liquidity>20000).sort((a,b)=>b.volume24hr-a.volume24hr).slice(0,25),
    highRisk: markets.filter(m=>(m.yesPrice>=0.35&&m.yesPrice<=0.55)||m.liquidity<20000).filter(m=>m.volume24hr>1000).sort((a,b)=>b.volume24hr-a.volume24hr).slice(0,25),
    safePlays: markets.filter(m=>(m.yesPrice>0.85||m.yesPrice<0.15)&&m.volume24hr>10000).sort((a,b)=>b.volume24hr-a.volume24hr).slice(0,25),
    closingSoon: markets.filter(m=>{const e=new Date(m.endDate).getTime();return e>now&&e-now<=h48;}).sort((a,b)=>new Date(a.endDate)-new Date(b.endDate)).slice(0,25),
    trending: markets.filter(m=>m.priceChange1d!==null&&Math.abs(m.priceChange1d)>0.005).sort((a,b)=>Math.abs(b.priceChange1d)-Math.abs(a.priceChange1d)).slice(0,25),
    whales: markets.filter(m=>m.volumeRatio>0.02&&m.volume24hr>5000).sort((a,b)=>b.volumeRatio-a.volumeRatio).slice(0,25),
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
