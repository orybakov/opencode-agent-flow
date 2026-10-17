export function demo(onChange = () => {}, { interval = setInterval, cancel = clearInterval, clock = Date.now } = {}) {
  const now = Date.now(), sessions = new Map(), messages = new Map();
  const agents = ['lead', 'builder', 'researcher', 'reviewer', 'builder', 'tester', 'designer'];
  agents.forEach((agent, i) => {
    const id = `ses_demo${i}`, model = { id: ['gpt-6.1-sol', 'claude-sonnet-4-5', 'gemini-2.5-pro'][i % 3] };
    sessions.set(id, { id, parentID: i ? 'ses_demo0' : undefined, title: i ? `${agent} · public API integration` : 'Build a better developer experience', agent, model, time: { created: now - 3600000, updated: now - i * 1000 }, tokens: { input: 24000 + i * 7000, output: 3200, cache: { read: 180000 + i * 19000, write: 0 } } });
    messages.set(id, [{ id: `msg_demo${i}`, type: 'assistant', model, time: { created: now - 90000 + i * 5000, completed: now - 20000 }, tokens: { input: 12000, output: 1200, cache: { read: 48000, write: 0 } }, content: [{ id: `call_demo${i}`, type: 'tool', name: ['read', 'patch', 'webfetch', 'grep', 'shell', 'shell', 'read'][i], state: { status: i === 1 || i === 2 ? 'running' : 'completed', input: { path: ['src/index.ts', 'src/api/client.ts', 'https://example.org/docs', 'src/**/*.ts', 'npm test', 'npm run check', 'docs/design.md'][i] } }, time: { created: now - 30000 + i * 2000, completed: now - 10000 } }], finish: 'tool-calls' }]);
  });
  let timer, tick = 0;
  const tools = [
    ['read', 'src/index.ts'], ['patch', 'src/api/client.ts'],
    ['webfetch', 'https://example.org/docs'], ['grep', 'src/**/*.ts'],
    ['shell', 'npm test'], ['shell', 'npm run check'], ['read', 'docs/design.md']
  ];
  const state = { sessions, messages, active: { ses_demo1: { type: 'running' }, ses_demo2: { type: 'running' } }, approvals: [], health: { ok: true, status: 200 }, version: '2.0.32', connection: 'connected', cutoff: () => clock() - 86400000,
    start: async () => {
      if (timer !== undefined) return;
      timer = interval(() => {
        tick++;
        const time = clock();
        state.active = {};
        agents.forEach((agent, i) => {
          const id = `ses_demo${i}`, previous = sessions.get(id);
          const working = i === 0 || (tick + i) % 4 !== 0;
          if (working) state.active[id] = { type: 'running' };
          sessions.set(id, { ...previous, time: { ...previous.time, updated: time }, tokens: { ...previous.tokens, output: previous.tokens.output + 24 } });
          // Replace arrays/objects to invalidate the BFF's identity-based caches.
          const history = messages.get(id).map(message => ({ ...message, time: { ...message.time, completed: time }, content: message.content.map(tool => ({ ...tool, state: { ...tool.state, status: 'completed' }, time: { ...tool.time, completed: time } })) }));
          const [name, path] = tools[(tick + i) % tools.length];
          const tool = { id: `call_demo${i}_${tick}`, type: 'tool', name, state: { status: working ? 'running' : 'completed', input: { path } }, time: { created: time, ...(working ? {} : { completed: time }) } };
          history.push({ id: `msg_demo${i}_${tick}`, type: 'assistant', model: previous.model, time: { created: time }, tokens: { input: 12000, output: 1200 + tick % 100, cache: { read: 48000, write: 0 } }, content: [tool], finish: 'tool-calls' });
          messages.set(id, history.slice(-12));
        });
        onChange();
      }, 1500);
      timer.unref?.();
    },
    stop() { if (timer !== undefined) cancel(timer); timer = undefined; },
    ensureTree: async () => {}
  };
  return state;
}
