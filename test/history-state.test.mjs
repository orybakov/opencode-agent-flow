import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from '../server.mjs';

test('state heat counts all events before the display tail is truncated', async () => {
  const now = Date.now(), root = { id: 'ses_heat', agent: 'fixture', title: 'Heat fixture', time: { updated: now } };
  const message = { id: 'msg_heat', type: 'assistant', finish: 'stop', time: { created: now - 60000, completed: now }, tokens: { input: 100, output: 10, cache: { read: 20 } }, content: [...Array.from({ length: 1000 }, (_, i) => ({ type: 'tool', name: 'read', time: { created: now - 60000 + i, completed: now - 59999 + i }, state: { status: 'completed', input: { path: '/fixture' }, output: 'discarded' } })), { type: 'text', text: 'done' }] };
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    const reply = data => res.end(JSON.stringify(data));
    if (url.pathname === '/api/info') return reply({ version: '2.0.30' });
    if (url.pathname === '/api/event') { res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n'); return; }
    if (url.pathname === '/api/session') return reply({ data: url.searchParams.has('parentID') ? [] : [root] });
    if (url.pathname.endsWith('/message')) return reply({ data: [message] });
    return reply({ data: {} });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = await start({ server: `http://127.0.0.1:${upstream.address().port}`, window: 4, port: 0, host: '127.0.0.1' });
  try {
    let state; const deadline = Date.now() + 5000;
    do {
      state = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`)).json();
      if (state.events.length) break;
      if (Date.now() > deadline) throw new Error('Timed out waiting for history reduction');
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    assert.equal(state.events.length, 200);
    assert.equal(state.aggregates.heat[0].values.reduce((n, x) => n + x, 0), 2001);
    assert.equal(state.aggregates.totalToday, 130);
    assert(!JSON.stringify(state).includes('discarded'));
  } finally { app.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
