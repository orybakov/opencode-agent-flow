import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../server.mjs';

test('demo preserves grouped browser contracts without credentials or upstream access', async () => {
  const app = await start({ demo: true, window: 4, port: 0, host: '127.0.0.1', password: 'fixture-secret-never-exposed' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(`${base}/api/state?session=ses_demo0`);
    assert.equal(response.status, 200);
    const text = await response.text(), state = JSON.parse(text);
    assert(!text.includes('fixture-secret-never-exposed'));
    assert.equal(state.serverVersion, '2.0.30');
    assert.equal(state.roots[0].agentCount, 6);
    assert.equal(state.roots[0].callCount, 7);
    assert.equal(state.agents.find(a => a.agent === 'builder').count, 2);
    assert(state.events.every(e => e.groupId));
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions[0].agentCount, 6);
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/api/state?session=invalid`)).status, 400);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream?session=ses_demo0`, { signal: controller.signal });
    const reader = stream.body.getReader(), first = await reader.read();
    assert(new TextDecoder().decode(first.value).startsWith('event: state\ndata: '));
    controller.abort(); await reader.cancel().catch(() => {});
  } finally { app.stop(); app.server.closeAllConnections(); }
});
