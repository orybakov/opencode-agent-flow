import http from 'node:http';
import { createHash } from 'node:crypto';
import { clip } from './lib/privacy.mjs';
import { readFileSync } from 'node:fs';
import { Upstream } from './lib/upstream.mjs';
import { demo } from './lib/demo.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
export async function start(config) {
const hours = config.window, port = config.port;
const prices = JSON.parse(readFileSync(join(base, 'prices.json'), 'utf8'));
const json = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const modelId = m => clip((typeof m === 'string' ? m : m?.id || m?.modelID) || 'unknown', 100);
const rate = m => prices.models[m] || Object.entries(prices.models).find(([k]) => m.startsWith(k))?.[1] || prices.default;
let snapshot, signature = '', timer;
const upstream = config.demo ? demo() : new Upstream(config, schedule);
let approvals = [], permissionHealth = { ok: false, status: null };
const clients = new Set();
const rowCache = new Map();
const agentCache = new Map();
const rows = id => { const messages = upstream.messages.get(id), cached = rowCache.get(id); if (cached && cached.source === messages) return cached.rows; const result = (messages || []).map((m, seq) => ({ id: m.id, session_id: id, seq, type: m.type, time_created: m.time?.created || 0, time_updated: m.time?.completed || m.time?.streamed || m.time?.created || 0, parsed: m })); rowCache.set(id, { source: messages, rows: result }); return result; };
const scopedSnapshots = new Map();
function toolInfo(c, fallback) {
  const input = c.state?.input || c.input || {};
  let name = c.name || c.tool || 'tool';
  if (name === 'execute') {
    const m = input.code?.match(/tools\.([\w]+)(?:\.([\w-]+)|\[['"]([^'"]+)['"]\])/);
    if (m) name = `${m[1]}.${m[2] || m[3]}`;
  }
  return { name: clip(name, 80), target: clip(input.filePath || input.path || input.pattern || input.command || input.query || input.url || input.agent || input.description || ''), since: c.time?.created || c.state?.time?.start || fallback };
}
function buildState(sessionId) {
    const now = Date.now(), midnight = new Date().setHours(0, 0, 0, 0);
     const sessions = [...upstream.sessions.values()].filter(s => sessionId || !s.time?.archived).map(s => ({ ...s, title: clip(s.title), agent: clip(s.agent, 80), parent_id: s.parentID, time_updated: s.time?.updated || 0, model: JSON.stringify(s.model), tokens_input: s.tokens?.input || 0, tokens_output: s.tokens?.output || 0, tokens_cache_read: s.tokens?.cache?.read || 0 }));
    const roots = sessions.filter(s => sessionId ? s.id === sessionId : !s.parent_id && s.time_updated >= now - hours * 3600000).sort((a, b) => b.time_updated - a.time_updated);
    const selected = new Set(roots.map(s => s.id));
    let added = true;
    while (added) { added = false; for (const s of sessions) if (selected.has(s.parent_id) && !selected.has(s.id)) { selected.add(s.id); added = true; } }
    const scopedApprovals = sessionId ? approvals.filter(p => selected.has(p.sessionID)) : approvals;
    const sourceMessages = [...upstream.messages.keys()].filter(id => !sessionId || selected.has(id)).flatMap(rows).filter(r => sessionId || Math.max(r.time_created, r.time_updated) >= upstream.cutoff());
    const grouped = new Map(), events = [], today = {}, hourly = Array.from({ length: 12 }, (_, i) => ({ time: Math.floor(now / 3600000) * 3600000 - (11 - i) * 3600000, models: {}, total: 0 }));
    let input = 0, cacheRead = 0;
    const addEvent = e => events.push(e);
    for (const r of sourceMessages) {
      if (!grouped.has(r.session_id)) grouped.set(r.session_id, []);
      grouped.get(r.session_id).push(r);
      const d = r.parsed;
      if (r.type === 'assistant') {
        const t = d.tokens || {}, model = modelId(d.model), tin = Number(t.input) || 0, out = Number(t.output) || 0, cache = Number(t.cache?.read) || 0;
        if (sessionId || r.time_created >= midnight) {
          const v = today[model] ||= { input: 0, output: 0, cacheRead: 0, total: 0, estimate: 0 };
          v.input += tin; v.output += out; v.cacheRead += cache; v.total += tin + out + cache;
          const p = rate(model); v.estimate += (tin * p.input + out * p.output + cache * p.cacheRead) / 1e6;
        }
        const bucket = hourly.find(b => r.time_created >= b.time && r.time_created < b.time + 3600000);
        if (bucket) { bucket.models[model] = (bucket.models[model] || 0) + tin + out + cache; bucket.total += tin + out + cache; }
        if (r.time_created >= now - hours * 3600000) { input += tin; cacheRead += cache; }
      }
    }
    const agents = sessions.filter(s => selected.has(s.id)).map(s => {
       const list = (grouped.get(s.id) || []).sort((a, b) => a.seq - b.seq);
       const freshKey = !!upstream.active[s.id] || now - (rows(s.id).at(-1)?.time_updated || s.time_updated) < 120000;
       const key = [upstream.sessions.get(s.id), upstream.messages.get(s.id), !!sessionId, list.length, list[0]?.id, list.at(-1)?.id, freshKey, !!upstream.active[s.id], approvals.some(p => p.sessionID === s.id)];
       const cached = agentCache.get(s.id);
       if (cached && key.every((value, i) => value === cached.key[i])) { events.push(...cached.events); return cached.agent; }
       const sessionEvents = [], addEvent = event => sessionEvents.push(event);
      // A dormant child may predate the aggregation window; retain its actual final state.
       const all = rows(s.id), latest = list.at(-1) || all.at(-1);
       const assistant = list.findLast(r => r.type === 'assistant') || all.findLast(r => r.type === 'assistant');
      const data = assistant?.parsed || json(assistant?.data);
       const contextData = data.tokens ? data : all.findLast(r => r.type === 'assistant' && r.parsed.tokens)?.parsed || data;
       const active = latest?.type === 'assistant' ? (data.content || []).filter(c => c.type === 'tool' && ['streaming', 'running', 'pending'].includes(c.state?.status)) : [];
       const fresh = upstream.active[s.id] || now - (latest?.time_updated || s.time_updated) < 120000;
       const currentTool = fresh && active.length ? toolInfo(active.at(-1), assistant.time_created) : null;
       const status = approvals.some(p => p.sessionID === s.id) ? 'waiting' : currentTool || upstream.active[s.id] ? 'working' : latest?.type === 'idle' && s.parent_id ? 'done' : 'idle';
      for (const r of list) {
        const d = r.parsed, common = { sessionId: s.id, agent: s.agent || clip(s.title).slice(0, 20) || 'untitled' };
        if (r.type === 'idle') addEvent({ ...common, time: r.time_created, kind: 'idle', text: clip(d.outcome || 'finished') });
        if (r.type !== 'assistant') continue;
        for (const c of d.content || []) {
          if (c.type === 'tool') {
            const t = toolInfo(c, r.time_created);
            addEvent({ ...common, time: t.since, kind: 'tool start', text: `${t.name} → ${t.target}` });
            if (['completed', 'error'].includes(c.state?.status)) addEvent({ ...common, time: c.time?.completed || c.state?.time?.end || r.time_updated, kind: c.state.status === 'error' ? 'tool error' : 'tool complete', text: `${t.name} → ${t.target}` });
          } else if (c.type === 'text' && c.text && d.finish) addEvent({ ...common, time: r.time_updated, kind: 'text', text: clip(c.text) });
        }
      }
      const model = modelId(json(s.model));
      const agent = { id: s.id, parentId: s.parent_id, agent: s.agent?.trim() || clip(s.title).slice(0, 20) || 'untitled', unnamed: !s.agent?.trim(), model, title: s.title, status, currentTool, tokens: { input: s.tokens_input || 0, output: s.tokens_output || 0, cacheRead: s.tokens_cache_read || 0 }, context: (contextData.tokens?.input || 0) + (contextData.tokens?.cache?.read || 0) + (contextData.tokens?.cache?.write || 0), contextEstimated: !data.tokens && !!contextData.tokens, contextLimit: rate(model).contextLimit || 200000, lastActivity: latest?.time_updated || s.time_updated };
      agentCache.set(s.id, { key, agent, events: sessionEvents }); events.push(...sessionEvents); return agent;
    });
     for (const p of scopedApprovals) addEvent({ sessionId: p.sessionID, agent: agents.find(a => a.id === p.sessionID)?.agent || 'agent', time: p.time, kind: 'permission asked', text: `${p.action} → ${p.resource}` });
    const eventSessions = new Set(events.map(e => e.sessionId));
    const visible = agents.filter(a => a.id === sessionId || !a.unnamed || Object.values(a.tokens).some(Boolean) || eventSessions.has(a.id));
    const importance = { waiting: 3, working: 2, idle: 1, done: 0 };
    const groups = [], sessionGroups = new Map();
    function groupChildren(parentIds, parentId) {
      const buckets = new Map();
      for (const a of visible.filter(a => parentIds.includes(a.parentId))) {
        // Unnamed sessions have distinct identities, even when their shortened titles match.
        const key = `${a.parentId}:${a.unnamed ? a.id : a.agent}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(a);
      }
      return [...buckets.values()].map(members => {
        const ordered = [...members].sort((a, b) => importance[b.status] - importance[a.status] || b.lastActivity - a.lastActivity);
        const active = ordered[0], id = `group:${[...members].map(a => a.id).sort()[0]}`;
        const group = { ...active, id, parentId, count: members.length, sessions: ordered, lastActivity: Math.max(...members.map(a => a.lastActivity)), tokens: Object.fromEntries(['input', 'output', 'cacheRead'].map(k => [k, members.reduce((n, a) => n + a.tokens[k], 0)])) };
        groups.push(group);
        for (const a of members) sessionGroups.set(a.id, group);
        return { id, groups: groupChildren(members.map(a => a.id), id) };
      });
    }
    const trees = roots.filter(s => visible.some(a => a.id === s.id)).map(s => {
      const root = visible.find(a => a.id === s.id);
      groups.push({ ...root, count: 1, sessions: [root] });
      sessionGroups.set(s.id, root);
      return { id: s.id, groups: groupChildren([s.id], s.id) };
    });
    const displayEvents = events.filter(e => sessionGroups.has(e.sessionId)).map(e => ({ ...e, agent: sessionGroups.get(e.sessionId).agent, groupId: sessionGroups.get(e.sessionId).id }));
    const heat = groups.map(a => ({ id: a.id, agent: a.agent, values: Array.from({ length: 12 }, (_, i) => displayEvents.filter(e => e.groupId === a.id && e.time >= now - (12 - i) * 300000 && e.time < now - (11 - i) * 300000).length) }));
    const countGroups = nodes => nodes.reduce((n, a) => n + 1 + countGroups(a.groups), 0);
    const countCalls = id => 1 + sessions.filter(s => s.parent_id === id).reduce((n, s) => n + countCalls(s.id), 0);
    const next = { windowHours: hours, roots: trees.map(t => { const s = groups.find(a => a.id === t.id); return { id: s.id, title: s.title, lastActivity: s.lastActivity, agentCount: 1 + countGroups(t.groups), callCount: countCalls(s.id) }; }), trees, agents: groups, events: displayEvents.sort((a, b) => a.time - b.time).slice(-200), aggregates: { hourly, cacheHit: input + cacheRead ? cacheRead / (input + cacheRead) : 0, heat, today, totalToday: Object.values(today).reduce((n, x) => n + x.total, 0), estimate: Object.values(today).reduce((n, x) => n + x.estimate, 0), ledger: groups.map(({ id, agent, status }) => ({ id, agent, status })) }, approvals, permissionHealth };
     return { ...next, approvals: scopedApprovals, updatedAt: now, serverVersion: upstream.version, connection: upstream.connection, demo: !!config.demo };
}
function stateFor(sessionId) {
  if (!sessionId) return snapshot;
   const state = scopedSnapshots.get(sessionId) || buildState(sessionId);
   scopedSnapshots.delete(sessionId); scopedSnapshots.set(sessionId, state);
   while (scopedSnapshots.size > 20) scopedSnapshots.delete(scopedSnapshots.keys().next().value);
   return state;
}
function refresh() {
  try {
     approvals = upstream.approvals.map(p => ({ ...p, action: clip(p.action), resource: clip(p.resource) })); permissionHealth = upstream.health;
     scopedSnapshots.clear();
     for (const id of rowCache.keys()) if (!upstream.sessions.has(id)) { rowCache.delete(id); agentCache.delete(id); }
    const next = buildState(), sig = JSON.stringify({ ...next, updatedAt: 0 });
    if (sig !== signature) { signature = sig; snapshot = next; }
    for (const client of clients) { const state = stateFor(client.sessionId), clientSig = JSON.stringify({ ...state, updatedAt: 0 }); if (client.signature !== clientSig && send(client, `event: state\ndata: ${JSON.stringify(state)}\n\n`)) client.signature = clientSig; }
  } catch { console.error('State refresh failed; retaining last snapshot.'); }
}
function schedule() { if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 250); }
function send(client, data) {
  if (client.destroyed) { clients.delete(client); return false; }
  if (client.blocked) return false;
  if (!client.write(data)) { client.blocked = true; client.once('drain', () => { client.blocked = false; }); }
  return true;
}
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
// Explicit allowlist: no arbitrary filesystem access for vendor/module URLs.
for (const file of ['flow-webgl.js', ...['three.module.min.js', 'three.core.min.js', ...['EffectComposer', 'RenderPass', 'UnrealBloomPass', 'OutputPass', 'ShaderPass', 'MaskPass', 'Pass'].map(name => `postprocessing/${name}.js`), ...['CopyShader', 'LuminosityHighPassShader', 'OutputShader'].map(name => `shaders/${name}.js`)].map(name => `vendor/three/${name}`)]) files[`/${file}`] = [file, 'text/javascript'];
const loadedScopes = new Set(), scopeLoads = new Map();
const staticCache = new Map(Object.entries(files).map(([url, [file, type]]) => [url, [readFileSync(join(base, 'public', file)), type]]));
const importmap = staticCache.get('/')[0].toString().match(/<script type="importmap">(.*?)<\/script>/s)?.[1];
const csp = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(importmap || '').digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
try { await upstream.start(); } catch (error) { upstream.stop(); clearTimeout(timer); throw error; }
refresh();
const heartbeat = setInterval(() => { for (const c of clients) { if (c.blocked) { clients.delete(c); c.destroy(); } else send(c, ': heartbeat\n\n'); } }, 15000);
const normalizeHost = host => host.toLowerCase().replace(/^\[|\]$/g, '');
const allowed = new Set(['localhost', '127.0.0.1', '::1', normalizeHost(config.host), ...(config.allowedHosts || []).map(normalizeHost)]);
function permitted(authority) { try { const url = new URL(`http://${authority}`); return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && allowed.has(normalizeHost(url.hostname)) && Number(url.port || 80) === server.address().port; } catch { return false; } }
const server = http.createServer(async (req, res) => {
  try {
  res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  if (!permitted(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden host'); }
  if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); return res.end('Invalid request URL'); }
  const url = new URL(req.url, 'http://localhost'), path = url.pathname, sessionId = url.searchParams.get('session');
  if (path.startsWith('/api/') && req.headers.origin) { let origin; try { origin = new URL(req.headers.origin); } catch {} if (!origin || origin.origin !== req.headers.origin || !['http:', 'https:'].includes(origin.protocol) || !permitted(origin.host)) { res.writeHead(403); return res.end('Forbidden origin'); } }
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); return res.end(); }
  if (sessionId && loadedScopes.has(sessionId) && ['/api/state', '/api/stream'].includes(path)) { loadedScopes.delete(sessionId); loadedScopes.add(sessionId); upstream.touchScope?.(sessionId); }
  if (sessionId && ['/api/state', '/api/stream'].includes(path) && !loadedScopes.has(sessionId)) {
    if (!/^ses_[\w-]+$/.test(sessionId)) { res.writeHead(400); return res.end('Invalid session ID'); }
    try {
      if (!scopeLoads.has(sessionId)) scopeLoads.set(sessionId, upstream.ensureTree(sessionId).then(() => { loadedScopes.add(sessionId); while (loadedScopes.size > 20) loadedScopes.delete(loadedScopes.values().next().value); refresh(); }).finally(() => scopeLoads.delete(sessionId)));
      await scopeLoads.get(sessionId);
    } catch { res.writeHead(502); return res.end('Unable to load OpenCode session'); }
  }
  if (path === '/api/stream') {
    if (clients.size >= 32) { res.writeHead(503); return res.end('Too many clients'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.sessionId = sessionId;
    const state = stateFor(sessionId); res.signature = JSON.stringify({ ...state, updatedAt: 0 });
    clients.add(res); send(res, `event: state\ndata: ${JSON.stringify(state)}\n\n`); req.on('close', () => clients.delete(res)); return;
  }
  if (path === '/api/sessions') {
    if (!snapshot) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('[]'); }
    const list = snapshot.roots.map(root => {
      const ids = new Set([root.id]);
      let added = true;
      while (added) { added = false; for (const a of snapshot.agents) if (ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); added = true; } }
      const agents = snapshot.agents.filter(a => ids.has(a.id)), lead = agents.find(a => a.id === root.id);
      return { ...root, agent: lead.agent, model: lead.model, lastActivity: Math.max(...agents.map(a => a.lastActivity)), tokens: agents.reduce((n, a) => n + a.tokens.input + a.tokens.output + a.tokens.cacheRead, 0), status: agents.some(a => ['working', 'waiting'].includes(a.status)) ? 'working' : 'idle' };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  if (path === '/api/state' || path === '/api/permission/request') {
    res.writeHead(path === '/api/permission/request' && !permissionHealth.ok ? 502 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(path === '/api/state' ? stateFor(sessionId) : { location: null, data: approvals }));
  }
  if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (staticCache.has(path)) { const [data, type] = staticCache.get(path); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(data); }
  res.writeHead(404); res.end('Not found');
  } catch (error) { console.error('HTTP request failed:', error.name); if (!res.headersSent) { res.writeHead(error instanceof URIError || error instanceof TypeError ? 400 : 500); res.end('Request failed'); } else res.destroy(); }
});
server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nX-Frame-Options: DENY\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src \'none\'\r\n\r\n'); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, config.host, resolve); }).catch(error => { upstream.stop(); clearInterval(heartbeat); clearTimeout(timer); throw error; });
console.log(`opencode-agent-flow http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${server.address().port}${config.demo ? ' (demo)' : ` · OpenCode ${upstream.version || 'connecting'}`}`);
let stopping = false;
function stop() { upstream.stop(); clearInterval(heartbeat); clearTimeout(timer); for (const c of clients) c.end(); server.close(); server.closeAllConnections(); process.removeListener('SIGTERM', signalStop); process.removeListener('SIGINT', signalStop); }
function signalStop() { if (stopping) process.exit(0); stopping = true; stop(); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', signalStop); process.on('SIGINT', signalStop);
return { server, stop };
}
