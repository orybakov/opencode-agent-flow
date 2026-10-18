import { readMessagePage } from './message-json.mjs';
import http from 'node:http';
import https from 'node:https';
import { MessageSummary, combineSummaries } from './message-summary.mjs';
import { EventFrames } from './event-frames.mjs';
import { truncate } from './strings.mjs';
export function reconnectDelay(delay, connectedAt, now = Date.now()) { return connectedAt !== undefined && now - connectedAt >= 30000 ? 1000 : delay; }
// V8 slices can retain the entire original JSON response. Force independent strings.
const short = value => Buffer.from(truncate(String(value || ''), 300), 'utf16le').toString('utf16le');
const inputKeys = new Set(['code', 'filePath', 'path', 'pattern', 'command', 'query', 'url', 'agent', 'description']);
const smallInput = value => Object.fromEntries(Object.entries(value || {}).filter(([key, v]) => inputKeys.has(key) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))).map(([key, v]) => [key, short(String(v))]));
export function trimMessage(m) {
  return { id: m.id, type: m.type, time: m.time, tokens: m.tokens, agent: m.agent, model: m.model, finish: m.finish, outcome: short(m.outcome), content: (m.content || []).map(c => ({ type: c.type, name: c.name || c.tool, id: c.id, time: c.time, text: short(c.text), state: { status: c.state?.status, time: c.state?.time, input: smallInput(c.state?.input || c.input) } })) };
}
export class Upstream {
  constructor(config, changed) {
    Object.assign(this, { config, changed, sessions: new Map(), messages: new Map(), summaries: new Map(), histories: new Map(), loads: new Map(), messageVersions: new Map(), fullHistory: new Set(), active: {}, approvals: [], health: { ok: false }, connection: 'connecting', dirty: new Set(), queue: [], jobs: 0, controlQueue: [], controlJobs: 0, abort: new AbortController() });
  }
  async request(path, signal) {
    const headers = { 'Accept-Encoding': 'identity', ...(this.config.password ? { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}` } : {}) };
    const url = new URL(`${this.config.server}${path}`);
    if (url.username || url.password) throw new Error('OpenCode server URL must not contain credentials.');
    const body = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, { headers, signal: AbortSignal.any([this.abort.signal, signal || AbortSignal.timeout(15000)]) }, resolve);
      request.once('error', reject);
    });
    if (body.statusCode < 200 || body.statusCode >= 300) { body.destroy(); throw new Error(body.statusCode >= 300 && body.statusCode < 400 ? 'OpenCode redirects are not allowed.' : body.statusCode === 401 ? 'OpenCode returned 401: set OPENCODE_SERVER_PASSWORD (and optionally OPENCODE_SERVER_USERNAME).' : `OpenCode API returned HTTP ${body.statusCode}.`); }
    return { body, async json() { const chunks = []; for await (const chunk of body) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')); } };
  }
  async get(path) { return (await this.request(path)).json(); }
  async limited(fn, control = false) {
    const queue = control ? this.controlQueue : this.queue, key = control ? 'controlJobs' : 'jobs', limit = control ? 2 : 1;
    if (this[key] >= limit) await new Promise(resolve => queue.push(resolve));
    else this[key]++;
    try { if (!this.abort.signal.aborted) return await fn(); } finally { const next = queue.shift(); if (next) next(); else this[key]--; }
  }
  cutoff() { return Math.min(Date.now() - Math.max(12, this.config.window) * 3600000, new Date().setHours(0, 0, 0, 0)); }
  async pages(path, stop = () => false, compact = value => value, visit) {
    const all = []; let cursor; const seen = new Set();
    do {
      const messages = path.endsWith('/message');
      const url = `${path}${path.includes('?') ? '&' : '?'}limit=${messages ? 10 : 100}&${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=desc'}`;
      const body = messages ? await readMessagePage((await this.request(url)).body) : await this.get(url);
      if (!Array.isArray(body.data)) throw new Error('Unsupported OpenCode V2 list response.');
      if (visit) { for (const value of body.data) visit(compact(value)); }
      else all.push(...body.data.map(compact));
      if (!body.data.length || stop(body.data)) break;
      cursor = body.cursor?.next;
      if (seen.has(cursor)) break; seen.add(cursor);
    } while (cursor);
    return all;
  }
  loadMessages(id, full = false, recent = false, refresh = false) {
    const pending = this.loads.get(id);
    if (pending) { pending.again = true; pending.full ||= full; pending.recent &&= recent; pending.refresh ||= refresh; return pending.promise; }
    const job = { full, recent, refresh, again: false };
    job.promise = (async () => {
      do {
        const requestedFull = job.full, requestedRecent = job.recent, requestedRefresh = job.refresh;
        job.again = false; job.full = false; job.recent = true; job.refresh = false;
        if (requestedRefresh) await this.limited(() => this.loadSession(id), true);
        await this.limited(() => this.fetchMessages(id, requestedFull, requestedRecent));
      } while (job.again && !this.abort.signal.aborted && this.sessions.has(id));
    })().finally(() => { if (this.loads.get(id) === job) this.loads.delete(id); });
    this.loads.set(id, job); return job.promise;
  }
  async fetchMessages(id, full = false, recent = false) {
      const history = this.histories.get(id);
      full ||= this.fullHistory.has(id) || recent && history?.full;
      const version = this.sessions.get(id)?.time?.updated;
      const options = { full, cutoff: this.cutoff(), hours: this.config.window }, path = `/api/session/${encodeURIComponent(id)}/message`, limit = 32;
      let next;
      const contribution = m => { const s = new MessageSummary(options); s.add(m); s.finish(); return s; };
      if (recent && history && (!full || history.full)) {
        let fetched = 0, anchor = false;
        const list = await this.pages(path, page => { fetched += page.length; anchor ||= page.some(m => history.tail.has(m.id)); return anchor || fetched >= limit; });
        if (anchor) {
          const tail = new Map(list.map(m => [m.id, contribution(m)]));
          for (const [mid, value] of history.tail) if (!tail.has(mid)) tail.set(mid, value);
          let base = history.base;
          while (tail.size > limit) { const mid = [...tail.keys()].at(-1), value = tail.get(mid); base = combineSummaries([value, base], options); tail.delete(mid); }
          next = { full: history.full, base, tail };
        }
      }
      if (!next) {
        const base = new MessageSummary(options), tail = new Map();
        const visit = m => { if (tail.size < limit) tail.set(m.id, contribution(m)); else base.add(m); };
        const list = await this.pages(path, page => !full && page.every(m => m.time?.created < options.cutoff), value => value, visit);
        for (const m of list) visit(trimMessage(m));
        base.finish(); next = { full, base, tail };
      }
      if (!this.sessions.has(id)) return;
      const summary = combineSummaries([...next.tail.values(), next.base], options);
      this.histories.set(id, next);
      this.messages.set(id, summary.finish()); this.summaries.set(id, summary);
      this.messageVersions.set(id, version);
  }
  async loadSession(id) {
    const body = await this.get(`/api/session/${encodeURIComponent(id)}`);
    if (body.data) this.sessions.set(id, body.data);
  }
  removeSession(id, seen = new Set()) {
    if (seen.has(id)) return; seen.add(id);
    for (const child of this.sessions.values()) if (child.parentID === id) this.removeSession(child.id, seen);
    this.sessions.delete(id); this.messages.delete(id); this.summaries.delete(id); this.histories.delete(id); this.fullHistory.delete(id); this.messageVersions.delete(id);
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
      }, true)));
    }
    return seen;
  }
  async sync(force = false) {
    if (this.syncing) { if (force) this.pendingForce = true; return this.syncing; }
    if (force) { this.lastForcedAt = Date.now(); this.pendingForce = false; clearTimeout(this.forceTimer); this.forceTimer = null; }
    this.syncing = (async () => {
      this.pruneScopes();
      const list = await this.pages('/api/session', page => page.at(-1)?.time?.updated < this.cutoff());
      const listed = new Set(list.map(s => s.id));
      for (const s of this.sessions.values()) if (!this.fullHistory.has(s.id) && !s.parentID && (s.time?.updated < this.cutoff() || !listed.has(s.id))) this.removeSession(s.id);
      for (const s of list) if (s.time?.updated >= this.cutoff() || this.fullHistory.has(s.id)) this.sessions.set(s.id, s);
      for (const s of [...this.sessions.values()]) { let parent = s.parentID; const seen = new Set(); while (parent && !this.sessions.has(parent) && !seen.has(parent)) { seen.add(parent); await this.loadSession(parent); parent = this.sessions.get(parent)?.parentID; } }
      const roots = [...this.sessions.values()].filter(s => !s.parentID && !s.time?.archived && s.time?.updated >= Date.now() - this.config.window * 3600000);
      const tree = await this.descendants([...roots.map(s => s.id), ...this.fullHistory]);
      this.evict(tree);
      await Promise.all([...this.sessions.values()].filter(s => (tree.has(s.id) || s.time?.updated >= this.cutoff() || !this.messages.has(s.id)) && (force || !this.messages.has(s.id) || this.active[s.id] || this.messageVersions.get(s.id) !== s.time?.updated)).map(s => this.loadMessages(s.id, false, !force && this.histories.has(s.id))));
      this.active = (await this.get('/api/session/active')).data || {};
      await this.pollPending(); this.changed();
    })().finally(() => { this.syncing = null; this.scheduleForce(); });
    return this.syncing;
  }
  scheduleForce() {
    if (!this.pendingForce || this.syncing || this.forceTimer || this.abort.signal.aborted) return;
    const delay = Math.max(0, (this.lastForcedAt || 0) + (this.config.resyncInterval ?? 10000) - Date.now());
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      if (this.syncing) return;
      this.pendingForce = false;
      void this.sync(true).catch(() => console.error('OpenCode deferred reconciliation failed.'));
    }, delay);
  }
  oversized(batch) {
    for (const id of batch.sessionIds || []) this.markDirty(id);
    if (batch.unknownOverflow || !batch.sessionIds?.length) { this.pendingForce = true; this.scheduleForce(); }
  }
  async ensureTree(id) {
    await this.loadSession(id); const ids = await this.descendants([id]);
    this.historyScopes ||= new Map(); this.historyScopes.delete(id); this.historyScopes.set(id, ids);
    this.scopeTimes ||= new Map(); this.scopeTimes.set(id, Date.now()); this.pruneScopes();
    await Promise.all([...ids].map(sid => this.loadMessages(sid, true))); this.changed();
  }
  evict(tree = new Set()) {
    for (const summary of this.summaries.values()) summary.prune();
    for (const history of this.histories.values()) { history.base.prune(); for (const contribution of history.tail.values()) contribution.prune(); }
    for (const s of [...this.sessions.values()]) if (!tree.has(s.id) && !this.fullHistory.has(s.id) && s.time?.updated < this.cutoff()) this.removeSession(s.id);
    for (const [id, messages] of this.messages) if (!this.fullHistory.has(id)) this.messages.set(id, messages.filter(m => Math.max(m.time?.created || 0, m.time?.completed || 0) >= this.cutoff()));
  }
  pruneScopes(now = Date.now()) {
    if (!this.historyScopes) return;
    for (const id of this.historyScopes.keys()) if (!this.scopePins?.has(id) && now - (this.scopeTimes?.get(id) || 0) >= 300000) { this.historyScopes.delete(id); this.scopeTimes?.delete(id); }
    while (this.historyScopes.size > 4) { const id = [...this.historyScopes.keys()].find(id => !this.scopePins?.has(id)); if (!id) break; this.historyScopes.delete(id); this.scopeTimes?.delete(id); }
    this.fullHistory = new Set([...this.historyScopes.values()].flatMap(scope => [...scope]));
  }
  pinScope(id) { this.scopePins ||= new Map(); this.scopePins.set(id, (this.scopePins.get(id) || 0) + 1); }
  unpinScope(id) { const count = this.scopePins?.get(id) || 0; if (count <= 1) this.scopePins?.delete(id); else this.scopePins.set(id, count - 1); this.pruneScopes(); }
  touchScope(id) { this.pruneScopes(); const scope = this.historyScopes?.get(id); if (!scope) return false; this.historyScopes.delete(id); this.historyScopes.set(id, scope); this.scopeTimes.set(id, Date.now()); return true; }
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
      }, true)));
      this.approvals = approvals; this.health = { ok: true, status: 200 };
    } catch { this.health = { ok: false, status: null }; }
    finally { this.pendingPoll = false; if (previous !== JSON.stringify([this.approvals, this.health])) this.changed(); }
  }
  event(event) {
    const data = event.data || {}, id = data.sessionID || data.form?.sessionID;
    if (!id) return;
    if (event.type === 'session.deleted') { this.removeSession(id); this.changed(); return; }
    if (/permission\.|form\./.test(event.type)) void this.pollPending();
    this.markDirty(id);
  }
  refreshSession(id) {
    return this.loadMessages(id, false, true, true).then(() => this.changed());
  }
  markDirty(id) {
    if (this.loads.has(id)) { const job = this.loads.get(id); job.again = true; job.refresh = true; return; }
    this.dirty.add(id);
    if (!this.dirtyTimer) this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null; const ids = [...this.dirty]; this.dirty.clear();
      void Promise.allSettled(ids.map(sid => this.refreshSession(sid))).then(async () => { if (!this.abort.signal.aborted) { this.active = (await this.get('/api/session/active')).data || {}; this.changed(); } }).catch(() => { if (!this.abort.signal.aborted) console.error('OpenCode live refresh failed; reconciliation will retry.'); });
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
        if (!this.lastResync || Date.now() - this.lastResync >= 10000) {
          this.lastResync = Date.now();
          // Startup just loaded every history. Reconcile version changes across
          // the initial SSE handshake, but force all histories only on reconnect.
          const force = !!this.connectedOnce; this.connectedOnce = true;
          void this.sync(force).catch(() => console.error('OpenCode resynchronization failed; retrying periodically.'));
        }
        const frames = new EventFrames(), decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(abort, 45000);
          const batch = frames.push(decoder.decode(chunk, { stream: true }));
          if (batch.overflow) this.oversized(batch);
          for (const frame of batch.frames) {
            const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (text) { try { this.event(JSON.parse(text)); } catch { /* Ignore unknown envelopes. */ } }
          }
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
    let delay = 1000, lastError;
    while (!this.abort.signal.aborted) {
    try {
    let info;
    try { info = await this.get('/api/info'); } catch (error) { throw new Error(`Cannot connect to OpenCode V2. ${error.message}`); }
    this.version = info.version || info.data?.version;
    if (!/^2\./.test(this.version || '')) throw new Error('Unsupported server: OpenCode V2 /api/info version 2.x is required.');
    await this.sync(); if (this.abort.signal.aborted) return; void this.stream();
    console.log(`Connected to OpenCode ${this.version}.`);
    this.syncTimer = setInterval(() => { void this.sync().catch(() => console.error('OpenCode reconciliation failed; retrying in 60s.')); }, 60000);
    this.pendingTimer = setInterval(() => { void this.pollPending(); }, 5000);
    return;
    } catch (error) {
      if (this.abort.signal.aborted) return;
      // Keep retrying, but do not silently hide authentication/version failures.
      const message = error.message;
      if (message !== lastError) { console.error(message); lastError = message; }
      this.connection = 'connecting'; this.changed();
      await new Promise(resolve => { const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, delay); this.abort.signal.addEventListener('abort', finish, { once: true }); });
      delay = Math.min(delay * 2, 30000);
    }
    }
  }
  stop() { this.abort.abort(); clearInterval(this.syncTimer); clearInterval(this.pendingTimer); clearTimeout(this.dirtyTimer); clearTimeout(this.forceTimer); }
}
