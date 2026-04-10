// Memory helper for TeamAI - Mem0 backend via memory-service.py
const http = require('http');

const MEM0_BASE = 'http://127.0.0.1:3005';

function mem0Request(method, path, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, MEM0_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function storeMemory(agentId, userMessage, agentReply, channel, toolCount, sql, resultData) {
  try {
    // Detect correction signal
    const corrKeywords = ['不对','错了','应该是','纠正','不是这样','改一下','搞错了','wrong','incorrect','should be'];
    const isCorrection = corrKeywords.some(kw => userMessage.includes(kw));
    const metadata = {
      channel: channel || 'unknown',
      source: 'conversation',
      ts: new Date().toISOString()
    };
    if (isCorrection) metadata.type = 'rule';

    const toolCount = arguments[4] || 0;
    const sql = arguments[5] || '';
    const resultData = arguments[6] || null;
    const payload = { agentId, userMessage, agentReply, channel, metadata, toolCount };
    if (sql) payload.sql = sql;
    if (resultData) payload.resultData = resultData;
    await mem0Request('POST', '/store', payload);
    console.log('[memory] stored for ' + agentId + ' via mem0');
    return true;
  } catch (e) {
    console.error('[memory] store error:', e.message);
    return false;
  }
}

async function searchMemory(agentId, query, topK = 3) {
  try {
    const result = await mem0Request('GET', '/search?agentId=' + encodeURIComponent(agentId) + '&q=' + encodeURIComponent(query) + '&topK=' + topK);
    let records = (result.records || []).filter(r => r.text && r.score > 0.3);

    // Load per-agent type config for weight + decay scoring
    let typeConfig = {};
    try {
      const cfgResult = await mem0Request('GET', '/agent-config?agentId=' + encodeURIComponent(agentId));
      // Fallback: load from server API if mem0 doesn't have it
    } catch(e) {}
    try {
      const http2 = require('http');
      const cfgBody = await new Promise((res, rej) => {
        http2.get('http://127.0.0.1:3001/api/memory-governance/config?agentId=' + encodeURIComponent(agentId), r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { res({}); } });
        }).on('error', () => res({}));
      });
      typeConfig = (cfgBody && cfgBody.types) || {};
    } catch(e) {}

    // Apply weight × decay scoring
    const now = Date.now();
    records.forEach(r => {
      const type = (r.metadata && r.metadata.type) || 'other';
      const cfg = typeConfig[type] || { weight: 0.5, decayDays: 7 };
      const weight = cfg.weight || 0.5;
      const decayDays = cfg.decayDays || 0;
      const ageDays = (now - new Date(r.createdAt || now).getTime()) / 86400000;
      const decay = decayDays > 0 ? Math.max(0, 1 - ageDays / decayDays) : 1;
      r.finalScore = r.score * weight * decay;
    });

    // Sort by finalScore descending, filter out fully decayed (score=0)
    records = records.filter(r => r.finalScore > 0).sort((a, b) => b.finalScore - a.finalScore);

    // Enrich context with SQL from metadata if available
    records.forEach(r => {
      if (r.metadata && r.metadata.sql) {
        r.text += '\n[参考SQL] ' + r.metadata.sql;
      }
    });
    if (records.length > 0) {
      console.log('[memory] found ' + records.length + ' for ' + agentId + ' (top score: ' + (records[0].finalScore || 0).toFixed(2) + ')');
    }
    return records;
  } catch (e) {
    console.error('[memory] search error:', e.message);
    return [];
  }
}

async function listMemory(nextToken, maxResults = 20, agentId = null) {
  try {
    let url = '/list?limit=' + maxResults;
    if (agentId) url += '&agentId=' + encodeURIComponent(agentId);
    const result = await mem0Request('GET', url);
    return {
      records: (result.records || []).sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
      nextToken: result.nextToken || null
    };
  } catch (e) {
    console.error('[memory] list error:', e.message);
    return { records: [], nextToken: null };
  }
}

async function deleteMemoryRecord(recordId) {
  try {
    await mem0Request('DELETE', '/delete/' + recordId);
    console.log('[memory] deleted:', recordId);
    return true;
  } catch (e) {
    console.error('[memory] delete error:', e.message);
    return false;
  }
}

async function updateMemoryRecord(recordId, newText) {
  try {
    await mem0Request('PUT', '/update/' + recordId, { text: newText });
    console.log('[memory] updated:', recordId);
    return true;
  } catch (e) {
    console.error('[memory] update error:', e.message);
    return false;
  }
}

async function createMemoryRecord(text) {
  try {
    await mem0Request('POST', '/create', { text });
    console.log('[memory] created record');
    return true;
  } catch (e) {
    console.error('[memory] create error:', e.message);
    return false;
  }
}

module.exports = { storeMemory, searchMemory, listMemory, deleteMemoryRecord, updateMemoryRecord, createMemoryRecord };
