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

// 获取历史数据（走势图）—— Finnhub 优先，Twelve Data 备用
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '';

app.get('/api/history/:ticker', requireAuth, async (req, res) => {
  const { ticker } = req.params;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 31 * 24 * 60 * 60;

  // 优先：Finnhub candles
  try {
    const data = await finnhub(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`);
    if (data.s === 'ok' && Array.isArray(data.c) && data.c.length > 0) {
      const history = data.t.map((t, i) => ({
        date: new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
        price: data.c[i],
      })).filter(x => x.price > 0);
      if (history.length > 0) return res.json(history);
    }
  } catch (e) {
    console.error(`Finnhub candle ${ticker}:`, e.message);
  }

  // 备用：Twelve Data（免费 800次/天，云服务器无 IP 限制）
  if (TWELVE_DATA_KEY) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=31&apikey=${TWELVE_DATA_KEY}`;
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) throw new Error(`Twelve Data ${r.status}`);
      const data = await r.json();
      if (data.status === 'ok' && Array.isArray(data.values) && data.values.length > 0) {
        const history = [...data.values].reverse().map(v => ({
          date: new Date(v.datetime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
          price: parseFloat(v.close),
        })).filter(x => !isNaN(x.price) && x.price > 0);
        if (history.length > 0) return res.json(history);
      }
      console.error(`Twelve Data ${ticker}:`, data.message || data.status);
    } catch (e) {
      console.error(`Twelve Data ${ticker}:`, e.message);
    }
  }

  res.status(503).json({ error: '历史数据暂时不可用，请配置 TWELVE_DATA_KEY' });
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

// AI 统一调用helper — 优先 OpenAI，备用 Anthropic
async function callAI({ system, messages, maxTokens = 600, model, forceProvider }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const useOpenAI = forceProvider === 'openai' ? !!openaiKey :
                    forceProvider === 'anthropic' ? false : !!openaiKey;
  const useAnthropic = forceProvider === 'anthropic' ? !!anthropicKey :
                       forceProvider === 'openai' ? false : (!openaiKey && !!anthropicKey);

  if (forceProvider === 'openai' && !openaiKey) throw new Error('未配置 OPENAI_API_KEY');
  if (forceProvider === 'anthropic' && !anthropicKey) throw new Error('未配置 ANTHROPIC_API_KEY');

  if (useOpenAI) {
    const finalModel = model || (forceProvider === 'openai' ? 'gpt-4o' : (process.env.CHAT_MODEL || 'gpt-4o-mini'));
    const fullMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: finalModel, max_tokens: maxTokens, messages: fullMessages }),
      timeout: 30000,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || '';
  }

  if (useAnthropic) {
    const finalModel = model || (forceProvider === 'anthropic' ? 'claude-sonnet-4-6' : (process.env.CHAT_MODEL || 'claude-sonnet-4-6'));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: finalModel, max_tokens: maxTokens, ...(system ? { system } : {}), messages }),
      timeout: 30000,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text || '';
  }

  throw new Error('未配置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY');
}

// AI 聊天 — 每日次数限制
const DAILY_CHAT_LIMIT = parseInt(process.env.DAILY_CHAT_LIMIT || '50');

app.get('/api/chat/remaining', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users[req.session.userId];
  const today = new Date().toDateString();
  if (!user.chatUsage || user.chatUsage.date !== today) return res.json({ remaining: DAILY_CHAT_LIMIT });
  res.json({ remaining: Math.max(0, DAILY_CHAT_LIMIT - user.chatUsage.count) });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: '服务器未配置 AI API Key' });

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

  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }];

  try {
    const text = await callAI({
      system: `你是一个博学多才的 AI 助手，可以回答任何话题的问题。你也了解用户的投资组合：${portfolioCtx}。请用中文回答，语言简洁清晰。`,
      messages,
      maxTokens: 16000,
    });
    res.json({ text, remaining });
  } catch (e) {
    user.chatUsage.count--;
    saveDB(db);
    res.status(502).json({ error: e.message });
  }
});

// AI 分析
app.post('/api/analyze', requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: '服务器未配置 AI API Key' });
  const { prompt, provider } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt' });
  try {
    const analyzeModel = process.env.ANALYZE_MODEL ||
      (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
    const text = await callAI({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4000,
      model: analyzeModel,
      forceProvider: provider,
    });
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 当前 AI provider 信息
app.get('/api/ai-info', requireAuth, (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (openaiKey) {
    res.json({ provider: 'OpenAI', model: process.env.CHAT_MODEL || 'gpt-4o-mini' });
  } else if (anthropicKey) {
    res.json({ provider: 'Anthropic (Claude)', model: process.env.CHAT_MODEL || 'claude-sonnet-4-6' });
  } else {
    res.json({ provider: '未配置', model: null });
  }
});

// 所有其他路由返回前端页面
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`股票看板运行在端口 ${PORT}`);
});
