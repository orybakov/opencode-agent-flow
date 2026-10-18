import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageSummary, modelId, toolInfo } from '../lib/message-summary.mjs';
import { trimMessage, Upstream } from '../lib/upstream.mjs';
import { clip } from '../lib/privacy.mjs';

test('history reduction matches the former message-loop aggregates, events and heat', () => {
  const now = Date.now(), cutoff = now - 12 * 3600000;
  const fixture = Array.from({ length: 1200 }, (_, i) => {
    const created = now - (1200 - i) * 30000;
    return { id: `msg_${i}`, type: 'assistant', model: { modelID: `model_${i % 2}` }, time: { created, completed: created + 100 }, finish: 'stop', tokens: { input: i, output: 3, cache: { read: i % 7, write: 5 } }, content: [{ type: 'tool', name: 'read', time: { created, completed: created + 50 }, state: { status: i % 3 ? 'completed' : 'error', input: { filePath: '/fixture' }, output: 'not retained' } }, { type: 'text', text: `Result ${i}` }] };
  });
  fixture.unshift({ id: 'msg_old', type: 'assistant', model: 'old-model', time: { created: 1 }, tokens: { input: 999, output: 1 }, content: [] });
  const summary = new MessageSummary({ now, full: true, cutoff, hours: 4 });
  for (const m of [...fixture].reverse()) summary.add(trimMessage(m));
  const representatives = summary.finish();
  const all = new Map(), hourly = new Map(), days = new Map(), window = new Map(), events = [], heat = new Map();
  // Reference is the previous server's unbounded, per-message calculation.
  for (const m of fixture) {
    const model = modelId(m.model), t = m.tokens || {}, created = m.time.created, updated = m.time.completed || created;
    const add = map => { const v = map.get(model) || { input: 0, output: 0, cacheRead: 0 }; v.input += t.input || 0; v.output += t.output || 0; v.cacheRead += t.cache?.read || 0; map.set(model, v); };
    add(all);
    const hour = Math.floor(created / 3600000) * 3600000;
    if (hour >= Math.floor(now / 3600000) * 3600000 - 11 * 3600000) { if (!hourly.has(hour)) hourly.set(hour, new Map()); add(hourly.get(hour)); }
    const day = new Date(created).setHours(0, 0, 0, 0);
    if (day >= new Date(now).setHours(0, 0, 0, 0)) { if (!days.has(day)) days.set(day, new Map()); add(days.get(day)); }
    if (created >= now - 4 * 3600000) window.set(created, [t.input || 0, t.cache?.read || 0]);
    const event = e => { events.push(e); if (e.time >= now - 3600000) heat.set(e.time, (heat.get(e.time) || 0) + 1); };
    for (const c of m.content) {
      if (c.type === 'tool') { const info = toolInfo(c, created), text = `${info.name} → ${info.target}`; event({ time: info.since, kind: 'tool start', text }); event({ time: c.time.completed || updated, kind: c.state.status === 'error' ? 'tool error' : 'tool complete', text }); }
      if (c.type === 'text' && m.finish) event({ time: updated, kind: 'text', text: clip(c.text) });
    }
  }
  assert.deepEqual(summary.all, all); assert.deepEqual(summary.hourly, hourly); assert.deepEqual(summary.days, days); assert.deepEqual(summary.window, window); assert.deepEqual(summary.heat, heat);
  assert.deepEqual(summary.displayEvents(true, cutoff), events.sort((a, b) => a.time - b.time).slice(-200));
  assert(representatives.length <= 3); assert.equal(representatives.at(-1).id, 'msg_1199');
  assert(summary.events.length <= 200); assert(summary.globalEvents.length <= 200);
  assert(!JSON.stringify(summary.representatives).includes('not retained'));
});

test('refresh replaces aggregate usage rather than accumulating snapshots', async () => {
  const upstream = new Upstream({ window: 4 }, () => {}), now = Date.now();
  upstream.sessions.set('ses_test', { time: { updated: now } });
  let tokens = 10;
  upstream.pages = async () => [{ id: 'msg_test', type: 'assistant', time: { created: now }, tokens: { input: tokens }, content: [] }];
  await upstream.loadMessages('ses_test'); tokens = 20; await upstream.loadMessages('ses_test', false, true);
  assert.equal(upstream.summaries.get('ses_test').all.get('unknown').input, 20);
  assert.equal(upstream.messages.get('ses_test').length, 1); upstream.stop();
});

test('time counters are pruned while all-history totals remain available', () => {
  const now = Date.now(), summary = new MessageSummary({ full: true, now, cutoff: 0, hours: 4 });
  summary.add({ id: 'msg', type: 'assistant', time: { created: now }, tokens: { input: 1 }, content: [{ type: 'text', text: 'done' }], finish: 'stop' }); summary.finish();
  summary.prune(now + 25 * 3600000);
  assert.equal(summary.window.size, 0); assert.equal(summary.hourly.size, 0); assert.equal(summary.heat.size, 0); assert.equal(summary.days.size, 0);
  assert.equal(summary.all.get('unknown').input, 1);
});

test('large old histories retain aggregates, not one record per message', () => {
  const now = Date.now(), summary = new MessageSummary({ full: true, now, cutoff: now - 12 * 3600000, hours: 4 });
  for (let i = 0; i < 30000; i++) summary.add({ id: `msg_${i}`, type: 'assistant', time: { created: 1 }, tokens: { input: 1 }, content: [{ type: 'text', text: 'x'.repeat(300) }], finish: 'stop' });
  assert(summary.finish().length <= 3); assert.equal(summary.count, 30000);
  assert.equal(summary.all.get('unknown').input, 30000); assert.equal(summary.events.length, 200);
  assert.equal(summary.window.size, 0); assert.equal(summary.heat.size, 0); assert.equal(summary.hourly.size, 0);
});
