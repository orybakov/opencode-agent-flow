import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Upstream } from '../lib/upstream.mjs';
import { EventFrames } from '../lib/event-frames.mjs';

const waitFor = async predicate => { const deadline = Date.now() + 6000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture() {
  const now = Date.now(), streams = new Set(), calls = [];
  const state = { generation: 0, hold: null, listHold: null, messageCalls: 0, permissionCalls: 0, messages: Array.from({ length: 80 }, (_, i) => ({ id: `msg_${i}`, type: 'assistant', model: 'test', time: { created: now - 100000 + i, completed: now - 99999 + i }, finish: 'stop', tokens: { input: i + 1 }, content: [{ type: 'text', text: `result ${i}` }] })).reverse() };
  const session = () => ({ id: 'ses_test', time: { updated: now + state.generation }, location: { directory: '/fixture' } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); calls.push(url);
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/info') return json({ version: '2.0.30' });
    if (url.pathname === '/api/event') { streams.add(res); res.on('close', () => streams.delete(res)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    if (url.pathname === '/api/session') { if (state.listHold) await state.listHold.promise; return json({ data: url.searchParams.has('parentID') ? [] : [session()] }); }
    if (url.pathname === '/api/session/ses_test') return json({ data: session() });
    if (url.pathname.endsWith('/message')) {
      state.messageCalls++; if (state.hold) await state.hold.promise;
      const offset = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
      return json({ data: state.messages.slice(offset, offset + limit), cursor: { next: offset + limit < state.messages.length ? String(offset + limit) : null } });
    }
    if (url.pathname === '/api/permission/request') { state.permissionCalls++; return json({ data: [] }); }
    return json({ data: url.pathname === '/api/session/active' ? {} : [] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new Upstream({ server: `http://127.0.0.1:${server.address().port}`, window: 4, resyncInterval: 300 }, () => {});
  await client.start(); await waitFor(() => client.connection === 'connected'); await client.sync();
  const emit = count => { for (const stream of streams) stream.write(Array.from({ length: count }, () => `data: ${JSON.stringify({ type: 'session.usage.updated', data: { sessionID: 'ses_test' } })}\n\n`).join('')); };
  const close = async () => { state.hold?.resolve(); state.listHold?.resolve(); client.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); };
  const raw = text => { for (const stream of streams) stream.write(text); };
  return { state, client, calls, emit, raw, close, now };
}

test('real SSE replaces mutable contributions and fetches only the newest known page', async () => {
  const f = await fixture();
  try {
    const before = f.state.messageCalls;
    f.state.messages[0].tokens.input = 999; f.state.messages[0].content[0].text = 'updated'; f.state.generation++;
    f.emit(50);
    await waitFor(() => f.client.summaries.get('ses_test').all.get('test').input === 3240 - 80 + 999);
    await waitFor(() => f.client.loads.size === 0);
    assert.equal(f.state.messageCalls - before, 1);
    assert.equal(f.client.messageVersions.get('ses_test'), f.now + 1);
    const events = f.client.summaries.get('ses_test').displayEvents(true, 0);
    assert.equal(events.length, 80); assert.equal(events.at(-1).text, 'updated');
    const next = f.state.messageCalls; await f.client.sync(); assert.equal(f.state.messageCalls, next);
    // Tail rollover transfers older contributions into the base once.
    f.state.messages.unshift(...Array.from({ length: 3 }, (_, i) => ({ id: `msg_new_${2-i}`, type: 'assistant', model: 'test', time: { created: f.now + 2 - i }, tokens: { input: 10 } })));
    f.state.generation++; f.emit(1);
    await waitFor(() => f.client.summaries.get('ses_test').all.get('test').input === 3240 - 80 + 999 + 30);
    assert.equal(f.client.histories.get('ses_test').tail.size, 32);
    await waitFor(() => f.client.loads.size === 0);
    // A gap larger than the retained tail must fall back to a complete scan.
    f.state.messages.unshift(...Array.from({ length: 40 }, (_, i) => ({ id: `msg_burst_${39-i}`, type: 'assistant', model: 'test', time: { created: f.now + 100 - i }, tokens: { input: 10 } })));
    f.state.generation++; f.emit(1);
    const expected = 3240 - 80 + 999 + 30 + 400;
    await waitFor(() => f.client.summaries.get('ses_test').all.get('test').input === expected);
    await waitFor(() => f.client.loads.size === 0);
    assert.equal(f.client.histories.get('ses_test').tail.size, 32);
    f.state.messages.at(-1).tokens.input = 500;
    await f.client.sync(true);
    assert.equal(f.client.summaries.get('ses_test').all.get('test').input, expected + 499);
  } finally { await f.close(); }
});

test('one running load plus a repeat flag coalesces bursts; control requests bypass history', async () => {
  const f = await fixture();
  try {
    const before = f.state.messageCalls; f.state.hold = deferred(); f.emit(1);
    await waitFor(() => f.state.messageCalls === before + 1);
    f.emit(100);
    const shared = Array.from({ length: 100 }, () => f.client.loadMessages('ses_test', false, true));
    assert(shared.every(promise => promise === shared[0]));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.client.loads.size, 1); assert.equal(f.client.queue.length, 0);
    const permissions = f.state.permissionCalls;
    await Promise.race([Promise.all([f.client.pollPending(), f.client.descendants(['ses_test'])]), new Promise((_, reject) => setTimeout(() => reject(new Error('control plane blocked by history')), 1000))]);
    assert(f.state.permissionCalls > permissions);
    f.state.hold.resolve(); f.state.hold = null;
    await Promise.all(shared); await waitFor(() => f.client.loads.size === 0);
    assert.equal(f.state.messageCalls - before, 2);
  } finally { await f.close(); }
});

test('unknown oversized events preserve a pending force across sync and throttle repeats', async () => {
  const f = await fixture();
  try {
    const forced = [], original = f.client.sync;
    f.client.sync = function(force) { if (force && !this.syncing) forced.push(Date.now()); return original.call(this, force); };
    f.state.listHold = deferred();
    const initial = f.client.sync();
    f.raw(`data: ${JSON.stringify({ type: 'unknown', data: { output: 'x'.repeat(70000) } })}\n\n`);
    await waitFor(() => f.client.pendingForce);
    for (let i = 0; i < 50; i++) f.client.oversized({ overflow: true });
    assert.equal(f.client.pendingForce, true); assert.equal(forced.length, 0);
    f.state.listHold.resolve(); f.state.listHold = null; await initial;
    await waitFor(() => forced.length === 1 && !f.client.syncing);
    f.state.listHold = deferred(); const blocked = f.client.sync();
    for (let i = 0; i < 50; i++) f.client.oversized({ overflow: true });
    f.state.listHold.resolve(); f.state.listHold = null; await blocked;
    await waitFor(() => forced.length === 2 && !f.client.syncing);
    assert(forced[1] - forced[0] >= 290);
    await new Promise(r => setTimeout(r, 350)); assert.equal(forced.length, 2);
    const count = forced.length, calls = f.state.messageCalls;
    const known = new EventFrames().push(`data: ${JSON.stringify({ type: 'session.tool.success', data: { sessionID: 'ses_test', output: 'x'.repeat(70000) } })}\n\n`);
    assert(!known.unknownOverflow); f.client.oversized(known);
    await waitFor(() => f.state.messageCalls > calls && f.client.loads.size === 0 && f.client.dirty.size === 0);
    assert.equal(forced.length, count);
  } finally { await f.close(); }
});

test('native HTTP rejects redirects and URL credentials and requests identity encoding', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; assert.equal(req.headers['accept-encoding'], 'identity'); res.writeHead(302, { Location: '/other' }); res.end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`, client = new Upstream({ server: url }, () => {});
  try {
    await assert.rejects(client.get('/redirect'), /redirects are not allowed/); assert.equal(calls, 1);
    client.config.server = url.replace('http://', 'http://name:private@');
    await assert.rejects(client.get('/'), /must not contain credentials/); assert.equal(calls, 1);
  } finally { client.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
