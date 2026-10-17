import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { Upstream } from '../lib/upstream.mjs';

async function mock(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
const json = (res, value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const waitFor = async predicate => { const end = Date.now() + 7000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
const config = server => ({ server, username: 'opencode', password: 'test-only-password', window: 4 });

test('CLI consumes -h as an option value instead of global help', () => {
  const child = spawnSync(process.execPath, ['bin/cli.mjs', '--username', '-h', '--port', '0'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /--port must be/); assert(!child.stdout.includes('Usage:'));
});

test('unprotected upstream works without an Authorization header', async () => {
  const upstream = await mock((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/api/info') return json(res, { version: '2.0.32' });
    if (req.url === '/api/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected"}\n\n'); return; }
    return json(res, { data: req.url === '/api/session/active' ? {} : [], cursor: {} });
  });
  const client = new Upstream({ ...config(upstream.url), password: undefined }, () => {});
  try { await client.start(); await waitFor(() => client.connection === 'connected'); assert.equal(client.version, '2.0.32'); }
  finally { client.stop(); await upstream.close(); }
});

test('initial connection failure stays connecting and retries instead of rejecting startup', async () => {
  let status = 401;
  const upstream = await mock((req, res) => { res.statusCode = status; json(res, { version: '1.0.0' }); });
  const client = new Upstream(config(upstream.url), () => {});
  try {
    await client.start();
    await assert.rejects(client.get('/api/info'), /401.*OPENCODE_SERVER_PASSWORD/);
    assert.equal(client.connection, 'connecting');
    status = 200;
    assert.equal((await client.get('/api/info')).version, '1.0.0');
  } finally { client.stop(); await upstream.close(); }
});

test('CLI reports authentication failure without exposing credentials and logs the connected version after recovery', async () => {
  let authorized = false, output = '';
  const upstream = await mock((req, res) => {
    if (!authorized) { res.writeHead(401); return res.end(); }
    if (req.url === '/api/info') return json(res, { version: '2.0.32' });
    if (req.url === '/api/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected"}\n\n'); return; }
    return json(res, { data: req.url === '/api/session/active' ? {} : [], cursor: {} });
  });
  const reservation = await mock((req, res) => res.end());
  const port = reservation.server.address().port; await reservation.close();
  const child = spawn(process.execPath, ['bin/cli.mjs', '--server', upstream.url, '--port', String(port)], { cwd: new URL('..', import.meta.url), env: { ...process.env, OPENCODE_SERVER_PASSWORD: 'wrong-secret-test-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitFor(() => output.includes('401: set OPENCODE_SERVER_PASSWORD'));
    assert(!output.includes('wrong-secret-test-only'));
    authorized = true;
    await waitFor(() => output.includes('Connected to OpenCode 2.0.32.'));
    assert.equal((output.match(/401: set OPENCODE_SERVER_PASSWORD/g) || []).length, 1);
  } finally {
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exit; await upstream.close();
  }
});

test('pagination, dormant descendants, location waits, semantic refresh and reconnect', async () => {
  const now = Date.now(), calls = [], streams = new Set(); let connections = 0, generation = 0;
  const root = { id: 'ses_root', agent: 'lead', title: 'Fixture', time: { updated: now }, location: { directory: '/workspace/a' } };
  const child = { id: 'ses_child', parentID: root.id, agent: 'builder', time: { updated: now - 86400000 }, location: { directory: '/workspace/b' } };
  const upstream = await mock((req, res) => {
    const url = new URL(req.url, 'http://localhost'); calls.push(url);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('opencode:test-only-password').toString('base64')}`);
    if (url.pathname === '/api/info') return json(res, { version: '2.0.30' });
    if (url.pathname === '/api/event') {
      connections++; streams.add(res); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","data":{}}\r\n\r\n');
      res.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname === '/api/session/active') return json(res, { data: { ses_child: { type: 'running' } } });
    if (url.pathname === '/api/session') {
      const data = url.searchParams.has('cursor') ? [] : url.searchParams.get('parentID') === root.id ? [child] : url.searchParams.has('parentID') ? [] : [root];
      return json(res, { data, cursor: { next: data.length ? 'last' : null } });
    }
    if (url.pathname.endsWith('/message')) return json(res, { data: [{ id: 'msg_fixture', type: 'assistant', time: { created: now }, finish: String(generation) }], cursor: {} });
    if (url.pathname === '/api/session/ses_child') return json(res, { data: child });
    if (url.pathname === '/api/permission/request') return json(res, { data: url.searchParams.get('location[directory]') === '/workspace/b' ? [{ id: 'per_fixture', sessionID: child.id, action: 'read', resources: ['src/index.ts'] }] : [] });
    if (url.pathname === '/api/form') return json(res, { data: url.searchParams.get('location[directory]') === '/workspace/a' ? [{ id: 'form_fixture', sessionID: root.id, title: 'Choose an option' }] : [] });
    res.writeHead(404); res.end();
  });
  const client = new Upstream(config(upstream.url), () => {});
  try {
    await client.start(); await waitFor(() => connections === 1 && client.connection === 'connected'); await client.sync();
    assert.equal(client.sessions.size, 2);
    assert.equal(client.messages.size, 2);
    assert.equal(client.approvals.length, 2);
    assert.equal(client.approvals.find(p => p.id === 'per_fixture').resource, 'src/index.ts');
    assert(calls.some(u => u.searchParams.has('cursor') && !u.searchParams.has('order')));
    generation = 1;
    for (const stream of streams) stream.write('data: {"type":"session.tool.success","data":{"sessionID":"ses_child"}}\n\n');
    await waitFor(() => client.messages.get(child.id)?.[0]?.finish === '1');
    generation = 2;
    for (const stream of streams) stream.end();
    await waitFor(() => connections === 2);
    await client.sync(true);
    await waitFor(() => client.messages.get(child.id)?.[0]?.finish === '2');
    assert.equal(client.connection, 'connected');
    assert.equal(connections, 2);
  } finally { client.stop(); await upstream.close(); }
});

test('message fetch concurrency is bounded to four', async () => {
  let running = 0, maximum = 0;
  const upstream = await mock((req, res) => {
    running++; maximum = Math.max(maximum, running);
    setTimeout(() => { running--; json(res, { data: [], cursor: {} }); }, 25);
  });
  const client = new Upstream(config(upstream.url), () => {});
  try { await Promise.all(Array.from({ length: 16 }, (_, i) => client.loadMessages(`ses_${i}`))); assert.equal(maximum, 4); }
  finally { client.stop(); await upstream.close(); }
});

test('separate CLI process retries a broken upstream with exponential backoff', async () => {
  let attempts = 0, output = '';
  const upstream = await mock((req, res) => {
    if (req.url === '/api/info') return json(res, { version: '2.0.30' });
    if (req.url === '/api/event') { attempts++; res.writeHead(503); return res.end(); }
    return json(res, { data: req.url === '/api/session/active' ? {} : [], cursor: {} });
  });
  const reservation = await mock((req, res) => res.end());
  const port = reservation.server.address().port; await reservation.close();
  const child = spawn(process.execPath, ['bin/cli.mjs', '--server', upstream.url, '--port', String(port)], { cwd: new URL('..', import.meta.url), env: { ...process.env, OPENCODE_SERVER_PASSWORD: 'test-only-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitFor(() => attempts >= 3);
    assert(output.includes('reconnecting in 1s'));
    assert(output.includes('reconnecting in 2s'));
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.connection, 'reconnecting');
    assert(!output.includes('test-only-password'));
  } finally {
    const exit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exit; await upstream.close();
  }
});
