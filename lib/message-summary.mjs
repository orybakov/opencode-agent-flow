import { clip } from './privacy.mjs';

export const modelId = m => clip((typeof m === 'string' ? m : m?.id || m?.modelID) || 'unknown', 100);
export function toolInfo(c, fallback) {
  const input = c.state?.input || c.input || {};
  let name = c.name || c.tool || 'tool';
  if (name === 'execute') {
    const m = input.code?.match(/tools\.([\w]+)(?:\.([\w-]+)|\[['"]([^'"]+)['"]\])/);
    if (m) name = `${m[1]}.${m[2] || m[3]}`;
  }
  return { name: clip(name, 80), target: clip(input.filePath || input.path || input.pattern || input.command || input.query || input.url || input.agent || input.description || ''), since: c.time?.created || c.state?.time?.start || fallback };
}
const order = (a, b) => a.time - b.time || a.messageOrder - b.messageOrder || a.partOrder - b.partOrder;
const keep = (list, event) => { list.push(event); if (list.length > 400) { list.sort(order); list.splice(0, list.length - 200); } };
const usage = (map, model, t) => {
  const v = map.get(model) || { input: 0, output: 0, cacheRead: 0 };
  v.input += Number(t.input) || 0; v.output += Number(t.output) || 0; v.cacheRead += Number(t.cache?.read) || 0; map.set(model, v);
};

// History is reduced page-by-page, not retained as messages. Only three small
// representatives, 200 display events and numeric time/usage counters survive.
export class MessageSummary {
  constructor({ full, cutoff, hours, now = Date.now() }) {
    Object.assign(this, { full, cutoff, hours, now, all: new Map(), days: new Map(), hourly: new Map(), window: new Map(), heat: new Map(), globalHeat: new Map(), events: [], globalEvents: [], count: 0, representatives: [] });
  }
  add(m) {
    const created = m.time?.created || 0, updated = m.time?.completed || m.time?.streamed || created, rowTime = Math.max(created, updated);
    if (!this.full && Math.max(created, m.time?.completed || 0) < this.cutoff) return;
    const index = this.count++;
    const remember = key => {
      if (this[key]) return;
      const active = (m.content || []).findLast(c => c.type === 'tool' && ['streaming', 'running', 'pending'].includes(c.state?.status));
      const representative = { ...m, content: active ? [active] : [] };
      this[key] = representative; this.representatives.push({ index, message: representative });
    };
    remember('latest');
    if (m.type === 'assistant') {
      remember('assistant'); if (m.tokens) remember('context');
      const model = modelId(m.model), t = m.tokens || {};
      usage(this.all, model, t);
      const day = new Date(created).setHours(0, 0, 0, 0);
      if (day >= new Date(this.now).setHours(0, 0, 0, 0)) { if (!this.days.has(day)) this.days.set(day, new Map()); usage(this.days.get(day), model, t); }
      const hour = Math.floor(created / 3600000) * 3600000;
      if (hour >= Math.floor(this.now / 3600000) * 3600000 - 11 * 3600000) { if (!this.hourly.has(hour)) this.hourly.set(hour, new Map()); usage(this.hourly.get(hour), model, t); }
      if (created >= this.now - this.hours * 3600000) {
        const v = this.window.get(created) || [0, 0]; v[0] += Number(t.input) || 0; v[1] += Number(t.cache?.read) || 0; this.window.set(created, v);
      }
    }
    let partOrder = 0;
    const event = e => {
      const value = { ...e, rowTime, messageOrder: -index, partOrder: partOrder++ };
      keep(this.events, value); if (rowTime >= this.cutoff) keep(this.globalEvents, value);
      if (e.time >= this.now - 3600000) {
        this.heat.set(e.time, (this.heat.get(e.time) || 0) + 1);
        if (rowTime >= this.cutoff) this.globalHeat.set(e.time, (this.globalHeat.get(e.time) || 0) + 1);
      }
    };
    if (m.type === 'idle') event({ time: created, kind: 'idle', text: clip(m.outcome || 'finished') });
    if (m.type !== 'assistant') return;
    for (const c of m.content || []) {
      if (c.type === 'tool') {
        const t = toolInfo(c, created), text = `${t.name} → ${t.target}`;
        event({ time: t.since, kind: 'tool start', text });
        if (['completed', 'error'].includes(c.state?.status)) event({ time: c.time?.completed || c.state?.time?.end || updated, kind: c.state.status === 'error' ? 'tool error' : 'tool complete', text });
      } else if (c.type === 'text' && c.text && m.finish) event({ time: updated, kind: 'text', text: clip(c.text) });
    }
  }
  finish() {
    this.events.sort(order); this.events = this.events.slice(-200);
    this.globalEvents.sort(order); this.globalEvents = this.globalEvents.slice(-200);
    return [...new Map(this.representatives.sort((a, b) => b.index - a.index).map(r => [r.message.id, r.message])).values()];
  }
  displayEvents(scoped, cutoff) { return (scoped ? this.events : this.globalEvents.filter(e => e.rowTime >= cutoff)).map(({ time, kind, text }) => ({ time, kind, text })); }
  prune(now = Date.now()) {
    for (const time of this.window.keys()) if (time < now - this.hours * 3600000) this.window.delete(time);
    for (const map of [this.heat, this.globalHeat]) for (const time of map.keys()) if (time < now - 3600000) map.delete(time);
    for (const time of this.hourly.keys()) if (time < Math.floor(now / 3600000) * 3600000 - 11 * 3600000) this.hourly.delete(time);
    for (const day of this.days.keys()) if (day < new Date(now).setHours(0, 0, 0, 0)) this.days.delete(day);
  }
}

// Sources are newest first: replace bounded mutable contributions, never add
// successive snapshots of the same message to the immutable older base.
export function combineSummaries(sources, options) {
  const result = new MessageSummary(options);
  const sum = (target, source) => { for (const [key, value] of source) {
    if (value instanceof Map) { if (!target.has(key)) target.set(key, new Map()); sum(target.get(key), value); }
    else if (Array.isArray(value)) { const v = target.get(key) || [0, 0]; v[0] += value[0]; v[1] += value[1]; target.set(key, v); }
    else if (typeof value === 'number') target.set(key, (target.get(key) || 0) + value);
    else { const v = target.get(key) || { input: 0, output: 0, cacheRead: 0 }; for (const field of Object.keys(v)) v[field] += value[field]; target.set(key, v); }
  } };
  sources.forEach((source, index) => {
    source.prune(result.now); result.count += source.count;
    for (const key of ['all', 'days', 'hourly', 'window', 'heat', 'globalHeat']) sum(result[key], source[key]);
    for (const key of ['events', 'globalEvents']) source[key].forEach((e, partOrder) => keep(result[key], { ...e, messageOrder: -index, partOrder }));
    const reps = [...source.representatives].sort((a, b) => a.index - b.index);
    for (const key of ['latest', 'assistant', 'context']) if (!result[key] && source[key]) {
      result[key] = source[key]; result.representatives.push({ index: index * 3 + Math.max(0, reps.findIndex(r => r.message === source[key])), message: source[key] });
    }
  });
  result.finish(); return result;
}
