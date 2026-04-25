const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com',
  'Origin': 'https://finance.yahoo.com',
};

// 获取股票现价
app.get('/api/quote/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
      if (!response.ok) continue;
      const data = await response.json();

      // v8/chart
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return res.json({
          ticker,
          price: meta.regularMarketPrice,
          prev: meta.chartPreviousClose || meta.previousClose,
          currency: meta.currency || 'USD',
          name: meta.longName || meta.shortName || ticker,
        });
      }

      // v7/quote
      const quote = data?.quoteResponse?.result?.[0];
      if (quote?.regularMarketPrice) {
        return res.json({
          ticker,
          price: quote.regularMarketPrice,
          prev: quote.regularMarketPreviousClose,
          currency: quote.currency || 'USD',
          name: quote.longName || quote.shortName || ticker,
        });
      }
    } catch (e) {
      continue;
    }
  }

  res.status(502).json({ error: `无法获取 ${ticker} 的数据` });
});

// 获取历史数据（走势图）
app.get('/api/history/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no data');
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const history = timestamps
      .map((t, i) => ({ date: new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }), price: closes[i] }))
      .filter(x => x.price != null);
    res.json(history);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 获取相关新闻
app.get('/api/news', async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.json([]);
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${tickers}&newsCount=8&enableFuzzyQuery=false&enableEnhancedTrivialQuery=true`;
  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    res.json(data?.news || []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// AI 分析
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: '服务器未配置 API Key' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    res.json({ text: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 所有其他路由返回前端页面
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`股票看板运行在端口 ${PORT}`);
});
