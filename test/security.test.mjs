import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { start } from '../server.mjs';
import { clip } from '../lib/privacy.mjs';
import { Upstream, reconnectDelay, trimMessage } from '../lib/upstream.mjs';

test('malformed request survives, Host/Origin are checked, security headers cover errors', async () => {
  const app = await start({ demo: true, window: 4, port: 0, host: '127.0.0.1' });
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const raw = await new Promise((resolve, reject) => { let data = ''; const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)); socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); socket.on('error', reject); });
    assert.match(raw, /400 Bad Request/);
    // Node's fetch implementation may synthesize Host; use the native HTTP client.
    const bad = await new Promise(resolve => http.get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res); }));
    assert.equal(bad.statusCode, 403);
    assert.equal(bad.headers['x-frame-options'], 'DENY');
    assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: base } })).status, 200);
    const good = await fetch(`${base}/api/sessions`);
    assert.equal(good.status, 200);
    assert.match(good.headers.get('content-security-policy'), /sha256-/);
    assert.equal(good.headers.get('referrer-policy'), 'no-referrer');
  } finally { app.stop(); }
});

test('best-effort display redaction covers common secret formats', () => {
  for (const input of ['Authorization: Bearer privatevalue', 'bearer privatevalue', '-u user:privatevalue', '--password privatevalue', '--token privatevalue', '"password":"privatevalue"', 'api_key=privatevalue', 'api-key: privatevalue', 'apikey=privatevalue', 'sk-privatevalue', 'ghp_privatevalue', 'github_pat_privatevalue', 'xoxb-privatevalue', 'xoxp-privatevalue', 'AKIAPRIVATEVALUE12345']) {
    const result = clip(input);
    assert.match(result, /\[redacted\]/, input);
    assert(!/privatevalue/i.test(result), input);
  }
});

test('eviction drops out-of-window sessions and recent message tails; deleted session cannot resurrect', async () => {
  const upstream = new Upstream({ window: 4 }, () => {});
  const now = Date.now();
  upstream.sessions.set('old', { id: 'old', time: { updated: 1 } }); upstream.messages.set('old', [{ time: { created: 1 } }]);
  upstream.sessions.set('new', { id: 'new', time: { updated: now } }); upstream.messages.set('new', [{ id: 'stale', time: { created: 1 } }, { id: 'fresh', time: { created: now } }]);
  upstream.evict();
  assert(!upstream.sessions.has('old')); assert(!upstream.messages.has('old'));
  assert.equal(upstream.messages.get('new').length, 1);
  upstream.pages = async () => { upstream.removeSession('new'); return [{ id: 'race', time: { created: now } }]; };
  await upstream.loadMessages('new', false, true); assert(!upstream.messages.has('new'));
  const small = trimMessage({ content: [{ type: 'tool', state: { output: 'huge secret', input: { command: 'x'.repeat(10000), unrelated: 'secret' } } }] });
  assert.equal(small.content[0].state.output, undefined); assert.equal(small.content[0].state.input.command.length, 300); assert.equal(small.content[0].state.input.unrelated, undefined);
  upstream.stop();
});

test('backoff reset uses injected time and requires 30 seconds of connection lifetime', () => {
  assert.equal(reconnectDelay(16000, 1000, 30999), 16000);
  assert.equal(reconnectDelay(16000, 1000, 31000), 1000);
  assert.equal(reconnectDelay(16000, undefined, 999999), 16000);
});

test('sync excludes the stale pagination boundary and recent updates trim old history', async () => {
  const upstream = new Upstream({ window: 4 }, () => {}), now = Date.now();
  const fresh = { id: 'fresh', time: { updated: now } }, stale = { id: 'stale', time: { updated: 1 } };
  upstream.pages = async path => path === '/api/session' ? [fresh, stale] : [];
  upstream.get = async () => ({ data: {} });
  await upstream.sync();
  assert(upstream.sessions.has('fresh')); assert(!upstream.sessions.has('stale'));
  upstream.messages.set('fresh', [{ id: 'old', time: { created: 1 } }]);
  upstream.pages = async () => [{ id: 'new', type: 'assistant', time: { created: now } }];
  await upstream.loadMessages('fresh', false, true);
  assert.deepEqual(upstream.messages.get('fresh').map(m => m.id), ['new']); upstream.stop();
});

test('full-history scopes use a bounded LRU', async () => {
  const upstream = new Upstream({ window: 4 }, () => {});
  upstream.loadSession = async id => upstream.sessions.set(id, { id, time: { updated: 1 } });
  upstream.descendants = async ids => new Set(ids); upstream.loadMessages = async () => {};
  for (let i = 0; i < 4; i++) await upstream.ensureTree(`ses_${i}`);
  upstream.touchScope('ses_0'); await upstream.ensureTree('ses_4');
  assert.equal(upstream.historyScopes.size, 4); assert(upstream.fullHistory.has('ses_0')); assert(!upstream.fullHistory.has('ses_1'));
  upstream.evict(); assert(!upstream.sessions.has('ses_1')); upstream.stop();
});

test('full-history scope retention expires after five minutes', async () => {
  const upstream = new Upstream({ window: 4 }, () => {});
  upstream.loadSession = async id => upstream.sessions.set(id, { id, time: { updated: 1 } });
  upstream.descendants = async ids => new Set(ids); upstream.loadMessages = async () => {};
  await upstream.ensureTree('ses_expire');
  upstream.pruneScopes(Date.now() + 300001);
  assert.equal(upstream.historyScopes.size, 0); assert.equal(upstream.fullHistory.size, 0);
  upstream.evict(); assert(!upstream.sessions.has('ses_expire')); upstream.stop();
});

test('unchanged permission polls do not schedule refreshes', async () => {
  let changes = 0;
  const upstream = new Upstream({ window: 4 }, () => { changes++; });
  await upstream.pollPending(); await upstream.pollPending();
  assert.equal(changes, 1); upstream.stop();
});

test('state redacts and bounds titles/targets, and stale unfinished tools are idle', async () => {
  const now = Date.now();
  const roots = ['fresh', 'stale'].map((name, i) => ({ id: `ses_${name}`, title: `password=privatevalue ${'x'.repeat(500)}`, agent: name, time: { updated: now - i * 180000 } }));
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    const reply = data => res.end(JSON.stringify(data));
    if (url.pathname === '/api/info') return reply({ version: '2.0.30' });
    if (url.pathname === '/api/event') { res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n'); return; }
    if (url.pathname === '/api/session') return reply({ data: url.searchParams.has('parentID') ? [] : roots });
    if (url.pathname.endsWith('/message')) { const stale = url.pathname.includes('ses_stale'), time = now - (stale ? 180000 : 0); return reply({ data: [{ id: 'msg', type: 'assistant', time: { created: time }, content: [{ type: 'tool', name: 'bash', state: { status: 'running', input: { command: 'Authorization: Bearer privatevalue' } } }] }] }); }
    return reply({ data: {} });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const app = await start({ server: `http://127.0.0.1:${mock.address().port}`, window: 4, port: 0, host: '127.0.0.1' });
  try {
    let state; const until = Date.now() + 3000;
    do { state = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`)).json(); if (state.agents.length === 2) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < until);
    assert.equal(state.agents.length, 2);
    assert(!JSON.stringify(state).includes('privatevalue'));
    assert(state.roots.every(root => root.title.length <= 180));
    assert.equal(state.agents.find(agent => agent.agent === 'fresh').status, 'working');
    const stale = state.agents.find(agent => agent.agent === 'stale'); assert.equal(stale.status, 'idle'); assert.equal(stale.currentTool, null);
  } finally { app.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
});
