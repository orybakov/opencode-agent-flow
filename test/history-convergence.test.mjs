import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Upstream } from '../lib/upstream.mjs';
import { EventFrames } from '../lib/event-frames.mjs';

const waitFor = async predicate => { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

async function fixture(ids = ['ses_test'], config = {}) {
  const now = Date.now(), data = new Map(ids.map(id => [id, Array.from({ length: 100 }, (_, i) => ({ id: `msg_${i}`, type: 'assistant', model: 'test', time: { created: now - 100000 + i }, tokens: { input: 1 }, finish: 'stop', content: [{ type: 'text', text: `message ${i}` }] })).reverse()]));
  const sessions = ids.map(id => ({ id, agent: id, time: { updated: now } }));
  const state = { ignoreLimit: false, running: 0, maximum: 0, messageCalls: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/session') return json({ data: url.searchParams.has('parentID') ? [] : sessions });
    const session = sessions.find(s => url.pathname === `/api/session/${s.id}`); if (session) return json({ data: session });
    const id = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/message') && data.has(id)) {
      state.messageCalls++; state.running++; state.maximum = Math.max(state.maximum, state.running);
      const messages = data.get(id), offset = Number(url.searchParams.get('cursor') || 0), size = state.ignoreLimit ? messages.length : Number(url.searchParams.get('limit'));
      res.on('finish', () => state.running--);
      return json({ data: messages.slice(offset, offset + size), cursor: { next: offset + size < messages.length ? String(offset + size) : null } });
    }
    return json({ data: url.pathname === '/api/session/active' ? {} : [] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new Upstream({ server: `http://127.0.0.1:${server.address().port}`, window: 4, ...config }, () => {});
  for (const session of sessions) { client.sessions.set(session.id, session); await client.loadMessages(session.id, true); }
  const total = id => client.summaries.get(id)?.all.get('test')?.input;
  const truth = id => data.get(id).reduce((n, m) => n + m.tokens.input, 0);
  const close = async () => { client.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); };
  return { client, data, total, truth, state, close };
}

test('an SSE update of an older base message rebuilds via the real loadMessages path', async () => {
  const f = await fixture();
  try {
    const old = f.data.get('ses_test')[90]; assert(!f.client.histories.get('ses_test').tail.has(old.id));
    old.tokens.input = 77;
    f.client.event({ type: 'session.usage.updated', data: { sessionID: 'ses_test', assistantMessageID: old.id } });
    await waitFor(() => f.total('ses_test') === f.truth('ses_test'));
    assert.equal(f.total('ses_test'), 176);
    assert(f.state.messageCalls >= 20);
  } finally { await f.close(); }
});

test('reverted and deleted newest messages do not survive as tail ghosts', async () => {
  const f = await fixture();
  try {
    f.data.get('ses_test').splice(0, 6);
    await f.client.loadMessages('ses_test', true, true);
    assert.equal(f.total('ses_test'), 94); assert.equal(f.total('ses_test'), f.truth('ses_test'));
    assert(!f.client.histories.get('ses_test').tail.has('msg_99'));
    // A normal ten-row page now crosses the tail/base boundary. Its older base
    // rows must not be imported into the mutable tail or counted twice.
    f.data.get('ses_test').splice(0, 25);
    await f.client.loadMessages('ses_test', true, true);
    assert.equal(f.total('ses_test'), 69); assert.equal(f.client.histories.get('ses_test').tail.size, 1);
    f.data.get('ses_test').splice(0, 1);
    await f.client.loadMessages('ses_test', true, true);
    assert.equal(f.total('ses_test'), 68); assert.equal(f.total('ses_test'), f.truth('ses_test'));
  } finally { await f.close(); }
});

test('staggered periodic audits heal unhinted old edits despite unchanged session versions', async () => {
  const f = await fixture(['ses_a', 'ses_b', 'ses_c'], { historyRebuildInterval: 120 });
  try {
    const deadlines = [];
    for (const [id, history] of f.client.histories) {
      deadlines.push(history.nextFullAt);
      assert(history.nextFullAt - history.rebuiltAt >= 60 && history.nextFullAt - history.rebuiltAt <= 120);
      f.data.get(id)[90].tokens.input = 25;
    }
    assert(new Set(deadlines).size > 1);
    await f.client.sync();
    await waitFor(() => [...f.data.keys()].every(id => f.total(id) === f.truth(id)));
    assert([...f.data.keys()].every(id => f.total(id) === 124));
    assert.equal(f.state.maximum, 1);
    // Recent traffic must not slide the absolute rebuild deadline forward.
    const history = f.client.histories.get('ses_a'), deadline = history.nextFullAt;
    await f.client.loadMessages('ses_a', true, true);
    if (f.client.histories.get('ses_a').rebuiltAt === history.rebuiltAt) assert.equal(f.client.histories.get('ses_a').nextFullAt, deadline);
  } finally { await f.close(); }
});

test('a server ignoring the page limit falls back to an authoritative rebuild without double counting', async () => {
  const f = await fixture();
  try {
    f.state.ignoreLimit = true; f.data.get('ses_test')[90].tokens.input = 77;
    const before = f.state.messageCalls;
    await f.client.loadMessages('ses_test', true, true);
    assert.equal(f.total('ses_test'), 176); assert.equal(f.total('ses_test'), f.truth('ses_test'));
    assert.equal(f.state.messageCalls - before, 2);
    await f.client.loadMessages('ses_test', true, true);
    assert.equal(f.total('ses_test'), 176);
  } finally { await f.close(); }
});

test('an ID split across a discarded block forces recovery of an unidentified session', async () => {
  const f = await fixture(['ses_test', 'ses_other']);
  try {
    f.data.get('ses_other')[90].tokens.input = 77;
    const frame = `data: ${JSON.stringify({ data: { sessionID: 'ses_test', padding: 'x'.repeat(200), nested: { sessionID: 'ses_other' } } })}\n\n`;
    const split = frame.lastIndexOf('sessionID') + 4, decoder = new EventFrames(100);
    decoder.push(frame.slice(0, split)); const batch = decoder.push(frame.slice(split));
    assert.deepEqual(batch.sessionIds, ['ses_test']); assert.equal(batch.unknownOverflow, true);
    f.client.oversized(batch);
    await waitFor(() => f.total('ses_other') === f.truth('ses_other'));
    assert.equal(f.total('ses_other'), 176);
    await waitFor(() => !f.client.syncing && f.client.loads.size === 0);
  } finally { await f.close(); }
});

test('the 16-ID extraction cap forces recovery of the omitted seventeenth session', async () => {
  const ids = Array.from({ length: 17 }, (_, i) => `ses_${i}`), f = await fixture(ids);
  try {
    f.data.get('ses_16')[90].tokens.input = 77;
    const batch = new EventFrames(100).push(`data: ${JSON.stringify(ids.map(sessionID => ({ sessionID })))}\n\n`);
    assert.equal(batch.sessionIds.length, 16); assert(!batch.sessionIds.includes('ses_16')); assert.equal(batch.unknownOverflow, true);
    f.client.oversized(batch);
    await waitFor(() => f.total('ses_16') === f.truth('ses_16'));
    assert.equal(f.total('ses_16'), 176);
    await waitFor(() => !f.client.syncing && f.client.loads.size === 0);
  } finally { await f.close(); }
});
