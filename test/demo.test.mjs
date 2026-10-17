import test from 'node:test';
import assert from 'node:assert/strict';
import { demo } from '../lib/demo.mjs';

test('demo cycles tools, working states and bounded events; start/stop are idempotent', async () => {
  let advance, scheduled = 0, cancelled = 0, changes = 0, now = Date.now();
  const state = demo(() => changes++, {
    interval(callback, ms) { assert.equal(ms, 1500); advance = callback; scheduled++; return 1; },
    cancel(id) { assert.equal(id, 1); cancelled++; }, clock: () => now
  });
  await state.start(); await state.start(); assert.equal(scheduled, 1);
  const oldMessages = state.messages.get('ses_demo1');
  const oldSession = state.sessions.get('ses_demo1');
  for (let i = 0; i < 30; i++) { now += 1500; advance(); }
  assert.equal(changes, 30);
  assert.notEqual(state.messages.get('ses_demo1'), oldMessages);
  assert.notEqual(state.sessions.get('ses_demo1'), oldSession);
  assert.equal(state.messages.get('ses_demo1').length, 12);
  assert.equal(state.messages.get('ses_demo1').at(-1).time.created, now);
  assert(Object.keys(state.active).length >= 4);
  assert(new Set(state.messages.get('ses_demo1').map(m => m.content[0].name)).size > 3);
  assert(state.messages.get('ses_demo1').slice(0, -1).every(m => m.content[0].state.status === 'completed'));
  state.stop(); state.stop(); assert.equal(cancelled, 1);
});
