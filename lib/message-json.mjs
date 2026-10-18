// Project message pages while decoding: tool outputs/prompts never become JS strings.
// The V2 API has pagination, but no field projection, and one message can be huge.
import { truncate } from './strings.mjs';
const time = { created: true, completed: true, streamed: true, start: true, end: true };
const input = Object.fromEntries(['code', 'filePath', 'path', 'pattern', 'command', 'query', 'url', 'agent', 'description'].map(k => [k, true]));
const part = { type: true, name: true, tool: true, id: true, time, text: true, input, state: { status: true, time, input } };
const message = { id: true, type: true, time, tokens: { input: true, output: true, reasoning: true, cache: { read: true, write: true } }, agent: true, model: { id: true, modelID: true }, finish: true, outcome: true, content: [part] };
const page = { data: [message], cursor: { next: true, previous: true } };
const special = /["\\\u0000-\u001f]/g;
const scalarEnd = /[\s,\]}]/, separator = /[\s,:]/;
const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export async function readMessagePage(body) {
  const decoder = new TextDecoder();
  const stack = []; let root, rootDone = false, token = '', string = false, escaped = false, unicode = 0, unicodeValue = 0, number = false, capture = false, limit = 300;
  const schema = () => {
    const frame = stack.at(-1);
    if (!frame) return page;
    return Array.isArray(frame.schema) ? frame.schema[0] : frame.schema && Object.hasOwn(frame.schema, frame.key) ? frame.schema[frame.key] : undefined;
  };
  function value(v) {
    const frame = stack.at(-1);
    if (!frame) { root = v; rootDone = true; return; }
    if (frame.value) {
      if (Array.isArray(frame.value)) frame.value.push(v);
      else if (Object.hasOwn(frame.schema, frame.key)) frame.value[frame.key] = v;
    }
    frame.key = undefined; frame.expectKey = !Array.isArray(frame.schema);
  }
  function scalar(v) {
    const frame = stack.at(-1);
    if (frame && !frame.schema) return;
    if (frame?.expectKey) { frame.key = v; frame.expectKey = false; }
    else value(v);
  }
  function append(c) { if (capture && token.length < limit + 1) token += c.slice(0, limit + 1 - token.length); }
  function consume(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (rootDone) { if (!/\s/.test(c)) throw new Error('Unexpected data after JSON root'); continue; }
      if (string) {
        if (unicode) {
          const code = c.charCodeAt(0), digit = code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
          if (digit < 0) throw new Error('Invalid JSON escape');
          unicodeValue = unicodeValue * 16 + digit;
          if (!--unicode && capture) append(String.fromCharCode(unicodeValue));
        } else if (escaped) {
          escaped = false;
          if (c === 'u') { unicode = 4; unicodeValue = 0; }
          else { if (!Object.hasOwn(escapes, c)) throw new Error('Invalid JSON escape'); if (capture) append(escapes[c]); }
        } else if (c === '\\') escaped = true;
        else if (c === '"') { string = false; scalar(capture ? Buffer.from(truncate(token, limit), 'utf16le').toString('utf16le') : undefined); token = ''; }
        else {
          if (c < ' ') throw new Error('Invalid JSON string');
          special.lastIndex = i; const match = special.exec(chunk), end = match ? match.index : chunk.length;
          if (capture && token.length < limit + 1) append(chunk.slice(i, Math.min(end, i + limit + 1 - token.length)));
          i = end - 1;
        }
        continue;
      }
      if (number) {
        if (!scalarEnd.test(c)) { if (capture) { if (token.length >= 64) throw new Error('Invalid JSON scalar'); token += c; } continue; }
        scalar(capture ? JSON.parse(token) : undefined); token = ''; number = false;
        if (rootDone) { if (!/\s/.test(c)) throw new Error('Unexpected data after JSON root'); continue; }
      }
      if (c === '"') { const frame = stack.at(-1); string = true; capture = !frame || !!frame.schema && (!!frame.expectKey || !!schema()); limit = !frame?.expectKey && frame?.schema === page.cursor ? Infinity : 300; }
      else if (c === '{' || c === '[') {
        const selected = schema(), keep = selected && typeof selected === 'object';
        stack.push({ schema: keep ? selected : undefined, value: keep ? c === '[' ? [] : {} : undefined, expectKey: c === '{', key: undefined });
      } else if (c === '}' || c === ']') {
        const frame = stack.pop(); if (!frame) throw new Error('Invalid JSON container');
        if (frame.schema === input) for (const [key, v] of Object.entries(frame.value)) { if (v === undefined) delete frame.value[key]; else if (typeof v !== 'string') frame.value[key] = truncate(String(v), 300); }
        value(frame.value);
      } else if (!separator.test(c)) { capture = !!schema(); token = capture ? c : ''; number = true; }
    }
  }
  for await (const chunk of body) consume(decoder.decode(chunk, { stream: true }));
  consume(decoder.decode());
  if (number) scalar(capture ? JSON.parse(token) : undefined);
  if (stack.length || string || root === undefined) throw new Error('Incomplete message JSON');
  return root;
}
