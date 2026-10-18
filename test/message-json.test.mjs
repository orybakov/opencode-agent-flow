import test from 'node:test';
import assert from 'node:assert/strict';
import { readMessagePage } from '../lib/message-json.mjs';
import { trimMessage } from '../lib/upstream.mjs';

test('streamed projection matches trimmed messages without retaining outputs or large text', async () => {
  const message = { id: 'msg_fixture', type: 'assistant', model: { modelID: 'test' }, finish: 'stop', time: { created: 123 }, tokens: { input: 100, output: 20, cache: { read: 50, write: 10 } }, content: [{ type: 'tool', name: 'read', id: 'tool_fixture', time: { created: 124 }, state: { status: 'completed', time: { start: 124, end: 125 }, input: { filePath: '/some/🙂/path', code: 'x'.repeat(10000) }, output: 'SECRET-OUTPUT'.repeat(100000) } }, { type: 'text', text: 'quoted "text"\n and emoji 🙂 '.repeat(1000) }] };
  const source = { data: [message], cursor: { next: 'opaque' } };
  const bytes = Buffer.from(JSON.stringify(source));
  async function* chunks(size) { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
  for (const size of [1, 7, 65536]) {
    const result = await readMessagePage(chunks(size));
    assert.deepEqual(result.data.map(trimMessage), source.data.map(trimMessage));
    assert.equal(result.cursor.next, 'opaque');
    assert.equal(result.data[0].content[0].state.output, undefined);
    assert.equal(result.data[0].content[0].state.input.code.length, 300);
    assert.equal(result.data[0].content[1].text.length, 300);
    assert(JSON.stringify(result).length < 2000);
  }
});

test('streamed projection preserves scalar models and ignores unknown nested structures', async () => {
  async function* body() { yield Buffer.from('{"data":[{"id":"msg_1","type":"idle","model":"model","outcome":"done","ignored":[{},["x"],1,null,true],"tokens":{"input":1e3}}],"cursor":{"next":null}}'); }
  assert.deepEqual(await readMessagePage(body()), { data: [{ id: 'msg_1', type: 'idle', model: 'model', outcome: 'done', tokens: { input: 1000 } }], cursor: { next: null } });
});

test('streamed projection rejects truncated JSON and invalid string escapes', async () => {
  for (const text of ['{"data":[', '{"data":[{"id":"bad\\q"}]}']) {
    async function* body() { yield Buffer.from(text); }
    await assert.rejects(readMessagePage(body()));
  }
});

test('opaque pagination cursors are not truncated like display strings', async () => {
  const cursor = 'opaque'.repeat(1000);
  async function* body() { yield Buffer.from(JSON.stringify({ data: [], cursor: { next: cursor } })); }
  assert.equal((await readMessagePage(body())).cursor.next, cursor);
});
