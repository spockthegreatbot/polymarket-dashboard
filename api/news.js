const fetch = require('node-fetch');
const fs = require('fs');

// Load Brave API key
let BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  try {
    const config = JSON.parse(fs.readFileSync('/home/linuxuser/.openclaw/openclaw.json', 'utf8'));
    BRAVE_API_KEY = config.env?.BRAVE_API_KEY;
  } catch(e) {}
}

const YES_WORDS = ['wins','win','won','passes','passed','confirmed','confirms','rises','increased','beats','beat','approves','approved','advances','advanced','survives','survived','elected','signed','launched','succeeded','success','agrees','agreed','secured'];
const NO_WORDS  = ['loses','lost','fails','failed','rejected','drops','dropped','falls','fell','misses','missed','blocked','suspended','withdraws','withdrew','eliminated','cancelled','canceled','denied','collapsed','resigned','arrested','defeated','acquitted','dismissed'];

const newsCache = new Map(); // marketId -> { signal, ts }
const CACHE_TTL = 15 * 60 * 1000;

function stripQuestion(q) {
  return (q || '')
    .replace(/^(will|does|is|has|did|can|are|was|were|do|would|could|should)\s+/i, '')
    .replace(/\?.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function scoreLean(text, yesPrice) {
  const t = (text || '').toLowerCase();
  let yesHits = 0, noHits = 0;
  for (const w of YES_WORDS) if (t.includes(w)) yesHits++;
  for (const w of NO_WORDS)  if (t.includes(w)) noHits++;
  if (yesHits === 0 && noHits === 0) return { lean: 'NEUTRAL', confidence: 0 };
  const total = yesHits + noHits;
  if (yesHits > noHits) {
    const confidence = Math.min(yesHits / total, 1);
    const opportunity = confidence > 0.5 && yesPrice < 0.40;
    return { lean: 'YES', confidence: Math.round(confidence * 100) / 100, opportunity };
  } else {
    const confidence = Math.min(noHits / total, 1);
    const opportunity = confidence > 0.5 && yesPrice > 0.60;
    return { lean: 'NO', confidence: Math.round(confidence * 100) / 100, opportunity };
  }
}

async function fetchNewsForMarket(market) {
  const cached = newsCache.get(market.id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.signal;

  if (!BRAVE_API_KEY) return null;

  const query = stripQuestion(market.question);
  if (!query || query.length < 5) return null;

  try {
    const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=5&freshness=pd`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) return null;

    let bestSignal = null;
    for (const article of results) {
      const text = `${article.title || ''} ${article.description || ''}`;
      const scored = scoreLean(text, market.yesPrice);
      if (scored.lean !== 'NEUTRAL' && (!bestSignal || scored.confidence > bestSignal.confidence)) {
        bestSignal = {
          headline: (article.title || '').slice(0, 100),
          source: article.meta_url?.hostname || article.url?.split('/')[2] || 'Unknown',
          url: article.url,
          publishedAt: article.page_age || null,
          ...scored,
        };
      }
    }

    // Fallback: use first article as NEUTRAL if no lean found
    if (!bestSignal) {
      const first = results[0];
      bestSignal = {
        headline: (first.title || '').slice(0, 100),
        source: first.meta_url?.hostname || 'Unknown',
        url: first.url,
        publishedAt: first.page_age || null,
        lean: 'NEUTRAL',
        confidence: 0,
        opportunity: false,
      };
    }

    newsCache.set(market.id, { signal: bestSignal, ts: Date.now() });
    return bestSignal;
  } catch(e) {
    return null;
  }
}

async function fetchNewsSignals(markets) {
  // Only fetch for top 60 by volume to avoid rate limits
  const top = [...markets].sort((a,b) => b.volume24hr - a.volume24hr).slice(0, 60);
  const results = await Promise.allSettled(top.map(m => fetchNewsForMarket(m)));
  const map = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) map.set(top[i].id, r.value);
  });
  return map;
}

module.exports = { fetchNewsSignals };
