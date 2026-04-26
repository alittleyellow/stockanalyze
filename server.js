const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'db.json');

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

// 获取历史数据（走势图）—— Finnhub 优先，stooq 备用
app.get('/api/history/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 31 * 24 * 60 * 60;

  // 优先：Finnhub candles（跟现价同一 API，云服务器可靠）
  try {
    const data = await finnhub(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`);
    if (data.s === 'ok' && Array.isArray(data.c) && data.c.length > 0) {
      const history = data.t.map((t, i) => ({
        date: new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
        price: data.c[i],
      })).filter(x => x.price > 0);
      return res.json(history);
    }
    console.log(`Finnhub candle ${ticker}: s=${data.s}, points=${data.c?.length ?? 0}`);
  } catch (e) {
    console.error(`Finnhub candle ${ticker}:`, e.message);
  }

  // 备用：stooq CSV
  try {
    const toDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const fromDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');
    const url = `https://stooq.com/q/d/l/?s=${ticker.toUpperCase()}.US&d1=${fromDate}&d2=${toDate}&i=d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 12000,
    });
    if (!r.ok) throw new Error(`stooq ${r.status}`);
    const csv = await r.text();
    console.log(`Stooq ${ticker} raw(200):`, csv.substring(0, 200));

    const lines = csv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.json([]);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const closeIdx = headers.indexOf('close');
    if (closeIdx === -1) {
      console.error(`Stooq ${ticker} no close col, headers:`, headers);
      return res.json([]);
    }

    const history = lines.slice(1).map(line => {
      const parts = line.split(',');
      const dateStr = parts[0]?.trim();
      const close = parseFloat(parts[closeIdx]);
      if (!dateStr || isNaN(close) || close < 0.5) return null;
      return {
        date: new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
        price: close,
      };
    }).filter(Boolean);

    return res.json(history);
  } catch (e) {
    console.error(`Stooq ${ticker}:`, e.message);
    res.status(502).json({ error: '历史数据暂时不可用' });
  }
});

// 编辑持仓
app.put('/api/holdings/:ticker', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users[req.session.userId];
  if (!user) return res.status(401).json({ error: '用户不存在' });
  const h = user.holdings.find(h => h.ticker === req.params.ticker);
  if (!h) return res.status(404).json({ error: '持仓不存在' });
  const { name, shares, cost, sector } = req.body;
  if (name !== undefined) h.name = name || req.params.ticker;
  if (shares !== undefined) h.shares = shares;
  if (cost !== undefined) h.cost = cost;
  if (sector !== undefined) h.sector = sector || '未分类';
  saveDB(db);
  res.json(user.holdings);
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

// AI 聊天 — 每日次数限制
const DAILY_CHAT_LIMIT = parseInt(process.env.DAILY_CHAT_LIMIT || '10');

app.get('/api/chat/remaining', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users[req.session.userId];
  const today = new Date().toDateString();
  if (!user.chatUsage || user.chatUsage.date !== today) return res.json({ remaining: DAILY_CHAT_LIMIT });
  res.json({ remaining: Math.max(0, DAILY_CHAT_LIMIT - user.chatUsage.count) });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: '服务器未配置 API Key' });

  const { message, history } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '消息不能为空' });

  const db = loadDB();
  const user = db.users[req.session.userId];
  const today = new Date().toDateString();

  if (!user.chatUsage || user.chatUsage.date !== today) user.chatUsage = { date: today, count: 0 };
  if (user.chatUsage.count >= DAILY_CHAT_LIMIT) {
    return res.status(429).json({ error: `今日 ${DAILY_CHAT_LIMIT} 次已用完，明天再来 😊`, remaining: 0 });
  }

  user.chatUsage.count++;
  saveDB(db);
  const remaining = DAILY_CHAT_LIMIT - user.chatUsage.count;

  const portfolioCtx = user.holdings?.length
    ? '用户持仓：' + user.holdings.map(h => `${h.ticker} ${h.shares}股 成本$${h.cost}`).join('，')
    : '用户暂无持仓';

  const messages = [...(Array.isArray(history) ? history.slice(-10) : []), { role: 'user', content: message }];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: `你是专业的股票投资顾问。${portfolioCtx}。请用中文简洁回答，聚焦投资、股票、市场分析话题。`,
        messages,
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ text: data.content?.[0]?.text || '', remaining });
  } catch (e) {
    user.chatUsage.count--;
    saveDB(db);
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
