const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { users: {} }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Finnhub API helper
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

async function finnhub(path) {
  if (!FINNHUB_KEY) throw new Error('未配置 FINNHUB_API_KEY');
  const res = await fetch(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return res.json();
}

app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'stock-app-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  next();
}

// 注册
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const db = loadDB();
  if (db.users[username]) return res.status(409).json({ error: '用户名已存在' });
  const hash = await bcrypt.hash(password, 10);
  db.users[username] = { password: hash, holdings: [], createdAt: Date.now() };
  saveDB(db);
  req.session.userId = username;
  res.json({ username });
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  const db = loadDB();
  const user = db.users[username];
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
  req.session.userId = username;
  res.json({ username });
});

// 退出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// 当前用户
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: req.session.userId });
});

// 获取持仓
app.get('/api/holdings', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.users[req.session.userId]?.holdings || []);
});

// 添加持仓
app.post('/api/holdings', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users[req.session.userId];
  if (!user) return res.status(401).json({ error: '用户不存在' });
  const { ticker, name, shares, cost, sector } = req.body;
  if (!ticker || !shares || !cost) return res.status(400).json({ error: '参数不完整' });
  if (user.holdings.find(h => h.ticker === ticker)) return res.status(409).json({ error: '该股票已在持仓中' });
  user.holdings.push({ ticker, name: name || ticker, shares, cost, sector: sector || '未分类', addedAt: Date.now() });
  saveDB(db);
  res.json(user.holdings);
});

// 删除持仓
app.delete('/api/holdings/:ticker', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users[req.session.userId];
  if (!user) return res.status(401).json({ error: '用户不存在' });
  user.holdings = user.holdings.filter(h => h.ticker !== req.params.ticker);
  saveDB(db);
  res.json(user.holdings);
});

// 获取股票现价
app.get('/api/quote/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  try {
    const data = await finnhub(`/quote?symbol=${ticker}`);
    if (!data.c || data.c === 0) return res.status(404).json({ error: `无法获取 ${ticker} 的数据` });
    res.json({ ticker, price: data.c, prev: data.pc, currency: 'USD', name: ticker });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 获取历史数据（走势图）
app.get('/api/history/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 24 * 60 * 60;
  try {
    const data = await finnhub(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`);
    if (data.s !== 'ok' || !data.c) return res.json([]);
    const history = data.t.map((t, i) => ({
      date: new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
      price: data.c[i],
    })).filter(x => x.price != null);
    res.json(history);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 获取新闻
app.get('/api/news', requireAuth, async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.json([]);
  const tickerList = tickers.split(',').slice(0, 3);
  const toDate = new Date().toISOString().split('T')[0];
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const results = await Promise.all(
      tickerList.map(t => finnhub(`/company-news?symbol=${t}&from=${fromDate}&to=${toDate}`).catch(() => []))
    );
    const news = results.flat()
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 8)
      .map(n => ({
        title: n.headline,
        link: n.url,
        publisher: n.source,
        providerPublishTime: n.datetime,
        relatedTickers: [n.related || tickerList[0]],
      }));
    res.json(news);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// AI 分析
app.post('/api/analyze', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: '服务器未配置 ANTHROPIC_API_KEY' });
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
