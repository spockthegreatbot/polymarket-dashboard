const { getData } = require('./shared');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { columns } = await getData();
    res.json(columns);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
