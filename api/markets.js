const { getData } = require('./shared');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { markets } = await getData();
    const { search, category, sort, limit } = req.query;
    let results = [...markets];
    if (search) { const q = search.toLowerCase(); results = results.filter(m => m.question.toLowerCase().includes(q) || m.eventTitle.toLowerCase().includes(q)); }
    if (category && category !== 'All') results = results.filter(m => m.category === category);
    const sorters = {
      volume24hr:(a,b)=>b.volume24hr-a.volume24hr, endDate:(a,b)=>new Date(a.endDate)-new Date(b.endDate),
      liquidity:(a,b)=>b.liquidity-a.liquidity, edge:(a,b)=>b.edge-a.edge, newest:(a,b)=>new Date(b.endDate)-new Date(a.endDate),
    };
    if (sort && sorters[sort]) results.sort(sorters[sort]);
    results = results.slice(0, Math.min(parseInt(limit)||500, 2000));
    res.json({ markets: results, total: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
