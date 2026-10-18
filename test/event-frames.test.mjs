import test from 'node:test';
import assert from 'node:assert/strict';
import { EventFrames } from '../lib/event-frames.mjs';

test('SSE splitter handles fragmented CRLF and multiple frames', () => {
  const decoder = new EventFrames();
  assert.deepEqual(decoder.push('data: one\r'), { frames: [], overflow: false });
  assert.deepEqual(decoder.push('\n\r\ndata: two\n\n'), { frames: ['data: one', 'data: two'], overflow: false });
});

test('oversized SSE frames are discarded with bounded buffering and reconciled', () => {
  const decoder = new EventFrames(100);
  decoder.push('data: ');
  for (let i = 0; i < 10000; i++) { const batch = decoder.push('x'.repeat(70)); assert(batch.frames.length === 0); assert(decoder.buffer.length <= 100); }
  assert.deepEqual(decoder.push('\n\ndata: next\n\n'), { frames: ['data: next'], overflow: true, unknownOverflow: true });
  assert.deepEqual(decoder.push(`data: ${'x'.repeat(1000)}\n\n`), { frames: [], overflow: true, unknownOverflow: true });
});

test('oversized frames retain bounded session invalidation identifiers', () => {
  const decoder = new EventFrames(100);
  decoder.push('data: {"data":{"sessionID":"ses_target","output":"' + 'x'.repeat(200));
  assert.deepEqual(decoder.push('x'.repeat(200) + '"}}\n\n'), { frames: [], overflow: true, sessionIds: ['ses_target'], unknownOverflow: true });
});

test('identifier extraction at its 16-ID cap always requests conservative reconciliation', () => {
  const decoder = new EventFrames(100);
  const data = Array.from({ length: 17 }, (_, i) => ({ sessionID: `ses_${i}` }));
  const batch = decoder.push(`data: ${JSON.stringify(data)}\n\n`);
  assert.equal(batch.sessionIds.length, 16); assert.equal(batch.unknownOverflow, true);
});
