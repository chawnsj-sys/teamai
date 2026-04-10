require("dotenv").config();
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const multer = require('multer');
const crypto = require('crypto');
const cron = require("node-cron");
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3001;
const GATEWAY_URL = 'ws://localhost:3000';
const TOKEN = process.env.GATEWAY_TOKEN || '';
const HISTORY_DIR = path.join(__dirname, 'history');
const CHANNELS_FILE = path.join(HISTORY_DIR, 'channels.json');
const TASKS_FILE = path.join(HISTORY_DIR, 'tasks.json');
// --- TeamAI Configuration ---
const TEAMAI_CONFIG_PATH = path.join(__dirname, 'teamai-config.json');
function loadTeamAIConfig() {
  const defaults = {
    clawdbotConfig: process.env.CLAWDBOT_CONFIG || '/home/ubuntu/.clawdbot/clawdbot.json',
    agentsDir: process.env.AGENTS_DIR || '/home/ubuntu/clawd/agents',
    skillsDir: process.env.SKILLS_DIR || '/home/ubuntu/clawd/skills',
    clawdbotHome: process.env.CLAWDBOT_HOME || '/home/ubuntu/.clawdbot',
    wsPort: 3000,
    webPort: 3001
  };
  try {
    if (fs.existsSync(TEAMAI_CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(TEAMAI_CONFIG_PATH, 'utf8'));
      return { ...defaults, ...saved };
    }
  } catch (e) {}
  return defaults;
}
const TEAMAI_CFG = loadTeamAIConfig();
const CLAWDBOT_CONFIG = TEAMAI_CFG.clawdbotConfig;
const GLOBAL_SKILLS_DIR = TEAMAI_CFG.skillsDir;
const AGENTS_DIR = TEAMAI_CFG.agentsDir;
const GLOBAL_SOUL_PATH = path.join(TEAMAI_CFG.clawdbotHome, 'GLOBAL_SOUL.md');

// Assemble SOUL.md = Global + Private for one agent
function assembleSoul(agentId) {
  const globalSoul = fs.existsSync(GLOBAL_SOUL_PATH) ? fs.readFileSync(GLOBAL_SOUL_PATH, 'utf8').trim() : '';
  const privateFile = path.join(AGENTS_DIR, agentId, 'SOUL_PRIVATE.md');
  const privateSoul = fs.existsSync(privateFile) ? fs.readFileSync(privateFile, 'utf8').trim() : '';
  const memoryFile = path.join(AGENTS_DIR, agentId, 'MEMORY.md');
  const memoryMd = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8').trim() : '';
  const merged = [globalSoul, privateSoul, memoryMd ? '# 精选记忆\n' + memoryMd : ''].filter(Boolean).join('\n\n---\n\n');
  const soulFile = path.join(AGENTS_DIR, agentId, 'SOUL.md');
  if (merged) fs.writeFileSync(soulFile, merged);
  return merged;
}

// Assemble all agents
function assembleAllSouls() {
  if (!fs.existsSync(AGENTS_DIR)) return;
  fs.readdirSync(AGENTS_DIR).forEach(id => {
    const dir = path.join(AGENTS_DIR, id);
    if (fs.statSync(dir).isDirectory()) assembleSoul(id);
  });
}

const { storeMemory, searchMemory, listMemory, deleteMemoryRecord, updateMemoryRecord, createMemoryRecord } = require('./memory-helper');

// --- Neptune Analytics for Semantic Model ---
const { NeptuneGraphClient, ExecuteQueryCommand } = require('@aws-sdk/client-neptune-graph');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const neptuneClient = new NeptuneGraphClient({ region: 'us-east-1' });
const bedrockRtClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const GRAPH_ID = process.env.NEPTUNE_GRAPH_ID || '';

async function neptuneQuery(q) {
  const cmd = new ExecuteQueryCommand({ graphIdentifier: GRAPH_ID, queryString: q, language: 'OPEN_CYPHER' });
  const resp = await neptuneClient.send(cmd);
  const body = await new Response(resp.payload).text();
  return JSON.parse(body);
}
const { searchKnowledge, uploadKnowledge, deleteKnowledge, listKnowledge, syncKnowledge, upsertKnowledge } = require("./knowledge-helper");

// Load agents dynamically from clawdbot.json
const AGENT_DEFAULT_COLORS = ['#4fc3f7','#f0883e','#e94560','#7c4dff','#22c55e','#d29922','#bc8cff','#3b82f6','#ef4444','#14b8a6'];
function loadAgents() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8'));
    return (cfg.agents?.list || []).map((a, i) => {
      const modelName = (a.model?.primary || '').split('/').pop().replace(/^us\.anthropic\./, '').replace(/-v\d.*$/, '').replace(/-\d{8}$/, '');
      return { id: a.id, name: a.name || a.id, color: AGENT_DEFAULT_COLORS[i % AGENT_DEFAULT_COLORS.length], icon: '🤖', model: modelName };
    });
  } catch (e) { return []; }
}
const AGENTS = loadAgents();

// Read agent display name and emoji from IDENTITY.md
function readAgentIdentity(agentId) {
  try {
    const idFile = path.join(AGENTS_DIR, agentId, 'IDENTITY.md');
    if (!fs.existsSync(idFile)) return {};
    const content = fs.readFileSync(idFile, 'utf8');
    const result = {};
    const nameMatch = content.match(/名字[：:]\s*(.+)/);
    if (nameMatch) result.name = nameMatch[1].trim();
    const emojiMatch = content.match(/emoji[：:]\s*(.+)/);
    if (emojiMatch) result.emoji = emojiMatch[1].trim();
    return result;
  } catch (e) { return {}; }
}
function readAgentName(agentId) { return readAgentIdentity(agentId).name; }

// Enrich AGENTS with names from IDENTITY.md
AGENTS.forEach(a => {
  const identity = readAgentIdentity(a.id);
  if (identity.emoji) a.icon = identity.emoji;
  const name = identity.name;
  if (name) {
    // Use name from IDENTITY.md as-is if it contains parentheses
    // Otherwise append the original suffix
    if (name.includes('(')) {
      a.name = name;
    } else {
      const suffix = a.name.match(/\(.*\)/);
      a.name = name + (suffix ? ' ' + suffix[0] : '');
    }
  }
});

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

function cleanReplyText(t) { return t ? t.replace(/\[\[reply_to[^\]]*\]?\]?/g, '').trim() : ''; }

// Get latest token usage from clawdbot session files
function getLatestUsage(agentId) {
  try {
    const sessDir = path.join(TEAMAI_CFG.clawdbotHome, 'agents', agentId, 'sessions');
    if (!fs.existsSync(sessDir)) return null;
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const content = fs.readFileSync(path.join(sessDir, files[0].name), 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.message?.usage) {
          const u = entry.message.usage;
          return { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, total: u.totalTokens || 0 };
        }
      } catch (e) {}
    }
    return null;
  } catch (e) { return null; }
}

// --- Channel mgmt ---
function loadChannels() {
  if (fs.existsSync(CHANNELS_FILE)) { try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); } catch (e) {} }
  const d = [
    { id: 'group-001', name: '默认群聊', type: 'group', agents: AGENTS.map(a => a.id), mode: 'private' },
    ...AGENTS.map(a => ({ id: 'dm-' + a.id, name: a.name + ' 私聊', type: 'dm', agent: a.id }))
  ];
  saveChannels(d); return d;
}
function saveChannels(c) { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(c, null, 2)); }
function appendHistory(id, msg) { fs.appendFileSync(path.join(HISTORY_DIR, 'ch-' + id + '.jsonl'), JSON.stringify({ ...msg, ts: Date.now() }) + '\n'); }
function loadHistory(id, limit = 100) {
  const f = path.join(HISTORY_DIR, 'ch-' + id + '.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// --- Task mgmt ---
let taskIdCounter = 0;
const activeTasks = new Map();
function loadTasks() { if (fs.existsSync(TASKS_FILE)) { try { const d = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); taskIdCounter = d.counter || 0; (d.tasks || []).forEach(t => activeTasks.set(t.id, t)); } catch (e) {} } }
function saveTasks() { fs.writeFileSync(TASKS_FILE, JSON.stringify({ counter: taskIdCounter, tasks: [...activeTasks.values()], schedules: schedules }, null, 2)); }
loadTasks();

// --- Schedule mgmt ---
const SCHEDULES_FILE = path.join(HISTORY_DIR, 'schedules.json');
let schedules = [];
const cronJobs = new Map();

function loadSchedules() {
  if (fs.existsSync(SCHEDULES_FILE)) { try { schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); } catch (e) { schedules = []; } }
}
function saveSchedules() { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2)); }
loadSchedules();

// Schedule executor - needs agentConns from WebSocket, set up after connection
let scheduleAgentConns = null;
let scheduleClientWs = null;

function startScheduleJob(sch) {
  if (cronJobs.has(sch.id)) { cronJobs.get(sch.id).stop(); cronJobs.delete(sch.id); }
  if (!sch.enabled || !cron.validate(sch.cron)) return;
  const job = cron.schedule(sch.cron, () => {
    if (!scheduleAgentConns) { console.log('[sched] no agent connections'); return; }
    const conn = scheduleAgentConns.get(sch.agent);
    if (!conn || !conn.authenticated) {
      console.log('[sched] agent ' + sch.agent + ' offline, recording failure');
      sch.lastRun = Date.now(); sch.lastStatus = 'failed'; sch.lastError = 'agent offline'; saveSchedules();
      appendHistory(sch.channel, { type: 'user', text: '⏰ 定时任务失败: ' + sch.name + ' (agent离线)', targets: [sch.agent], scheduled: true });
      wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'hint', text: '⏰ ' + sch.name + ' 失败: agent离线' })); } catch(e){} });
      return;
    }
    console.log('[sched] running: ' + sch.id + ' agent=' + sch.agent);
    sch.lastRun = Date.now(); sch.lastStatus = 'ok'; sch.lastError = ''; saveSchedules();
    const sysMsg = '⏰ 定时任务: ' + sch.name;
    appendHistory(sch.channel, { type: 'user', text: sysMsg, targets: [sch.agent], scheduled: true });
    wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'user', text: sysMsg, channel: sch.channel, targets: [sch.agent] })); } catch(e){} });
    conn.sendMessage(sch.prompt, sch.channel, null, { scheduled: true });
  }, { timezone: 'Asia/Shanghai' });
  cronJobs.set(sch.id, job);
}

function initAllSchedules() {
  cronJobs.forEach(j => j.stop()); cronJobs.clear();
  schedules.filter(s => s.enabled).forEach(s => startScheduleJob(s));
  console.log('[sched] initialized ' + cronJobs.size + ' jobs');
}

// --- REST APIs ---
// Basic auth for TeamAI
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || '';

app.use((req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health') return next();
  // Skip auth for localhost API calls (internal agent use)
  const ip = req.ip || req.connection.remoteAddress || '';
  if ((ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && req.path.startsWith('/api/')) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="TeamAI"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="TeamAI"');
  res.status(401).send('Invalid credentials');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
// --- File upload ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 150 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|pdf|doc|docx|txt|csv|xlsx|zip)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});
app.use('/uploads', express.static(UPLOADS_DIR));
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(req.file.originalname);
  const isVideo = /\.(mp4|mov|webm)$/i.test(req.file.originalname);
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    url: '/uploads/' + req.file.filename,
    type: isImage ? 'image' : isVideo ? 'video' : 'file'
  });
});
app.get('/api/channels', (req, res) => res.json(loadChannels()));
app.post('/api/channels', (req, res) => { const chs = loadChannels(); const { name, type, agents, agent, mode } = req.body; const id = (type === 'group' ? 'group-' : 'dm-') + Date.now().toString(36); const ch = { id, name, type, ...(type === 'group' ? { agents: agents || AGENTS.map(a => a.id), mode: mode || 'private' } : { agent }) }; chs.push(ch); saveChannels(chs); res.json(ch); });
app.put('/api/channels/:id', (req, res) => { const chs = loadChannels(); const ch = chs.find(c => c.id === req.params.id); if (!ch) return res.status(404).json({ error: 'not found' }); if (req.body.name) ch.name = req.body.name; saveChannels(chs); res.json(ch); });
app.put('/api/channel-mode/:id', (req, res) => { const chs = loadChannels(); const ch = chs.find(c => c.id === req.params.id); if (!ch) return res.status(404).json({ error: 'not found' }); ch.mode = req.body.mode || 'private'; saveChannels(chs); res.json(ch); });
app.put('/api/channels/:id/members', (req, res) => { const chs = loadChannels(); const ch = chs.find(c => c.id === req.params.id); if (!ch) return res.status(404).json({ error: 'not found' }); if (req.body.agents) ch.agents = req.body.agents; saveChannels(chs); res.json(ch); });
app.delete('/api/channels/:id', (req, res) => { const chs = loadChannels(); const idx = chs.findIndex(c => c.id === req.params.id); if (idx === -1) return res.status(404).json({ error: 'not found' }); chs.splice(idx, 1); saveChannels(chs); const hf = path.join(HISTORY_DIR, 'ch-' + req.params.id + '.jsonl'); if (fs.existsSync(hf)) fs.unlinkSync(hf); res.json({ ok: true }); });
app.get('/api/history/:id', (req, res) => res.json(loadHistory(req.params.id, parseInt(req.query.limit) || 100)));
app.delete('/api/history/:id', (req, res) => { const f = path.join(HISTORY_DIR, 'ch-' + req.params.id + '.jsonl'); if (fs.existsSync(f)) fs.unlinkSync(f); res.json({ ok: true }); });
app.delete('/api/agent-memory/:id', (req, res) => { const d = path.join(TEAMAI_CFG.clawdbotHome, 'agents', req.params.id, 'sessions'); if (fs.existsSync(d)) fs.readdirSync(d).forEach(f => { try { fs.unlinkSync(path.join(d, f)); } catch (e) {} }); res.json({ ok: true }); });
app.get('/api/tasks', (req, res) => res.json([...activeTasks.values()]));
app.get('/api/schedules', (req, res) => res.json(schedules));
app.post('/api/schedules', (req, res) => {
  const { name, agent, channel, cronExpr, prompt, enabled } = req.body;
  if (!name || !agent || !channel || !cronExpr || !prompt) return res.status(400).json({ error: 'missing fields' });
  if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'invalid cron' });
  const sch = { id: 'sch-' + Date.now().toString(36), name, agent, channel, cron: cronExpr, prompt, enabled: enabled !== false, lastRun: null, createdAt: Date.now() };
  schedules.push(sch); saveSchedules(); startScheduleJob(sch);
  res.json(sch);
});
app.put('/api/schedules/:id', (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ error: 'not found' });
  const { name, agent, channel, cronExpr, prompt, enabled } = req.body;
  if (name !== undefined) sch.name = name;
  if (agent !== undefined) sch.agent = agent;
  if (channel !== undefined) sch.channel = channel;
  if (cronExpr !== undefined) { if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'invalid cron' }); sch.cron = cronExpr; }
  if (prompt !== undefined) sch.prompt = prompt;
  if (enabled !== undefined) sch.enabled = enabled;
  saveSchedules(); startScheduleJob(sch);
  res.json(sch);
});
app.delete('/api/schedules/:id', (req, res) => {
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (cronJobs.has(req.params.id)) { cronJobs.get(req.params.id).stop(); cronJobs.delete(req.params.id); }
  schedules.splice(idx, 1); saveSchedules();
  res.json({ ok: true });
});
app.post('/api/schedules/:id/run', (req, res) => {
  const sch = schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ error: 'not found' });
  if (!scheduleAgentConns) return res.status(503).json({ error: 'not connected' });
  const conn = scheduleAgentConns.get(sch.agent);
  if (!conn || !conn.authenticated) return res.status(503).json({ error: 'agent offline' });
  console.log('[sched] manual run: ' + sch.id + ' agent=' + sch.agent);
  sch.lastRun = Date.now(); saveSchedules();
  const sysMsg = '⏰ 手动测试: ' + sch.name;
  appendHistory(sch.channel, { type: 'user', text: sysMsg, targets: [sch.agent], scheduled: true });
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'user', text: sysMsg, channel: sch.channel, targets: [sch.agent] })); } catch(e){} });
  conn.sendMessage(sch.prompt, sch.channel, null, { scheduled: true });
  res.json({ ok: true });
});
app.get('/api/skills', (req, res) => { if (!fs.existsSync(GLOBAL_SKILLS_DIR)) return res.json([]); res.json(fs.readdirSync(GLOBAL_SKILLS_DIR).filter(f => fs.existsSync(path.join(GLOBAL_SKILLS_DIR, f, 'SKILL.md')))); });
const kbUpload = multer({ storage: multer.diskStorage({ destination: UPLOADS_DIR, filename: (req, file, cb) => { cb(null, Date.now().toString(36) + "-" + require("crypto").randomBytes(4).toString("hex") + (require("path").extname(file.originalname) || "")); } }), limits: { fileSize: 150 * 1024 * 1024 } });
app.get('/api/knowledge/:agentId', async (req, res) => {
  try { res.json(await listKnowledge(req.params.agentId)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/knowledge/:agentId', kbUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const content = fs.readFileSync(req.file.path);
    const origName = Buffer.from(req.file.originalname, "latin1").toString("utf8"); await uploadKnowledge(req.params.agentId, origName, content);
    fs.unlinkSync(req.file.path);
    const jobId = await syncKnowledge();
    res.json({ ok: true, filename: req.file.originalname, jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/knowledge/:agentId/:filename', async (req, res) => {
  try {
    await deleteKnowledge(req.params.agentId, req.params.filename);
    await syncKnowledge();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/knowledge/:agentId', express.json(), async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });
  try {
    await upsertKnowledge(req.params.agentId, filename, Buffer.from(content, 'utf8'));
    const jobId = await syncKnowledge();
    res.json({ ok: true, filename, jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Chat API for external MCP access ---
app.post('/api/chat/:agentId', express.json(), async (req, res) => {
  const agentId = req.params.agentId;
  const { message, timeout } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!scheduleAgentConns) return res.status(503).json({ error: 'not connected' });
  const conn = scheduleAgentConns.get(agentId);
  if (!conn || !conn.authenticated) return res.status(503).json({ error: 'agent ' + agentId + ' offline' });

  const channel = 'api-' + agentId;
  const maxTimeout = Math.min(timeout || 120000, 300000);

  // Search KB + Memory (same as sendMessage flow)
  let enrichedMessage = message;
  try {
    const [memories, kbResults] = await Promise.all([
      Promise.race([searchMemory(agentId, message, 3), new Promise(r => setTimeout(() => r([]), 5000))]),
      Promise.race([searchKnowledge(agentId, message, 3), new Promise(r => setTimeout(() => r([]), 5000))])
    ]);
    if (memories.length > 0) {
      const ctx = memories.map(m => m.text).join('\n---\n');
      enrichedMessage = '[历史记忆]\n' + ctx + '\n\n' + enrichedMessage;
    }
    if (kbResults.length > 0) {
      const kbCtx = kbResults.map(r => r.text).join('\n---\n');
      enrichedMessage = '[知识库]\n' + kbCtx + '\n\n' + enrichedMessage;
    }
    console.log('[api] ' + agentId + ' memory=' + memories.length + ' kb=' + kbResults.length);
  } catch (e) {}

  // Send and wait for reply
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), maxTimeout);
      conn.sendMessage(enrichedMessage, channel, (result) => {
        clearTimeout(timer);
        if (result && result.__redirect) {
          resolve({ redirect: true, from: agentId, suggest: result.suggest, reason: result.reason });
        } else {
          resolve({ text: typeof result === 'string' ? result : (result?.text || String(result)) });
        }
      });
    });
    console.log('[api] ' + agentId + ' replied, len=' + (reply.text || '').length);
    res.json({ agent: agentId, ...reply });
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

app.post('/api/memory-governance/preview-classify', express.json(), async (req, res) => {
  try {
    const { agentId, memoryText, prompt } = req.body;
    const fetch = (await import('node-fetch')).default;
    const resp = await fetch('http://localhost:3005/preview-classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, memoryText, prompt })
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.json({ type: 'error', error: e.message });
  }
});


// --- Analyze Intent API (需求理解确认) ---
app.post('/api/analyze-intent', express.json(), async (req, res) => {
  const { message, agentId, context, previousItems } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const aid = agentId || 'aws-expert';

  try {
    // Get rule memories
    const rules = [];
    try {
      const records = await searchMemory(aid, message, 5);
      (records || []).forEach(r => {
        const type = r.metadata && r.metadata.type;
        if (type === 'rule' || type === 'preference') {
          rules.push({ text: r.text, type: type, score: r.score });
        }
      });
    } catch(e) {}

    // Call Python helper via stdin/stdout (avoids shell escaping issues)
    const { execSync } = require('child_process');
    const input = JSON.stringify({ question: message, rules: rules, context: context || [], previousItems: previousItems || [], agentId: aid });
    const result = execSync('python3 ' + path.join(__dirname, 'intent-helper.py') + '', {
      input: input,
      timeout: 90000,
      encoding: 'utf8'
    });
    const analysis = JSON.parse(result.trim());
    res.json(analysis);
  } catch (e) {
    console.error('[analyze-intent]', e.message);
    res.json({ items: [{ label: '分析需求', value: message, source: 'infer' }], raw: message });
  }
});

app.get('/api/models', (req, res) => { try { const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8')); const models = []; const providers = cfg.models?.providers || {}; for (const [p, pc] of Object.entries(providers)) (pc.models || []).forEach(m => models.push({ id: p + '/' + m.id, name: m.name || m.id })); const def = cfg.agents?.defaults?.model?.primary || ''; if (def) {
      const defModel = models.find(m => m.id === def);
      const defName = defModel ? defModel.name : def.split('/').pop();
      models.unshift({ id: '', name: '默认 (' + defName + ')' });
    } res.json(models); } catch (e) { res.json([]); } });
app.get('/api/agent-config/:id', (req, res) => {
  const id = req.params.id, dir = path.join(AGENTS_DIR, id);
  const readMd = n => { const f = path.join(dir, n); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  let model = ''; try { const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8')); const ac = (cfg.agents?.list || []).find(a => a.id === id); model = ac?.model?.primary || cfg.agents?.defaults?.model?.primary || ''; } catch (e) {}
  const sd = path.join(dir, 'skills'); let enabledSkills = [];
  if (fs.existsSync(sd)) enabledSkills = fs.readdirSync(sd).filter(f => { try { return fs.lstatSync(path.join(sd, f)).isSymbolicLink(); } catch (e) { return false; } });
  const privateSoul = readMd('SOUL_PRIVATE.md') || readMd('SOUL.md');
  res.json({ soul: privateSoul, identity: readMd('IDENTITY.md'), tools: readMd('TOOLS.md'), memory: readMd('MEMORY.md'), model, enabledSkills });
});
app.put('/api/agent-config/:id', (req, res) => {
  const id = req.params.id, dir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { soul, identity, tools, model, enabledSkills } = req.body;
  if (soul !== undefined) {
    fs.writeFileSync(path.join(dir, 'SOUL_PRIVATE.md'), soul);
    assembleSoul(id);
  }
  if (identity !== undefined) fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identity);
  if (tools !== undefined) fs.writeFileSync(path.join(dir, 'TOOLS.md'), tools);
  if (req.body.memory !== undefined) { fs.writeFileSync(path.join(dir, 'MEMORY.md'), req.body.memory); assembleSoul(id); }
  if (model !== undefined) { try { const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8')); const ac = (cfg.agents?.list || []).find(a => a.id === id); if (ac) { if (model) ac.model = { primary: model }; else delete ac.model; fs.writeFileSync(CLAWDBOT_CONFIG, JSON.stringify(cfg, null, 2)); } } catch (e) {} }
  if (enabledSkills !== undefined) { const sd = path.join(dir, 'skills'); if (!fs.existsSync(sd)) fs.mkdirSync(sd, { recursive: true }); fs.readdirSync(sd).forEach(f => { const fp = path.join(sd, f); try { if (fs.lstatSync(fp).isSymbolicLink()) fs.unlinkSync(fp); } catch (e) {} }); enabledSkills.forEach(s => { const src = path.join(GLOBAL_SKILLS_DIR, s), dst = path.join(sd, s); if (fs.existsSync(src)) { try { fs.symlinkSync(src, dst); } catch (e) {} } }); }
  res.json({ ok: true });
});


// --- Create Agent API ---
const AGENT_COLORS = ['#4fc3f7','#f0883e','#e94560','#7c4dff','#22c55e','#d29922','#bc8cff','#3b82f6','#ef4444','#14b8a6'];
app.post('/api/agents', express.json(), (req, res) => {
  const { id, name, role, emoji, model } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  // Check if agent already exists
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8'));
    if ((cfg.agents?.list || []).find(a => a.id === id)) return res.status(400).json({ error: 'Agent ID already exists' });
    // 1. Add to clawdbot.json
    const agentDir = path.join(TEAMAI_CFG.agentsDir, id);
    const defaultModel = cfg.agents?.defaults?.model?.primary || '';
    cfg.agents.list.push({
      id,
      name,
      workspace: agentDir,
      model: { primary: model || defaultModel }
    });
    fs.writeFileSync(CLAWDBOT_CONFIG, JSON.stringify(cfg, null, 2));
    // 2. Create agent directory + files
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    const soulContent = '# ' + name + '\n\n你是' + (role || name) + '。\n';
    fs.writeFileSync(path.join(agentDir, 'SOUL_PRIVATE.md'), soulContent);
    assembleSoul(id);
    const identityContent = '# Identity\n\n- 名字：' + name + '\n- 角色：' + (role || '') + '\n- emoji：' + (emoji || '🤖') + '\n';
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), identityContent);
    fs.writeFileSync(path.join(agentDir, 'TOOLS.md'), '# TOOLS.md\n');
    // 3. Create DM channel
    const chs = loadChannels();
    if (!chs.find(c => c.type === 'dm' && c.agent === id)) {
      chs.push({ id: 'dm-' + id, name: name + ' 私聊', type: 'dm', agent: id });
      saveChannels(chs);
    }
    // 4. Add to group channels
    chs.filter(c => c.type === 'group').forEach(c => {
      if (c.agents && !c.agents.includes(id)) c.agents.push(id);
    });
    saveChannels(chs);
    res.json({ ok: true, id, message: 'Agent created. Server will restart.' });
    // 5. Restart server after short delay
    setTimeout(() => { console.log('[create-agent] restarting...'); process.exit(0); }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Delete Agent API ---
app.delete('/api/agents/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'main' || id === 'pm') return res.status(400).json({ error: 'Cannot delete core agents' });
  try {
    // 1. Remove from clawdbot.json
    const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8'));
    const idx = (cfg.agents?.list || []).findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Agent not found' });
    cfg.agents.list.splice(idx, 1);
    fs.writeFileSync(CLAWDBOT_CONFIG, JSON.stringify(cfg, null, 2));
    // 2. Remove DM channel and clean up group memberships
    const chs = loadChannels();
    const filtered = chs.filter(c => !(c.type === 'dm' && c.agent === id));
    filtered.filter(c => c.type === 'group' && c.agents).forEach(c => {
      c.agents = c.agents.filter(a => a !== id);
    });
    saveChannels(filtered);
    // 3. Delete DM history
    const hf = path.join(HISTORY_DIR, 'ch-dm-' + id + '.jsonl');
    if (fs.existsSync(hf)) fs.unlinkSync(hf);
    // 4. Rename agent dir (soft delete, keep data)
    const agentDir = path.join(TEAMAI_CFG.agentsDir, id);
    const deletedDir = path.join(TEAMAI_CFG.agentsDir, id + '.deleted.' + Date.now());
    if (fs.existsSync(agentDir)) fs.renameSync(agentDir, deletedDir);
    res.json({ ok: true, message: 'Agent deleted. Server will restart.' });
    // 5. Restart
    setTimeout(() => { console.log('[delete-agent] restarting...'); process.exit(0); }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- TeamAI Path Config API ---
app.get('/api/teamai-config', (req, res) => {
  res.json(loadTeamAIConfig());
});
app.put('/api/teamai-config', express.json(), (req, res) => {
  const current = loadTeamAIConfig();
  const updated = { ...current, ...req.body };
  fs.writeFileSync(TEAMAI_CONFIG_PATH, JSON.stringify(updated, null, 2));
  res.json({ ok: true, note: 'Restart server to apply path changes' });
});

// --- Global Config API ---
app.get('/api/global-config', (req, res) => {
  const soul = fs.existsSync(GLOBAL_SOUL_PATH) ? fs.readFileSync(GLOBAL_SOUL_PATH, 'utf8') : '';
  res.json({ globalSoul: soul });
});
app.put('/api/global-config', express.json(), (req, res) => {
  const { globalSoul } = req.body;
  if (globalSoul !== undefined) {
    fs.writeFileSync(GLOBAL_SOUL_PATH, globalSoul);
    assembleAllSouls();
  }
  res.json({ ok: true });
});

// --- AgentConnection with pendingMap for concurrency ---
class AgentConnection {
  constructor(agentId, clientWs) {
    this.agentId = agentId;
    this.clientWs = clientWs;
    this.ws = null;
    this.authenticated = false;
    this.requestId = 0;
    this.status = 'offline';
    this._statusCb = null;
    this._orchestrator = null;
    // pendingMap: sessionKey -> { channel, buffer, onReply, onRedirect }
    this.pendingMap = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GATEWAY_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
      this.ws.on('open', () => {});
      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            this.ws.send(JSON.stringify({ type: 'req', id: '0', method: 'connect', params: { minProtocol: 3, maxProtocol: 3, client: { id: 'webchat', version: '1.0.0', platform: 'node', mode: 'webchat' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], caps: [], commands: [], permissions: {}, auth: { token: TOKEN }, locale: 'zh-CN', userAgent: 'mc-' + this.agentId } }));
            return;
          }
          if (msg.type === 'res' && msg.id === '0') { if (msg.ok) { this.authenticated = true; this.status = 'online'; resolve(); } else reject(new Error('Auth failed')); return; }
          if (msg.type === 'res' && msg.id !== '0') return;

          // Agent events
          if (msg.type === 'event' && msg.event === 'agent') {
            console.log('[ws-evt] ' + this.agentId + ' agent event session=' + (msg.payload?.sessionKey||'') + ' stream=' + (msg.payload?.stream||''));
            const evtSession = msg.payload?.sessionKey || '';
            if (!evtSession.startsWith('agent:' + this.agentId + ':')) return;
            const pending = this._findPending(evtSession);
            if (!pending) return;
            const { stream, data: d } = msg.payload || {};
            this.send({ type: 'process', agent: this.agentId, channel: pending.channel, stream, data: d });
            if (stream === 'content' || stream === 'assistant') { const delta = d?.delta || d?.text || d?.content; if (delta) pending.buffer += delta; }
            if (stream === 'lifecycle' && d?.phase === 'start') { this.status = 'thinking'; this.broadcastStatus(); }

            if (stream === 'tool') { this.status = 'working'; this.broadcastStatus(); pending.toolCount = (pending.toolCount || 0) + 1; }
            // Fallback for agents with multi-round tool calls (e.g. cortex CLI):
            // After lifecycle end, wait 15s then read final reply from session jsonl
            if (stream === 'lifecycle' && d?.phase === 'end' && pending) {
              if (pending._fallbackTimer) clearTimeout(pending._fallbackTimer);
              pending._fallbackTimer = setTimeout(async () => {
                const p = this._findPending(evtSession);
                if (!p) return; // Already resolved via chat final
                try {
                  const fs = require('fs');
                  const sessDir = (TEAMAI_CFG.clawdbotHome || process.env.CLAWDBOT_HOME || '/home/ubuntu/.clawdbot') + '/agents/' + this.agentId + '/sessions/';
                  const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).sort((a,b) => fs.statSync(sessDir+b).mtimeMs - fs.statSync(sessDir+a).mtimeMs);
                  if (!files.length) return;
                  const lines = fs.readFileSync(sessDir + files[0], 'utf8').trim().split('\n');
                  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
                    try {
                      const entry = JSON.parse(lines[i]);
                      const msg = entry.message || {};
                      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                        const textBlocks = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
                        let text = textBlocks.replace(/^\[\[reply_to:[^\]]*\]\]\s*/g, '').trim();
                        if (text && text.length > 50) {
                          console.log('[' + this.agentId + '] fallback: read reply from session (' + text.length + ' chars)');
                          this.status = "online"; this.broadcastStatus();                          if (p.onReply) { const cb = p.onReply; this.pendingMap.delete(p.sessionKey); cb(text); return; }
                          const usage = getLatestUsage(this.agentId);
                          const meta = { memoryCount: p.memoryCount || 0, kbCount: p.kbCount || 0, toolCount: p.toolCount || 0, elapsed: Math.round((Date.now() - (p.startTime || Date.now())) / 1000), memoryTexts: p.memoryTexts || [], kbTexts: p.kbTexts || [] };
                          this.send({ type: "reply", agent: this.agentId, channel: p.channel, text, usage, meta });
                          appendHistory(p.channel, { type: 'reply', agent: this.agentId, text, usage, meta });
                          this.pendingMap.delete(p.sessionKey);
                          return;
                        }
                      }
                    } catch(e) {}
                  }
                } catch(e) { console.error('[' + this.agentId + '] fallback error:', e.message); }
              }, 15000);
            }
            if (stream === 'lifecycle' && d?.phase === 'start' && pending && pending._fallbackTimer) {
              clearTimeout(pending._fallbackTimer);
              pending._fallbackTimer = null;
            }
          }

          // Chat final
          if (msg.type === 'event' && msg.event === 'chat') {
            const evtSession = msg.payload?.sessionKey || '';
            if (!evtSession.startsWith('agent:' + this.agentId + ':')) return;
            const pending = this._findPending(evtSession);
            if (!pending) { if (evtSession) console.log('[' + this.agentId + '] chat event no pending for ' + evtSession + ' map=' + [...this.pendingMap.keys()].join(',')); return; }
            const { message: chatMsg, state } = msg.payload || {};
            if (chatMsg?.role === 'assistant' && state === 'final') {
              const text = cleanReplyText((chatMsg.content || []).filter(c => c.type === 'text').map(c => c.text).join(''));
              if (!text || text.length <= 2) return;
              if (text.length <= 5 && !pending.onReply) return;
              pending.buffer = text;
              this.status = 'online'; this.broadcastStatus();

              // Check JSON instructions (PM delegate / agent redirect)
              const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
              if (jsonMatch) {
                try {
                  const parsed = JSON.parse(jsonMatch[1]);
                  if (this.agentId === 'pm' && parsed.action === 'delegate' && parsed.tasks && this._orchestrator) {
                    console.log('[pm] delegation detected, tasks=' + parsed.tasks.length);
                    this._orchestrator(parsed, pending.channel);
                    this.pendingMap.delete(pending.sessionKey);
                    return;
                  }
                  if (parsed.action === 'redirect' && pending.onReply) {
                    console.log('[' + this.agentId + '] redirect to ' + parsed.suggest);
                    this.send({ type: 'redirect', from: this.agentId, reason: parsed.reason, suggest: parsed.suggest });
                    const cb = pending.onReply;
                    this.pendingMap.delete(pending.sessionKey);
                    cb({ __redirect: true, from: this.agentId, reason: parsed.reason, suggest: parsed.suggest });
                    return;
                  }
                } catch (e) {}
              }

              // Orchestrator callback (API path)
              // Skip internal markers - wait for real reply
              if (text.startsWith("[[reply_to:") || text.startsWith("[[")) return;
              if (pending.onReply) {
                const cb = pending.onReply;
                this.pendingMap.delete(pending.sessionKey);
                cb(text);
                return;
              }

              // Normal reply to chat
              const channelTasks = [...activeTasks.values()].filter(t => t.channel === pending.channel).sort((a, b) => b.createdAt - a.createdAt);
              if (channelTasks.length > 0 && channelTasks[0].status === 'cancelled') { this.pendingMap.delete(pending.sessionKey); return; }
              const usage = getLatestUsage(this.agentId);
              const meta = { memoryCount: pending.memoryCount || 0, kbCount: pending.kbCount || 0, toolCount: pending.toolCount || countRecentToolCalls(this.agentId), elapsed: Math.round((Date.now() - (pending.startTime || Date.now())) / 1000), memoryTexts: pending.memoryTexts || [], kbTexts: pending.kbTexts || [] };
              this.send({ type: "reply", agent: this.agentId, channel: pending.channel, text, usage, meta });
              appendHistory(pending.channel, { type: 'reply', agent: this.agentId, text, usage, meta });
              this.pendingMap.delete(pending.sessionKey);
          }
          }
        } catch (e) { console.error('[' + this.agentId + ']', e.message); }
      });
      this.ws.on('error', (e) => reject(e));
      this.ws.on('close', () => { this.authenticated = false; this.status = 'offline'; this.broadcastStatus(); });
      setTimeout(() => { if (!this.authenticated) reject(new Error('Timeout')); }, 15000);
    });
  }

  _findPending(evtSession) {
    // Direct match
    if (this.pendingMap.has(evtSession)) return this.pendingMap.get(evtSession);
    // Partial match (sessionKey in event may differ slightly)
    for (const [key, val] of this.pendingMap) {
      if (evtSession.includes(key.split(':').slice(2).join(':'))) return val;
    }
    return null;
  }

  send(obj) { try { this.clientWs.send(JSON.stringify(obj)); } catch (e) {} }
  broadcastStatus() { if (this._statusCb) this._statusCb(); }

  async sendMessage(message, channel, onReply = null, options = {}) {
    if (!this.authenticated) return;
    const sessionKey = `agent:${this.agentId}:multi-chat-${channel}`;
    // Search memory for relevant context
    let enrichedMessage = message;
    let _memCount = 0, _kbCount = 0, _memTexts = [], _kbTexts = [];
    try {
      console.log("[send] " + this.agentId + " searching memory..."); const memories = await Promise.race([searchMemory(this.agentId, message, 3), new Promise(r => setTimeout(() => r([]), 5000))]); console.log("[send] " + this.agentId + " memory done, found=" + memories.length); _memCount = memories.length; _memTexts = memories.map(m => m.text.substring(0, 100));
      if (memories.length > 0) {
        const ctx = memories.map(m => m.text).join('\n---\n');
        enrichedMessage = '[仅供参考的历史记忆，请优先回答当前问题]\n' + ctx + '\n\n[请回答以下问题]\n' + message;
      }
    } catch (e) {}
    // Search knowledge base for relevant docs
    try {
      const kbResults = await Promise.race([searchKnowledge(this.agentId, message, 3), new Promise(r => setTimeout(() => r([]), 5000))]);
      if (kbResults.length > 0) {
        console.log('[send] ' + this.agentId + ' kb found=' + kbResults.length); _kbCount = kbResults.length; _kbTexts = kbResults.map(r => r.text.substring(0, 100));
        const kbCtx = kbResults.map(r => r.text).join('\n---\n');
        enrichedMessage = '[相关知识库内容，请参考]\n' + kbCtx + '\n\n' + enrichedMessage;
      }
    } catch (e) {}
    const id = String(++this.requestId);
    console.log("[P-SET] " + this.agentId + " key=" + sessionKey + " size=" + this.pendingMap.size); this.pendingMap.set(sessionKey, { sessionKey, channel, buffer: '', onReply, originalMessage: message, startTime: Date.now(), memoryCount: _memCount, kbCount: _kbCount, memoryTexts: _memTexts, kbTexts: _kbTexts, scheduled: options.scheduled || false });
    this.status = 'thinking'; this.broadcastStatus();
    this.ws.send(JSON.stringify({ type: 'req', id, method: 'chat.send', params: { sessionKey, idempotencyKey: `mc-${Date.now()}-${id}`, message: enrichedMessage } }));
  }

  cancel(channel) {
    if (!this.authenticated) return;
    const sessionKey = `agent:${this.agentId}:multi-chat-${channel}`;
    const id = String(++this.requestId);
    this.ws.send(JSON.stringify({ type: 'req', id, method: 'chat.cancel', params: { sessionKey } }));
    this.pendingMap.delete(sessionKey);
    this.status = 'online'; this.send({ type: 'cancelled', agent: this.agentId });
  }

  cancelAll() {
    for (const [key, p] of this.pendingMap) {
      const id = String(++this.requestId);
      this.ws.send(JSON.stringify({ type: 'req', id, method: 'chat.cancel', params: { sessionKey: key } }));
    }
    this.pendingMap.clear(); this.status = 'online';
  }

  close() { if (this.ws) this.ws.close(); }
}



// --- Memory CRUD APIs ---
app.get('/api/memory', async (req, res) => {
  try {
    const result = await listMemory(req.query.nextToken, parseInt(req.query.limit) || 20, req.query.agentId || null);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/memory', express.json(), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const ok = await createMemoryRecord(text);
  res.json({ ok });
});

app.put('/api/memory/:id', express.json(), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const ok = await updateMemoryRecord(req.params.id, text);
  res.json({ ok });
});

app.delete('/api/memory/:id', async (req, res) => {
  const ok = await deleteMemoryRecord(req.params.id);
  res.json({ ok });
});

app.get('/api/memory/search', async (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  const results = await searchMemory('_all', q, parseInt(limit) || 10);
  res.json(results);
});


// Count recent tool calls from session file
function countRecentToolCalls(agentId) {
  try {
    const sessDir = path.join(TEAMAI_CFG.clawdbotHome, 'agents', agentId, 'sessions');
    if (!fs.existsSync(sessDir)) return 0;
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return 0;
    const content = fs.readFileSync(path.join(sessDir, files[0].name), 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    // Count toolCall in last 20 lines (most recent conversation)
    let count = 0;
    for (let i = Math.max(0, lines.length - 20); i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.message && Array.isArray(entry.message.content)) {
          entry.message.content.forEach(c => { if (c.type === 'toolCall') count++; });
        }
      } catch(e) {}
    }
    return count;
  } catch(e) { return 0; }
}

// --- Agent session history (tool calls) ---
app.get('/api/agent-session/:id', (req, res) => {
  const id = req.params.id;
  const sessDir = path.join(TEAMAI_CFG.clawdbotHome, 'agents', id, 'sessions');
  if (!fs.existsSync(sessDir)) return res.json({ entries: [] });
  const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return res.json({ entries: [] });
  const content = fs.readFileSync(path.join(sessDir, files[0].name), 'utf8').trim();
  const lines = content.split('\n').filter(Boolean);
  // Parse last N entries (most recent conversation turns)
  const limit = parseInt(req.query.limit) || 50;
  const entries = [];
  for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = entry.message || {};
      const role = msg.role || '';
      const contentArr = msg.content || [];
      const parsed = { role, items: [] };
      if (Array.isArray(contentArr)) {
        contentArr.forEach(c => {
          if (c.type === 'text') parsed.items.push({ type: 'text', text: (c.text || '').substring(0, 500) });
          else if (c.type === 'toolCall') parsed.items.push({ type: 'toolCall', name: c.name || '', args: (typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {})).substring(0, 300), id: c.id || '' });
          else if (c.type === 'toolResult') parsed.items.push({ type: 'toolResult', text: (c.text || '').substring(0, 500) });
          else parsed.items.push({ type: c.type || 'unknown' });
        });
      }
      if (parsed.items.length) entries.push(parsed);
    } catch (e) {}
  }
  res.json({ file: files[0].name, entries });
});

// --- Auto-connect agents for API access (independent of browser) ---
const apiAgentConns = new Map();
async function initApiConnections() {
  for (const agent of AGENTS) {
    try {
      const conn = new AgentConnection(agent.id, { send: () => {} }); // dummy clientWs
      conn._statusCb = () => {};
      await conn.connect();
      apiAgentConns.set(agent.id, conn);
      console.log('[api-init] ' + agent.id + ' connected');
    } catch (e) {
      console.error('[api-init] ' + agent.id + ' failed: ' + e.message);
    }
  }
  // Use apiAgentConns as fallback for scheduleAgentConns
  if (!scheduleAgentConns) {
    scheduleAgentConns = apiAgentConns;
    initAllSchedules();
    console.log('[api-init] schedule system initialized with API connections');
  }
}
setTimeout(initApiConnections, 2000);

// Auto-reconnect apiAgentConns every 60s if any disconnected
setInterval(async () => {
  if (!apiAgentConns.size) return;
  for (const agent of AGENTS) {
    const conn = apiAgentConns.get(agent.id);
    if (!conn || !conn.authenticated) {
      try {
        const newConn = new AgentConnection(agent.id, { send: () => {} });
        newConn._statusCb = () => {};
        await newConn.connect();
        apiAgentConns.set(agent.id, newConn);
        console.log('[api-reconnect] ' + agent.id + ' reconnected');
      } catch (e) {}
    }
  }
}, 60000);
// --- WebSocket handler ---
wss.on('connection', async (clientWs) => {
  console.log('[client] connected');
  const agentConns = new Map();

  // Close API connections - Gateway only sends events to one operator
  // Browser connections take over for both chat and scheduled tasks
  for (const [id, conn] of apiAgentConns) { try { conn.close(); } catch(e){} }
  apiAgentConns.clear();
  scheduleAgentConns = agentConns;
  console.log('[sched] switched to browser connections, closed API connections');

  const broadcastStatus = () => {
    const s = {}; for (const [id, c] of agentConns) s[id] = c.status;
    try { clientWs.send(JSON.stringify({ type: 'status', agents: s })); } catch (e) {}
  };

  try {
    for (const agent of AGENTS) {
      const conn = new AgentConnection(agent.id, clientWs);
      conn._statusCb = broadcastStatus;
      await conn.connect();
      agentConns.set(agent.id, conn);
    }

    // PM Orchestrator
    const pmConn = agentConns.get('pm');
    if (pmConn) {
      pmConn._orchestrator = (instruction, channelId) => {
        const taskId = ++taskIdCounter;
        const chName = (loadChannels().find(c => c.id === channelId) || {}).name || channelId;
        const subtasks = (instruction.tasks || []).map(t => ({ agent: t.agent, task: t.task, status: 'pending', startedAt: null, completedAt: null, result: null }));
        subtasks.push({ agent: 'pm', task: '汇总结果', status: 'waiting', startedAt: null, completedAt: null, result: null });
        const taskObj = { id: taskId, title: instruction.summary_instruction || 'PM 任务', channelName: chName, channel: channelId, status: 'delegating', createdAt: Date.now(), subtasks, summaryStatus: 'waiting', completedAt: null };
        activeTasks.set(taskId, taskObj); saveTasks();
        clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));

        (async () => {
          const results = [];
          for (let i = 0; i < subtasks.length; i++) {
            const st = subtasks[i];
            if (st.agent === 'pm') continue;
            const conn = agentConns.get(st.agent);
            if (!conn) { st.status = 'error'; st.result = 'not found'; results.push({ agent: st.agent, text: '[not found]' }); saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj })); continue; }

            st.status = 'running'; st.startedAt = Date.now(); taskObj.status = 'running';
            saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));

            const taskChannel = 'pm-task-' + st.agent;
            // Inject confirmed SQL if available from PM intent confirmation
            let taskMsg = st.task;
            if (global._confirmedSqls && global._confirmedSqls[st.agent]) {
              const confirmedSql = global._confirmedSqls[st.agent];
              taskMsg = '【需求已确认，请直接执行以下 SQL】\n' + st.task + '\n\n```sql\n' + confirmedSql + '\n```\n请执行这条 SQL 并分析结果。';
              console.log('[pm-intent] injected confirmed SQL for ' + st.agent);
            }
            const result = await new Promise(resolve => { conn.sendMessage(taskMsg, taskChannel, resolve); });

            // Redirect
            if (result && result.__redirect) {
              st.status = 'redirected'; st.completedAt = Date.now(); st.result = 'redirect: ' + result.reason;
              saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));
              const suggestConn = agentConns.get(result.suggest);
              if (suggestConn) {
                const newSt = { agent: result.suggest, task: st.task, status: 'running', startedAt: Date.now(), completedAt: null, result: null };
                subtasks.splice(i + 1, 0, newSt);
                saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));
                const redirChannel = 'pm-redirect-' + result.suggest;
                const newResult = await new Promise(resolve => { suggestConn.sendMessage(st.task, redirChannel, resolve); });
                const newText = typeof newResult === 'string' ? newResult : (newResult?.text || String(newResult));
                newSt.status = 'completed'; newSt.completedAt = Date.now(); newSt.result = newText;
                results.push({ agent: result.suggest, text: newText });
                saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));
              }
              continue;
            }

            const resultText = typeof result === 'string' ? result : (result?.text || String(result));
            st.status = 'completed'; st.completedAt = Date.now(); st.result = resultText;
            results.push({ agent: st.agent, text: resultText });
            saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));
          }

          // PM summary
          const pmSub = subtasks.find(s => s.agent === 'pm');
          if (pmSub) { pmSub.status = 'running'; pmSub.startedAt = Date.now(); }
          taskObj.summaryStatus = 'summarizing'; saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));

          const validResults = results.filter(r => r.agent !== 'pm');
          const feedback = validResults.map(r => { const a = AGENTS.find(x => x.id === r.agent); const txt = typeof r.text === 'string' ? r.text : String(r.text); return (a ? a.name : r.agent) + ' 的回复:\n' + txt; }).join('\n\n---\n\n');
          if (global._confirmedSqls) { delete global._confirmedSqls; }
          const summaryMsg = '[团队反馈] 以下是团队成员的回复，请直接汇总成报告，不要查看历史或检查状态:\n\n' + feedback + '\n\n' + (instruction.summary_instruction || '请汇总以上结果');

          const summaryChannel = 'pm-summary';
          const summaryResult = await new Promise(resolve => { pmConn.sendMessage(summaryMsg, summaryChannel, resolve); });
          const summaryText = typeof summaryResult === 'string' ? summaryResult : (summaryResult?.text || String(summaryResult));
          const cleanSummary = cleanReplyText(summaryText);

          if (cleanSummary && cleanSummary.length > 5) {
            clientWs.send(JSON.stringify({ type: 'reply', agent: 'pm', channel: channelId, text: cleanSummary }));
            appendHistory(channelId, { type: 'reply', agent: 'pm', text: cleanSummary });
          }

          if (pmSub) { pmSub.status = 'completed'; pmSub.completedAt = Date.now(); }
          taskObj.summaryStatus = 'completed'; taskObj.status = 'completed'; taskObj.completedAt = Date.now();
          saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task: taskObj }));
        })();
      };
    }

    // Enrich agents with current model info from config
    let enrichedAgents = AGENTS.map(a => {
      try {
        const cfg = JSON.parse(fs.readFileSync(CLAWDBOT_CONFIG, 'utf8'));
        const ac = (cfg.agents?.list || []).find(x => x.id === a.id);
        const modelId = ac?.model?.primary || cfg.agents?.defaults?.model?.primary || '';
        const providers = cfg.models?.providers || {};
        let modelName = modelId.split('/').pop();
        for (const [p, pc] of Object.entries(providers)) {
          const found = (pc.models || []).find(m => p + '/' + m.id === modelId || m.id === modelId);
          if (found) { modelName = found.name || modelName; break; }
        }
        return { ...a, model: modelName };
      } catch (e) { return a; }
    });
    console.log('[connect] agents:', enrichedAgents.map(a => a.id + '=' + a.model).join(', '));
    clientWs.send(JSON.stringify({ type: 'connected', agents: enrichedAgents, channels: loadChannels(), tasks: [...activeTasks.values()], schedules: schedules }));
    broadcastStatus();
  } catch (e) {
    clientWs.send(JSON.stringify({ type: 'error', text: 'Gateway连接失败: ' + e.message }));
    for (const [, c] of agentConns) c.close(); clientWs.close(); return;
  }

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'stop') { for (const [, c] of agentConns) c.cancelAll(); broadcastStatus(); return; }

      if (msg.type === 'cancel-task') {
        const task = activeTasks.get(msg.taskId);
        if (task) {
          task.status = 'cancelled';
          task.subtasks.forEach(st => { if (st.status === 'pending' || st.status === 'running') { st.status = 'cancelled'; const c = agentConns.get(st.agent); if (c) c.cancel('pm-task-' + st.agent); } });
          const pmC = agentConns.get('pm'); if (pmC) pmC.cancel('pm-summary');
          saveTasks(); clientWs.send(JSON.stringify({ type: 'task-update', task })); broadcastStatus();
        }
        return;
      }

      if (msg.type === 'cancel-agent') { const c = agentConns.get(msg.agent); if (c) c.cancelAll(); broadcastStatus(); return; }
      if (msg.type === 'delete-task') { activeTasks.delete(msg.taskId); saveTasks(); clientWs.send(JSON.stringify({ type: 'task-deleted', taskId: msg.taskId })); return; }

      if (msg.type === 'chat') {
        const channelId = msg.channel || 'group-001';
        const ch = loadChannels().find(c => c.id === channelId);
        console.log('[chat] channel=' + channelId + ' mode=' + (ch?.mode||'none') + ' text=' + (msg.text||'').substring(0,40));
      // Store confirmed SQLs from PM intent confirmation
      if (msg.confirmedSqls) {
        global._confirmedSqls = msg.confirmedSqls;
        console.log('[pm-intent] stored confirmedSqls for agents:', Object.keys(msg.confirmedSqls).join(','));
      }

        if (msg.forward) {
          const { from, to, originalText } = msg.forward;
          const members = ch?.agents || AGENTS.map(a => a.id);
          if (!members.includes(to)) { clientWs.send(JSON.stringify({ type: 'hint', text: '该成员不在此群聊中' })); return; }
          const fromA = AGENTS.find(a => a.id === from);
          const toConn = agentConns.get(to);
          if (toConn) {
            toConn.sendMessage((fromA?.name || from) + ' 说了以下内容，请从你的专业角度评价或补充:\n\n' + originalText, channelId);
            clientWs.send(JSON.stringify({ type: 'user', text: msg.text, channel: channelId, targets: [to] }));
            appendHistory(channelId, { type: 'user', text: msg.text, targets: [to], forward: true });
          }
          return;
        }

        if (ch?.type === 'group') {
          const mentions = [...msg.text.matchAll(/@([\w-]+)/g)].map(m => m[1]);
          const members = ch.agents || AGENTS.map(a => a.id);
          const targets = mentions.filter(m => agentConns.has(m));

          if (targets.length > 0) {
            const validTargets = targets.filter(t => members.includes(t));
            if (!validTargets.length) { clientWs.send(JSON.stringify({ type: 'hint', text: '该成员不在此群聊中' })); }
            else {
              const cleanText = msg.text.replace(/@[\w-]+/g, '').trim();
              validTargets.forEach(id => agentConns.get(id)?.sendMessage(cleanText, channelId));
              clientWs.send(JSON.stringify({ type: 'user', text: msg.text, channel: channelId, targets: validTargets }));
              appendHistory(channelId, { type: 'user', text: msg.text, targets: validTargets });
            }
          } else {
            const chMode = ch.mode || 'private';
            if (chMode === 'open') {
              clientWs.send(JSON.stringify({ type: 'user', text: msg.text, channel: channelId, targets: ['all'], mode: 'open' }));
              appendHistory(channelId, { type: 'user', text: msg.text, targets: ['all'], mode: 'open' });
              const candidateAgents = AGENTS.filter(a => a.id !== 'pm' && members.includes(a.id));
              (async () => {
                for (const agent of candidateAgents) {
                  const conn = agentConns.get(agent.id);
                  if (!conn || !conn.authenticated) continue;
                  const checkChannel = 'mode-check-' + channelId;
                  const checkResult = await new Promise(resolve => {
                    conn.sendMessage('判断题：你是群聊中的一员，以下是用户发的消息。如果这条消息是打招呼、闲聊、提问、讨论、或者任何你能参与的话题，回答 YES。只有完全跟你无关的才回答 NO。只回答 YES 或 NO。\n消息：' + msg.text, checkChannel, resolve);
                  });
                  const checkText = typeof checkResult === 'string' ? checkResult : (checkResult?.text || '');
                  console.log('[open-mode] ' + agent.id + ' check=' + checkText.substring(0, 20));
                  if (checkText.toUpperCase().includes('YES')) {
                    console.log('[open-mode] ' + agent.id + ' will reply');
                    await new Promise(r => setTimeout(r, 500));
                    conn.sendMessage(msg.text, channelId);
                  }
                }
              })();
            } else {
              clientWs.send(JSON.stringify({ type: 'hint', text: '请用 @agent名 指定发送对象' }));
            }
          }
        } else if (ch?.type === 'dm') {
          const c = agentConns.get(ch.agent);
          if (c) {
            const dmText = msg.text.replace(/@[\w-]+/g, '').trim() || msg.text;
            c.sendMessage(dmText, channelId);
            clientWs.send(JSON.stringify({ type: 'user', text: msg.text, channel: channelId, targets: [ch.agent] }));
            appendHistory(channelId, { type: 'user', text: msg.text, targets: [ch.agent] });
          }
        }
      }
    } catch (e) { console.error('[client]', e.message); }
  });

  clientWs.on('close', () => { for (const [, c] of agentConns) c.close(); console.log('[client] disconnected');
    // Rebuild API connections since browser is gone
    scheduleAgentConns = apiAgentConns;
    console.log('[sched] browser disconnected, rebuilding API connections...');
    initApiConnections(); });
});


// --- Semantic Model API ---
app.get('/api/semantic-model', async (req, res) => {
  try {
    const source = req.query.source || null; // 'datalake' or 'snowflake' or null for all
    const domain = req.query.domain || null;

    // Get all tables
    let tableQuery = "MATCH (t:Table) RETURN t.name AS name, t.source AS source, t.database AS database, t.description AS description, t.semantic_view AS semantic_view, t.domain AS domain, t.status AS status, id(t) AS nodeId ORDER BY t.source, t.name";
    if (source) tableQuery = `MATCH (t:Table {source: '${source}'}) RETURN t.name AS name, t.source AS source, t.database AS database, t.description AS description, t.semantic_view AS semantic_view, t.domain AS domain, t.status AS status, id(t) AS nodeId ORDER BY t.name`;

    const tableResult = await neptuneQuery(tableQuery);
    const tables = tableResult.results || [];

    // For each table, get columns and relationships
    const enriched = [];
    for (const t of tables) {
      // Columns
      const colQuery = `MATCH (t:Table {name: '${t.name}'})-[:HAS_COLUMN]->(c:Column) RETURN c.name AS name, c.type AS type, c.description AS description, c.semantic_type AS semantic_type, c.business_name AS business_name, c.synonyms AS synonyms, c.expression AS expression, c.default_aggregation AS aggregation ORDER BY c.name`;
      const colResult = await neptuneQuery(colQuery);

      // Relationships
      const relQuery = `MATCH (t:Table {name: '${t.name}'})-[r:JOINS_ON]->(other:Table) RETURN other.name AS to_table, r.column AS join_column, other.source AS to_source, 'outgoing' AS direction UNION MATCH (other:Table)-[r:JOINS_ON]->(t:Table {name: '${t.name}'}) RETURN other.name AS to_table, r.column AS join_column, other.source AS to_source, 'incoming' AS direction`;
      const relResult = await neptuneQuery(relQuery);

      enriched.push({
        ...t,
        columns: colResult.results || [],
        relationships: relResult.results || []
      });
    }

    res.json({ tables: enriched });
  } catch (e) {
    console.error('[semantic] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/semantic-model/:tableName', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const tableName = req.params.tableName;
    const { columns, domain, status } = req.body;

    // Update table properties
    if (domain || status) {
      let setClause = '';
      if (domain) setClause += `, t.domain = '${domain}'`;
      if (status) setClause += `, t.status = '${status}'`;
      await neptuneQuery(`MATCH (t:Table {name: '${tableName}', source: 'datalake'}) SET t.updated = '${new Date().toISOString()}'${setClause} RETURN t.name`);
    }

    // Update column semantic properties
    if (columns && Array.isArray(columns)) {
      for (const col of columns) {
        let sets = [];
        if (col.semantic_type) sets.push(`c.semantic_type = '${col.semantic_type}'`);
        if (col.business_name) sets.push(`c.business_name = '${col.business_name}'`);
        if (col.synonyms) sets.push(`c.synonyms = '${col.synonyms}'`);
        if (col.expression) sets.push(`c.expression = '${col.expression.replace(/'/g, "\\'")}'`);
        if (col.aggregation) sets.push(`c.default_aggregation = '${col.aggregation}'`);
        if (col.description) sets.push(`c.description = '${col.description.replace(/'/g, "\\'")}'`);
        if (sets.length > 0) {
          await neptuneQuery(`MATCH (c:Column {name: '${col.name}', tableName: '${tableName}'}) SET ${sets.join(', ')} RETURN c.name`);
        }
      }
    }

    // Re-generate embeddings for updated columns
    const encoder = new TextEncoder();
    for (const col of (columns || [])) {
      if (col.description || col.business_name) {
        const text = col.description || `${col.business_name} in ${tableName}`;
        const body = JSON.stringify({ inputText: text });
        const cmd = new InvokeModelCommand({ modelId: 'amazon.titan-embed-text-v2:0', body: encoder.encode(body), contentType: 'application/json' });
        const resp = await bedrockRtClient.send(cmd);
        const respBody = JSON.parse(new TextDecoder().decode(resp.body));
        const embedding = respBody.embedding;
        await neptuneQuery(`MATCH (c:Column {name: '${col.name}', tableName: '${tableName}'}) WITH c CALL neptune.algo.vectors.upsert(c, ${JSON.stringify(embedding)}) YIELD success RETURN success`);
      }
    }

    res.json({ ok: true, table: tableName });
  } catch (e) {
    console.error('[semantic] PUT error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/semantic-model/:tableName/regenerate', async (req, res) => {
  try {
    const tableName = req.params.tableName;
    // This would call LLM to regenerate semantic annotations
    // For now, return a placeholder
    res.json({ ok: true, message: 'Regeneration queued for ' + tableName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// --- Memory Governance Config API ---
const MG_CONFIG_PATH = path.join(__dirname, 'history', 'memory-governance-config.json');
function loadMgConfig(agentId) {
  try {
    if (agentId) {
      const agentPath = path.join(__dirname, 'history', 'memory-governance-config-' + agentId + '.json');
      if (fs.existsSync(agentPath)) return JSON.parse(fs.readFileSync(agentPath, 'utf8'));
    }
    return JSON.parse(fs.readFileSync(MG_CONFIG_PATH, 'utf8'));
  } catch(e) { return null; }
}
app.get('/api/memory-governance/config', (req, res) => {
  const agentId = req.query.agentId;
  const cfg = loadMgConfig(agentId);
  if (!cfg) return res.status(404).json({ error: 'config not found' });
  res.json(cfg);
});
app.put('/api/memory-governance/config', express.json(), (req, res) => {
  try {
    const agentId = req.query.agentId || req.body.agentId;
    const cfgPath = agentId
      ? path.join(__dirname, 'history', 'memory-governance-config-' + agentId + '.json')
      : MG_CONFIG_PATH;
    fs.writeFileSync(cfgPath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- Memory Governance API ---
app.get("/api/mg-test", (req, res) => res.json({ok:true}));
app.post('/api/memory-governance/discover-domains', express.json(), async (req, res) => {
  try {
    const { agentId, memoryIds } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    // Get agent SOUL
    const soulPath = path.join(AGENTS_DIR, agentId, 'SOUL_PRIVATE.md');
    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').substring(0, 500) : '';

    // Get all memories
    const memResult = await listMemory(null, 50, agentId);
    let memories = memResult.records || [];
    if (memoryIds && memoryIds.length > 0) memories = memories.filter(m => memoryIds.includes(m.id));
    if (memories.length === 0) return res.json({ domains: [], memories: [] });

    const memTexts = memories.map((m, i) => `[${i}] ${m.text.substring(0, 150)}`).join('\n');

    // LLM discover domains
    const prompt = `You are a memory governance assistant. Given this agent's role and memories, discover 3-5 knowledge domains.

Agent role: ${soul.substring(0, 300)}

Memories (${memories.length} total):
${memTexts}

For each memory, also assign a type:
- correction: 用户纠正过的错误认知
- rule: 业务规则或经验总结
- preference: 用户偏好或习惯
- fact: 具体业务事实或上下文
- snapshot: 带时间的查询结果快照（可能过时）

Output JSON only:
{"domains": [{"name": "领域名称", "description": "一句话描述", "memory_indices": [0,1,2]}], "uncategorized": [3,4], "memory_types": {"0": "rule", "1": "snapshot", "2": "fact"}}

IMPORTANT: Each memory index must appear in AT MOST ONE domain. Do not assign the same index to multiple domains. Pick the single best-fit domain for each memory. memory_types must cover ALL memory indices.`;

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    });
    const brClient = new (require('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient)({ region: 'us-east-1' });
    const brResp = await brClient.send(new (require('@aws-sdk/client-bedrock-runtime').InvokeModelCommand)({
      modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      body: new TextEncoder().encode(body),
      contentType: 'application/json'
    }));
    let text = new TextDecoder().decode(brResp.body);
    const parsed = JSON.parse(text);
    let llmText = parsed.content[0].text.trim();
    if (llmText.includes('```json')) llmText = llmText.split('```json')[1].split('```')[0].trim();
    else if (llmText.includes('```')) llmText = llmText.split('```')[1].split('```')[0].trim();
    const result = JSON.parse(llmText);

    // Attach memory data to domains (dedup: each memory only in first domain)
    const assignedIndices = new Set();
    result.domains.forEach(d => {
      const uniqueIndices = (d.memory_indices || []).filter(i => !assignedIndices.has(i));
      uniqueIndices.forEach(i => assignedIndices.add(i));
      d.memories = uniqueIndices.map(i => memories[i]).filter(Boolean);
      delete d.memory_indices;
    });
    // Uncategorized = everything not assigned to any domain
    const uncatMems = [];
    for (let i = 0; i < memories.length; i++) { if (!assignedIndices.has(i)) uncatMems.push(memories[i]); }
    result.uncategorized_memories = uncatMems;
    result.all_memories = memories;
    // Pass through memory_types (index -> type mapping)
    if (result.memory_types) {
      result.memory_types_by_id = {};
      for (const [idx, typ] of Object.entries(result.memory_types)) {
        const mem = memories[parseInt(idx)];
        if (mem) result.memory_types_by_id[mem.id] = typ;
      }
    }

    res.json(result);
  } catch (e) {
    console.error('[governance] discover error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/memory-governance/classify', express.json(), async (req, res) => {
  try {
    const { agentId, domain, domainDescription, memoryIds } = req.body;
    if (!agentId || !domain) return res.status(400).json({ error: 'agentId and domain required' });

    const soulPath = path.join(AGENTS_DIR, agentId, 'SOUL_PRIVATE.md');
    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').substring(0, 300) : '';

    // Get memories to classify
    const memResult = await listMemory(null, 50, agentId);
    const allMems = memResult.records || [];
    const mems = memoryIds ? allMems.filter(m => memoryIds.includes(m.id)) : allMems;

    const memTexts = mems.map((m, i) => `[${i}] (id:${m.id}) ${m.text.substring(0, 200)}`).join('\n');

    const prompt = `You are classifying memories for agent "${agentId}" (${soul.substring(0, 200)}).
Domain: ${domain} — ${domainDescription || ''}

Classify each memory into one of:
- core_rule: 核心业务规则，应提升为常驻知识
- analysis_experience: 分析经验和方法论
- business_context: 业务上下文知识
- query_snapshot: 查询结果快照（可能过时）
- noise: 噪音/无关内容

Memories:
${memTexts}

Output JSON only:
{"classified": [{"id": "mem-xxx", "category": "core_rule", "reason": "简要原因"}]}`;

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }]
    });
    const brClient = new (require('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient)({ region: 'us-east-1' });
    const brResp = await brClient.send(new (require('@aws-sdk/client-bedrock-runtime').InvokeModelCommand)({
      modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      body: new TextEncoder().encode(body),
      contentType: 'application/json'
    }));
    let text = new TextDecoder().decode(brResp.body);
    const parsed = JSON.parse(text);
    let llmText = parsed.content[0].text.trim();
    if (llmText.includes('```json')) llmText = llmText.split('```json')[1].split('```')[0].trim();
    else if (llmText.includes('```')) llmText = llmText.split('```')[1].split('```')[0].trim();
    const result = JSON.parse(llmText);

    // Merge with memory data
    result.classified.forEach(c => {
      const mem = mems.find(m => m.id === c.id);
      if (mem) c.text = mem.text.substring(0, 200);
    });

    res.json(result);
  } catch (e) {
    console.error('[governance] classify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/memory-governance/execute', express.json(), async (req, res) => {
  try {
    const { agentId, actions } = req.body;
    // actions: [{id, action: "keep"|"delete"|"promote"}]
    if (!agentId || !actions) return res.status(400).json({ error: 'agentId and actions required' });

    let deleted = 0, promoted = 0;
    const promoteTexts = [];

    for (const a of actions) {
      if (a.action === 'delete') {
        if (await deleteMemoryRecord(a.id)) deleted++;
      } else if (a.action === 'promote') {
        // Get memory text for MEMORY.md
        const memResult = await listMemory(null, 50, agentId);
        const mem = (memResult.records || []).find(m => m.id === a.id);
        if (mem) {
          // Extract key point (first 100 chars)
          const point = mem.text.substring(0, 150).split('\n')[0];
          promoteTexts.push('- ' + point);
        }
      }
    }

    // Append promoted items to MEMORY.md
    if (promoteTexts.length > 0) {
      const memoryMdPath = path.join(AGENTS_DIR, agentId, 'MEMORY.md');
      let existing = fs.existsSync(memoryMdPath) ? fs.readFileSync(memoryMdPath, 'utf8') : '';
      existing += '\n' + promoteTexts.join('\n');
      fs.writeFileSync(memoryMdPath, existing.trim());
      promoted = promoteTexts.length;
      // Rebuild SOUL
      assembleSoul(agentId);
    }

    res.json({ ok: true, deleted, promoted, kept: actions.filter(a => a.action === 'keep').length });
  } catch (e) {
    console.error('[governance] execute error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// --- Memory Domain Persistence ---
const DOMAINS_DIR = path.join(__dirname, 'history');
app.get('/api/memory-domains/:agentId', (req, res) => {
  const fp = path.join(DOMAINS_DIR, 'memory-domains-' + req.params.agentId + '.json');
  if (fs.existsSync(fp)) {
    res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } else {
    res.json({ domains: [] });
  }
});
app.put('/api/memory-domains/:agentId', express.json(), (req, res) => {
  const fp = path.join(DOMAINS_DIR, 'memory-domains-' + req.params.agentId + '.json');
  fs.writeFileSync(fp, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});


// --- extractMemories sub-agent (every 60s) ---
const EXTRACT_INTERVAL = 60 * 1000;
const EXTRACT_STATE_FILE = path.join(__dirname, '.extract-state.json');
const EXTRACT_AGENTS = ['aws-expert', 'snowflake-expert', 'main'];
function loadExtractState() { try { return JSON.parse(fs.readFileSync(EXTRACT_STATE_FILE, 'utf8')); } catch(e) { return {}; } }
function saveExtractState(s) { try { fs.writeFileSync(EXTRACT_STATE_FILE, JSON.stringify(s, null, 2)); } catch(e) {} }
async function runExtractMemories() {
  const state = loadExtractState();
  for (const aid of EXTRACT_AGENTS) {
    try {
      const sd = path.join(TEAMAI_CFG.clawdbotHome || process.env.CLAWDBOT_HOME || '/home/ubuntu/.clawdbot', 'agents', aid, 'sessions');
      if (!fs.existsSync(sd)) continue;
      const ff = fs.readdirSync(sd).filter(f => f.endsWith('.jsonl')).map(f => ({ name: f, mt: fs.statSync(path.join(sd, f)).mtimeMs })).sort((a, b) => b.mt - a.mt);
      if (!ff.length) continue;
      const sf = path.join(sd, ff[0].name);
      const lt = state[aid] || '';
      const inp = JSON.stringify({ agentId: aid, sessionFile: sf, lastExtractedAt: lt });
      const res = require('child_process').execSync('python3 ' + path.join(__dirname, 'extract-helper.py'), { input: inp, timeout: 60000, encoding: 'utf8' });
      const out = JSON.parse(res.trim());
      if (out.newTimestamp) { state[aid] = out.newTimestamp; saveExtractState(state); }
      if (out.extracted && out.extracted.length > 0) console.log('[extract] ' + aid + ': ' + out.extracted.length + ' memories');
    } catch(e) {}
  }
}
const extractMemoriesTimer = setInterval(runExtractMemories, EXTRACT_INTERVAL);
console.log('[extract] timer started (' + (EXTRACT_INTERVAL/1000) + 's)');

server.listen(PORT, '0.0.0.0', () => console.log(`Multi-Chat v8 on http://0.0.0.0:${PORT}`));
