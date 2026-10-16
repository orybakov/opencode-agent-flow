export function reconnectDelay(delay, connectedAt, now = Date.now()) { return connectedAt !== undefined && now - connectedAt >= 30000 ? 1000 : delay; }
export function trimMessage(m) {
  return { id: m.id, type: m.type, time: m.time, tokens: m.tokens, agent: m.agent, model: m.model, finish: m.finish, outcome: String(m.outcome || '').slice(0, 300), content: (m.content || []).map(c => ({ type: c.type, name: c.name || c.tool, id: c.id, time: c.time, text: String(c.text || '').slice(0, 300), state: { status: c.state?.status, time: c.state?.time, input: Object.fromEntries(Object.entries(c.state?.input || c.input || {}).filter(([key]) => ['code', 'filePath', 'path', 'pattern', 'command', 'query', 'url', 'agent', 'description'].includes(key)).map(([key, value]) => [key, String(value).slice(0, 300)])) } })) };
}
export class Upstream {
  constructor(config, changed) {
    Object.assign(this, { config, changed, sessions: new Map(), messages: new Map(), messageVersions: new Map(), fullHistory: new Set(), active: {}, approvals: [], health: { ok: false }, connection: 'connecting', dirty: new Set(), queue: [], jobs: 0, abort: new AbortController() });
  }
  async request(path, signal) {
    const headers = this.config.password ? { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}` } : {};
    const response = await fetch(`${this.config.server}${path}`, { headers, redirect: 'error', signal: AbortSignal.any([this.abort.signal, signal || AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? 'OpenCode returned 401: set OPENCODE_SERVER_PASSWORD (and optionally OPENCODE_SERVER_USERNAME).' : `OpenCode API returned HTTP ${response.status}.`); }
    return response;
  }
  async get(path) { return (await this.request(path)).json(); }
  async limited(fn) {
    if (this.jobs >= 4) await new Promise(resolve => this.queue.push(resolve));
    else this.jobs++;
    try { return await fn(); } finally { const next = this.queue.shift(); if (next) next(); else this.jobs--; }
  }
  cutoff() { return Math.min(Date.now() - Math.max(12, this.config.window) * 3600000, new Date().setHours(0, 0, 0, 0)); }
  async pages(path, stop = () => false, compact = value => value) {
    const all = []; let cursor; const seen = new Set();
    do {
      const body = await this.get(`${path}${path.includes('?') ? '&' : '?'}limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=desc'}`);
      if (!Array.isArray(body.data)) throw new Error('Unsupported OpenCode V2 list response.');
      all.push(...body.data.map(compact));
      if (!body.data.length || stop(body.data)) break;
      cursor = body.cursor?.next;
      if (seen.has(cursor)) break; seen.add(cursor);
    } while (cursor);
    return all;
  }
  async loadMessages(id, full = false, recent = false) {
    full ||= this.fullHistory.has(id);
    return this.limited(async () => {
      const version = this.sessions.get(id)?.time?.updated;
      const previous = this.messages.get(id), known = new Set(previous?.map(m => m.id));
      const list = await this.pages(`/api/session/${encodeURIComponent(id)}/message`, page => recent && page.some(m => known.has(m.id)) || !full && page.every(m => m.time?.created < this.cutoff()), trimMessage);
      if (!this.sessions.has(id)) return;
      const compact = list.map(trimMessage);
      if (recent && previous) {
        const merged = new Map(previous.map(m => [m.id, m]));
        for (const message of compact.reverse()) merged.set(message.id, message);
        this.messages.set(id, [...merged.values()].filter(m => full || Math.max(m.time?.created || 0, m.time?.completed || 0) >= this.cutoff()));
      } else this.messages.set(id, compact.reverse().filter(m => full || Math.max(m.time?.created || 0, m.time?.completed || 0) >= this.cutoff()));
      if (!recent) this.messageVersions.set(id, version);
    });
  }
  async loadSession(id) {
    const body = await this.get(`/api/session/${encodeURIComponent(id)}`);
    if (body.data) this.sessions.set(id, body.data);
  }
  removeSession(id, seen = new Set()) {
    if (seen.has(id)) return; seen.add(id);
    for (const child of this.sessions.values()) if (child.parentID === id) this.removeSession(child.id, seen);
    this.sessions.delete(id); this.messages.delete(id); this.fullHistory.delete(id); this.messageVersions.delete(id);
  }
  async descendants(ids) {
    const seen = new Set(); let pending = [...ids];
    while (pending.length) {
      const batch = pending.filter(id => !seen.has(id)); pending = [];
      if (!batch.length) break;
      await Promise.all(batch.map(id => this.limited(async () => {
        seen.add(id);
        const children = await this.pages(`/api/session?parentID=${encodeURIComponent(id)}`), ids = new Set(children.map(child => child.id));
        for (const child of this.sessions.values()) if (child.parentID === id && !ids.has(child.id)) this.removeSession(child.id);
        for (const child of children) { this.sessions.set(child.id, child); pending.push(child.id); }
      })));
    }
    return seen;
  }
  async sync(force = false) {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const list = await this.pages('/api/session', page => page.at(-1)?.time?.updated < this.cutoff());
      const listed = new Set(list.map(s => s.id));
      for (const s of this.sessions.values()) if (!this.fullHistory.has(s.id) && !s.parentID && (s.time?.updated < this.cutoff() || !listed.has(s.id))) this.removeSession(s.id);
      for (const s of list) if (s.time?.updated >= this.cutoff() || this.fullHistory.has(s.id)) this.sessions.set(s.id, s);
      for (const s of [...this.sessions.values()]) { let parent = s.parentID; const seen = new Set(); while (parent && !this.sessions.has(parent) && !seen.has(parent)) { seen.add(parent); await this.loadSession(parent); parent = this.sessions.get(parent)?.parentID; } }
      const roots = [...this.sessions.values()].filter(s => !s.parentID && !s.time?.archived && s.time?.updated >= Date.now() - this.config.window * 3600000);
      const tree = await this.descendants([...roots.map(s => s.id), ...this.fullHistory]);
      this.evict(tree);
      await Promise.all([...this.sessions.values()].filter(s => (tree.has(s.id) || s.time?.updated >= this.cutoff() || !this.messages.has(s.id)) && (force || !this.messages.has(s.id) || this.active[s.id] || this.messageVersions.get(s.id) !== s.time?.updated)).map(s => this.loadMessages(s.id)));
      this.active = (await this.get('/api/session/active')).data || {};
      await this.pollPending(); this.changed();
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async ensureTree(id) {
    await this.loadSession(id); const ids = await this.descendants([id]);
    this.historyScopes ||= new Map(); this.historyScopes.delete(id); this.historyScopes.set(id, ids);
    while (this.historyScopes.size > 20) this.historyScopes.delete(this.historyScopes.keys().next().value);
    this.fullHistory = new Set([...this.historyScopes.values()].flatMap(scope => [...scope]));
    await Promise.all([...ids].map(sid => this.loadMessages(sid, true))); this.changed();
  }
  evict(tree = new Set()) {
    for (const s of [...this.sessions.values()]) if (!tree.has(s.id) && !this.fullHistory.has(s.id) && s.time?.updated < this.cutoff()) this.removeSession(s.id);
    for (const [id, messages] of this.messages) if (!this.fullHistory.has(id)) this.messages.set(id, messages.filter(m => Math.max(m.time?.created || 0, m.time?.completed || 0) >= this.cutoff()));
  }
  touchScope(id) { const scope = this.historyScopes?.get(id); if (scope) { this.historyScopes.delete(id); this.historyScopes.set(id, scope); } }
  async pollPending() {
    if (this.pendingPoll) return;
    this.pendingPoll = true;
    const previous = JSON.stringify([this.approvals, this.health]);
    try {
      const locations = new Set([...this.sessions.values()].filter(s => this.active[s.id] || s.time?.updated >= Date.now() - this.config.window * 3600000).map(s => s.location?.directory).filter(Boolean));
      const approvals = [];
      await Promise.all([...locations].map(directory => this.limited(async () => {
        const query = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
        const permissions = await this.get(`/api/permission/request${query}`), forms = await this.get(`/api/form${query}`);
        for (const p of permissions.data || []) approvals.push({ id: p.id, sessionID: p.sessionID, action: p.action || 'permission', resource: (p.resources || []).join(', '), time: this.approvals.find(a => a.id === p.id)?.time || Date.now() });
        for (const f of forms.data || []) approvals.push({ id: f.id, sessionID: f.sessionID, action: 'form', resource: f.title || 'Input requested', time: this.approvals.find(a => a.id === f.id)?.time || Date.now() });
      })));
      this.approvals = approvals; this.health = { ok: true, status: 200 };
    } catch { this.health = { ok: false, status: null }; }
    finally { this.pendingPoll = false; if (previous !== JSON.stringify([this.approvals, this.health])) this.changed(); }
  }
  event(event) {
    const data = event.data || {}, id = data.sessionID || data.form?.sessionID;
    if (!id) return;
    if (event.type === 'session.deleted') { this.removeSession(id); this.changed(); return; }
    this.dirty.add(id);
    if (/permission\.|form\./.test(event.type)) void this.pollPending();
    if (!this.dirtyTimer) this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null; const ids = [...this.dirty]; this.dirty.clear();
      void Promise.allSettled(ids.map(sid => this.limited(() => this.loadSession(sid)).then(() => this.loadMessages(sid, false, true)))).then(async () => { this.active = (await this.get('/api/session/active')).data || {}; this.changed(); }).catch(() => console.error('OpenCode live refresh failed; reconciliation will retry.'));
    }, 250);
  }
  async stream() {
    let delay = 1000;
    while (!this.abort.signal.aborted) {
      const controller = new AbortController(), abort = () => controller.abort();
      this.abort.signal.addEventListener('abort', abort, { once: true });
      let watchdog = setTimeout(abort, 45000), connectedAt;
      try {
        const response = await this.request('/api/event', controller.signal);
        this.connection = 'connected'; this.changed();
        connectedAt = Date.now();
        if (!this.lastResync || Date.now() - this.lastResync >= 10000) { this.lastResync = Date.now(); void this.sync(true).catch(() => console.error('OpenCode resynchronization failed; retrying periodically.')); }
        let buffer = ''; const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(abort, 45000);
          buffer += decoder.decode(chunk, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (text) { try { this.event(JSON.parse(text)); } catch { /* Ignore unknown envelopes. */ } }
          }
          if (buffer.length > 8 * 1024 * 1024) throw new Error('Oversized SSE frame');
        }
        if (!this.abort.signal.aborted) throw new Error('SSE closed');
      } catch {
        if (this.abort.signal.aborted) break;
        delay = reconnectDelay(delay, connectedAt);
        this.connection = 'reconnecting'; this.changed();
        console.error(`OpenCode event stream disconnected; reconnecting in ${delay / 1000}s.`);
        await new Promise(resolve => { const finish = () => { clearTimeout(t); this.abort.signal.removeEventListener('abort', finish); resolve(); }; const t = setTimeout(finish, delay); this.abort.signal.addEventListener('abort', finish, { once: true }); });
        delay = Math.min(delay * 2, 30000);
      } finally {
        clearTimeout(watchdog); this.abort.signal.removeEventListener('abort', abort); controller.abort();
      }
    }
  }
  async start() {
    void this.initialize();
  }
  async initialize() {
    let delay = 1000;
    while (!this.abort.signal.aborted) {
    try {
    let info;
    try { info = await this.get('/api/info'); } catch (error) { throw new Error(`Cannot connect to OpenCode V2. ${error.message}`); }
    this.version = info.version || info.data?.version;
    if (!/^2\./.test(this.version || '')) throw new Error('Unsupported server: OpenCode V2 /api/info version 2.x is required.');
    await this.sync(); if (this.abort.signal.aborted) return; void this.stream();
    this.syncTimer = setInterval(() => { void this.sync().catch(() => console.error('OpenCode reconciliation failed; retrying in 60s.')); }, 60000);
    this.pendingTimer = setInterval(() => { void this.pollPending(); }, 5000);
    return;
    } catch {
      if (this.abort.signal.aborted) return;
      this.connection = 'connecting'; this.changed();
      await new Promise(resolve => { const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, delay); this.abort.signal.addEventListener('abort', finish, { once: true }); });
      delay = Math.min(delay * 2, 30000);
    }
    }
  }
  stop() { this.abort.abort(); clearInterval(this.syncTimer); clearInterval(this.pendingTimer); clearTimeout(this.dirtyTimer); }
}
