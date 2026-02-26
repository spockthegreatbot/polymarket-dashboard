const { getData } = require('./shared');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { stats } = await getData();
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
