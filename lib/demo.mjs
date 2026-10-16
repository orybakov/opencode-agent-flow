export function demo() {
  const now = Date.now(), sessions = new Map(), messages = new Map();
  const agents = ['lead', 'builder', 'researcher', 'reviewer', 'builder', 'tester', 'designer'];
  agents.forEach((agent, i) => {
    const id = `ses_demo${i}`, model = { id: ['gpt-6.1-sol', 'claude-sonnet-4-5', 'gemini-2.5-pro'][i % 3] };
    sessions.set(id, { id, parentID: i ? 'ses_demo0' : undefined, title: i ? `${agent} · public API integration` : 'Build a better developer experience', agent, model, time: { created: now - 3600000, updated: now - i * 1000 }, tokens: { input: 24000 + i * 7000, output: 3200, cache: { read: 180000 + i * 19000, write: 0 } } });
    messages.set(id, [{ id: `msg_demo${i}`, type: 'assistant', model, time: { created: now - 90000 + i * 5000, completed: now - 20000 }, tokens: { input: 12000, output: 1200, cache: { read: 48000, write: 0 } }, content: [{ id: `call_demo${i}`, type: 'tool', name: ['read', 'patch', 'webfetch', 'grep', 'shell', 'shell', 'read'][i], state: { status: i === 1 || i === 2 ? 'running' : 'completed', input: { path: ['src/index.ts', 'src/api/client.ts', 'https://example.org/docs', 'src/**/*.ts', 'npm test', 'npm run check', 'docs/design.md'][i] } }, time: { created: now - 30000 + i * 2000, completed: now - 10000 } }], finish: 'tool-calls' }]);
  });
  return { sessions, messages, active: { ses_demo1: { type: 'running' }, ses_demo2: { type: 'running' } }, approvals: [], health: { ok: true, status: 200 }, version: '2.0.30', connection: 'connected', cutoff: () => now - 86400000, start: async () => {}, stop() {}, ensureTree: async () => {} };
}
