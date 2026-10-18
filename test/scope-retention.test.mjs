import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from '../server.mjs';
import { Upstream } from '../lib/upstream.mjs';

const waitFor = async predicate => { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('active SSE scope survives six HTTP scopes and heartbeat restores a lost history', async () => {
  const now = Date.now(), roots = Array.from({ length: 7 }, (_, i) => ({ id: `ses_scope${i}`, agent: `agent${i}`, time: { updated: now } }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/info') return json({ version: '2.0.30' });
    if (url.pathname === '/api/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    if (url.pathname === '/api/session') return json({ data: url.searchParams.has('parentID') ? [] : roots });
    if (url.pathname.endsWith('/message')) return json({ data: [{ id: 'msg_recent', type: 'assistant', time: { created: now }, tokens: { input: 20 } }, { id: 'msg_old', type: 'assistant', time: { created: now - 86400000 }, tokens: { input: 10 } }] });
    const root = roots.find(r => url.pathname === `/api/session/${r.id}`); if (root) return json({ data: root });
    return json({ data: {} });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let upstream, restores = 0;
  const original = Upstream.prototype.ensureTree;
  Upstream.prototype.ensureTree = function(id) { upstream = this; if (id === 'ses_scope0') restores++; return original.call(this, id); };
  const app = await start({ server: `http://127.0.0.1:${server.address().port}`, port: 0, host: '127.0.0.1', window: 4, heartbeatInterval: 20 });
  const url = `http://127.0.0.1:${app.server.address().port}`, controller = new AbortController(), totals = [];
  let reader, consume;
  try {
    const stream = await fetch(`${url}/api/stream?session=ses_scope0`, { signal: controller.signal }); reader = stream.body.getReader();
    consume = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read(); if (done) return;
        buffer += decoder.decode(value, { stream: true }); let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (frame.startsWith('event: state')) totals.push(JSON.parse(frame.split('data: ')[1]).aggregates.totalToday); }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    await waitFor(() => totals.length > 0); assert.equal(totals[0], 30);
    for (let round = 0; round < 2; round++) for (let i = 1; i <= 6; i++) {
      const state = await (await fetch(`${url}/api/state?session=ses_scope${i}`)).json(); assert.equal(state.aggregates.totalToday, 30);
    }
    assert(upstream.historyScopes.has('ses_scope0')); assert(upstream.historyScopes.size <= 4);
    // Simulate eviction/corruption, including loss of the prior complete data.
    upstream.historyScopes.delete('ses_scope0'); upstream.pruneScopes();
    upstream.histories.delete('ses_scope0'); upstream.summaries.delete('ses_scope0'); upstream.messages.delete('ses_scope0');
    await waitFor(() => restores >= 2 && upstream.fullHistory.has('ses_scope0') && upstream.summaries.get('ses_scope0')?.all.get('unknown')?.input === 30);
    const restored = await (await fetch(`${url}/api/state?session=ses_scope0`)).json(); assert.equal(restored.aggregates.totalToday, 30);
    assert(totals.every(value => value === 30));
  } finally {
    controller.abort(); await consume; await reader?.cancel().catch(() => {});
    app.stop(); Upstream.prototype.ensureTree = original; server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});
