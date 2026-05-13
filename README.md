# 股票看板

个人股票持仓追踪工具，支持实时行情、AI 分析和多用户登录。


## 功能

- **持仓管理** — 添加、编辑、删除股票持仓，自动计算市值、盈亏
- **实时行情** — 每5分钟自动刷新现价和今日涨跌幅
- **30天走势图** — 点击任意股票查看近30天价格走势
- **AI 分析** — 由 GPT 每日自动分析持仓健康度，支持 GPT-5 / GPT-4.1 模型切换对比
- **行业动态** — 显示持仓相关的最新财经新闻
- **多用户** — 注册登录，每个用户数据独立隔离

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 前端 | 原生 HTML / CSS / JavaScript |
| 行情数据 | [Finnhub](https://finnhub.io)（现价、新闻） |
| 历史数据 | [Stooq](https://stooq.com)（30天走势） |
| AI 分析 | [OpenAI GPT-5 / GPT-4.1](https://openai.com) |
| 部署 | [Railway](https://railway.app) |
| 数据存储 | JSON 文件（Railway Volume 持久化） |

## 快速开始

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd stock-app
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env` 文件：

```env
FINNHUB_API_KEY=你的Finnhub密钥
OPENAI_API_KEY=你的OpenAI密钥
SESSION_SECRET=任意随机字符串
```

### 3. 启动

```bash
npm start
```

访问 `http://localhost:3000`，注册账号后开始使用。

## 部署到 Railway

### 1. 推送代码

```bash
git push origin main
```

### 2. 配置环境变量

在 Railway 项目 → **Variables** 中添加：

```
FINNHUB_API_KEY    = 你的Finnhub密钥
OPENAI_API_KEY     = 你的OpenAI密钥
SESSION_SECRET     = 任意随机字符串
DB_PATH            = /data/db.json
```

### 3. 添加持久化存储（防止重部署后用户数据丢失）

Railway 项目 → **New** → **Volume** → Mount Path 设为 `/data`

---

## 获取 API 密钥

| 服务 | 地址 | 免费额度 |
|------|------|----------|
| Finnhub | https://finnhub.io | 60次/分钟 |
| OpenAI | https://platform.openai.com | 按量计费 |

## 项目结构

```
stock-app/
├── server.js        # Express 后端，API 路由
├── public/
│   └── index.html   # 前端单页应用
├── package.json
└── db.json          # 用户数据（本地运行时自动生成，不提交到 git）
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录 |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 当前登录用户 |
| GET | `/api/holdings` | 获取持仓列表 |
| POST | `/api/holdings` | 添加持仓 |
| PUT | `/api/holdings/:ticker` | 编辑持仓 |
| DELETE | `/api/holdings/:ticker` | 删除持仓 |
| GET | `/api/quote/:ticker` | 获取股票现价 |
| GET | `/api/history/:ticker` | 获取30天历史数据 |
| GET | `/api/news` | 获取相关新闻 |
| POST | `/api/analyze` | AI 分析持仓 |
