const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n || 0));
const agentCalls = (groups, calls) => `${groups} agent${groups === 1 ? '' : 's'} · ${calls} call${calls === 1 ? '' : 's'}`;
const shortModel = m => /opus|sonnet|gemini|gpt/i.exec(m)?.[0] || m.slice(0, 12);
const put = (selector, text) => { const el = $(selector); if (el.textContent !== text) el.textContent = text; };
const html = (selector, text) => { const el = $(selector); if (el.innerHTML !== text) el.innerHTML = text; };
let state, rootId, agents = [], edges = [], paused = matchMedia('(prefers-reduced-motion: reduce)').matches, connected = false;
const storageKey = 'agent-flow.root';
const urlRoot = new URL(location.href).searchParams.get('session');
try { rootId = urlRoot || localStorage.getItem(storageKey); } catch { rootId = urlRoot; }
const params = new URL(location.href).searchParams;
let view = 'all', sessionId = null, sessionList = [], stream, requestVersion = 0;
try { view = params.get('view') || (urlRoot ? 'session' : localStorage.getItem('agent-flow.view')) || 'all'; sessionId = params.has('view') || urlRoot ? urlRoot : localStorage.getItem('agent-flow.session'); } catch { view = params.get('view') || (urlRoot ? 'session' : 'all'); sessionId = urlRoot; }
if (view !== 'session') view = 'all';
function saveView() {
  const url = new URL(location.href); url.searchParams.set('view', view);
  if (view === 'session' ? sessionId : rootId) url.searchParams.set('session', view === 'session' ? sessionId : rootId); else url.searchParams.delete('session');
  history.replaceState(null, '', url);
  try { localStorage.setItem('agent-flow.view', view); if (sessionId) localStorage.setItem('agent-flow.session', sessionId); } catch { /* Storage may be disabled. */ }
}
function renderPicker() {
  const query = $('#session-search').value.toLowerCase(), list = sessionList.filter(s => `${s.title} ${s.agent} ${s.model} ${s.id}`.toLowerCase().includes(query));
  const summary = s => `${s.agent} · ${s.model} · ${activityTime(s.lastActivity)} · ${agentCalls(s.agentCount, s.callCount)} · ${fmt(s.tokens)} tokens · ${s.status}`;
  html('#root', '<option value="">select a session…</option>' + list.map(s => `<option value="${esc(s.id)}">${esc(s.title)} · ${esc(summary(s))}</option>`).join('') + (sessionId && !list.some(s => s.id === sessionId) ? `<option value="${esc(sessionId)}">${esc(state?.roots[0]?.title || sessionId)}</option>` : ''));
  $('#root').value = sessionId || ''; $('#root').disabled = false;
  html('#session-cards', list.map(s => `<button type="button" class="session-card" data-session="${esc(s.id)}"><strong>${esc(s.title || s.id)}</strong><span class="${s.status}">● ${esc(s.status)} · ${esc(s.agent)} · ${esc(s.model)}</span><span>${activityTime(s.lastActivity)} · ${agentCalls(s.agentCount, s.callCount)} · ${fmt(s.tokens)} tokens</span></button>`).join('') || '<p class="muted">No sessions match this search.</p>');
}
function applyView() {
  const picker = view === 'session' && !sessionId;
  document.body.dataset.view = view;
  $('#session-search').hidden = view !== 'session'; $('#session-picker').hidden = !picker; $('main').hidden = picker;
  for (const mode of ['all', 'session']) $(`#view-${mode}`).setAttribute('aria-pressed', String(mode === view));
  $('.panel:nth-child(5) h3').textContent = view === 'session' ? '// tokens · session' : '// tokens today';
  if (view === 'session') renderPicker();
  if (picker) { put('#title', 'select a session'); put('#subtitle', `opencode · ${sessionList.length} root sessions / live window`); put('#counts', ''); put('#connection', 'select session'); }
}
async function loadSessions() {
  try { const response = await fetch('/api/sessions'); if (!response.ok) throw new Error(); sessionList = await response.json(); if (view === 'session') { renderPicker(); if (!sessionId) applyView(); } } catch { if (view === 'session' && !sessionId) put('#connection', 'sessions unavailable'); }
}
function selectSession(id) { sessionId = id || null; popover.hidePopover(); saveView(); connect(); }
$('#session-search').addEventListener('input', renderPicker);
$('#session-cards').addEventListener('click', e => { const card = e.target.closest('[data-session]'); if (card) selectSession(card.dataset.session); });
for (const mode of ['all', 'session']) $(`#view-${mode}`).addEventListener('click', () => { if (view === mode) return; view = mode; saveView(); connect(); });
const validDate = time => { const date = new Date(time); return Number.isFinite(date.getTime()) ? date : new Date(0); };
const activityTime = time => validDate(time).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const totalTokens = a => a.tokens.input + a.tokens.output + a.tokens.cacheRead;
function rememberRoot() { try { if (rootId) localStorage.setItem(storageKey, rootId); } catch { /* Storage may be disabled. */ } }
const popover = document.createElement('div');
popover.id = 'group-sessions'; popover.setAttribute('popover', 'auto'); document.body.append(popover);
popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Group sessions');
let openGroupId, popoverAnchor;
function showSessions(id, anchor) {
  const group = agents.find(a => a.id === id);
  if (!group) { popover.hidePopover(); return; }
  openGroupId = id; popoverAnchor = anchor;
  const scrollTop = popover.scrollTop, closeFocused = document.activeElement === popover.querySelector('button');
  const content = `<div class="popover-heading"><strong>${esc(group.agent)} · ${group.count} sessions</strong><button type="button" aria-label="Close">×</button></div><div class="session-list">${group.sessions.map(s => `<div class="session-item"><strong title="${esc(s.title)}">${esc(s.title || s.id)}</strong><div><b class="${s.status}">${esc(s.status)}</b><span>${fmt(totalTokens(s))} tokens</span><time datetime="${validDate(s.lastActivity).toISOString()}">${activityTime(s.lastActivity)}</time></div></div>`).join('')}</div>`;
  if (popover.innerHTML !== content) { popover.innerHTML = content; popover.scrollTop = scrollTop; if (closeFocused) popover.querySelector('button').focus({ preventScroll: true }); }
  popover.querySelector('button').onclick = () => popover.hidePopover();
  if (!popover.matches(':popover-open')) popover.showPopover();
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - popover.offsetWidth - 12))}px`;
  popover.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - popover.offsetHeight - 12))}px`;
}
popover.addEventListener('toggle', () => { if (!popover.matches(':popover-open')) openGroupId = null; for (const [id, el] of nodeElements) el.setAttribute('aria-expanded', String(id === openGroupId)); });
let networkHeight = 540, hub = [682, 270], lastFrame = 0;
const nodeElements = new Map();
const canvas = $('#wires'), ctx = canvas.getContext('2d');
let flow, motionTime = 1;
window.__renderer = 'canvas2d';
import('/flow-webgl.js').then(({ createFlow }) => {
  flow = createFlow(canvas, () => { flow = null; canvas.hidden = false; window.__renderer = 'canvas2d'; draw(performance.now(), true); });
  canvas.hidden = true; window.__renderer = 'webgl'; resize();
}).catch(() => { window.__renderer = 'canvas2d'; draw(performance.now(), true); });
$('#root').addEventListener('change', e => { if (view === 'session') return selectSession(e.target.value); rootId = e.target.value; rememberRoot(); saveView(); popover.hidePopover(); render(); });
$('#motion').addEventListener('click', () => { paused = !paused; motionLabel(); draw(performance.now(), true); });
function motionLabel() { put('#motion', paused ? 'resume motion' : 'pause motion'); $('#motion').setAttribute('aria-pressed', String(paused)); }
motionLabel();
function resize() {
  const width = $('.viewport').clientWidth;
  const scale = width < 650 ? .7 : Math.min(1, width / 1364);
  $('.network').style.transform = width < 650 ? `scale(${scale})` : `translateX(-50%) scale(${scale})`;
  $('.network').style.transformOrigin = width < 650 ? '0 0' : '50% 0';
  $('.scene').style.height = `${Math.max(width < 650 ? 440 : 500, networkHeight * scale)}px`;
  $('.network').style.height = `${networkHeight}px`;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = 1364 * dpr; canvas.height = networkHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  flow?.resize(1364, networkHeight, dpr);
  updateAnchors();
  draw(performance.now(), true);
}
addEventListener('resize', resize);
function render() {
  if (!state) return;
   if (view === 'session') rootId = sessionId;
   else if (!state.roots.some(r => r.id === rootId)) rootId = state.roots[0]?.id;
   if (view === 'all') rememberRoot();
  const options = state.roots.map(r => `<option value="${esc(r.id)}">${esc(r.title || r.id)} · ${activityTime(r.lastActivity)} · ${agentCalls(r.agentCount, r.callCount)}</option>`).join('');
   if (view === 'all') { html('#root', options); $('#root').value = rootId || ''; $('#root').disabled = !rootId; } else renderPicker();
  const selected = new Set(rootId ? [rootId] : []);
  let added = true;
  while (added) { added = false; for (const a of state.agents) if (selected.has(a.parentId) && !selected.has(a.id)) { selected.add(a.id); added = true; } }
  agents = state.agents.filter(a => selected.has(a.id));
  const root = agents.find(a => a.id === rootId), children = agents.filter(a => a.id !== rootId);
  put('#title', root?.title || 'no active sessions');
   put('#subtitle', `opencode ${state.serverVersion || ''}${state.demo ? ' · demo' : ''} · orchestration topology / ${agentCalls(agents.length, state.roots.find(r => r.id === rootId)?.callCount || 0)}`);
   put('#connection', state.connection === 'connected' ? 'live' : state.connection || 'connecting');
   $('.status').classList.toggle('offline', state.connection !== 'connected');
   put('#counts', `${agents.filter(a => a.status === 'working').length} running · ${state.approvals.filter(p => agents.some(a => a.sessions.some(s => s.id === p.sessionID))).length} approvals · ${fmt(state.aggregates.totalToday)} tokens ${view === 'session' ? '· session' : 'today'}`);
  put('#graphMeta', ` · ${children.length} children / ${state.windowHours}h window`);
  $('.hub').hidden = !root; $('#empty').hidden = !!root;
    put('#empty', view === 'session' ? 'Session not found' : `No active sessions in the last ${state.windowHours} hours`);
  if (root) {
    const ratio = root.context / root.contextLimit;
    put('#lead', root.agent); put('#context', `${root.status} · ctx ${root.contextEstimated ? '≈ ' : ''}${fmt(root.context)}`); put('#model', root.model);
    $('#context').title = root.contextEstimated ? 'Last reported usage; current response is streaming' : 'Latest assistant input + cache read + cache write';
    put('#leadTool', root.currentTool ? `${root.currentTool.name} → ${root.currentTool.target}` : `${fmt(root.tokens.input + root.tokens.output + root.tokens.cacheRead)} tokens`);
    $('#leadTool').title = root.currentTool?.target || '';
    $('#contextRing').setAttribute('stroke-dasharray', `${Math.min(1, ratio) * 635} 635`);
    put('#sceneSummary', `all agents connected to ${root.agent} / ${Math.round(ratio * 100)}% context pressure`);
  } else put('#sceneSummary', 'read-only · waiting for session activity');
  const sessionIds = new Set(agents.flatMap(a => a.sessions.map(s => s.id)));
  const pending = state.approvals.filter(p => sessionIds.has(p.sessionID));
  const items = [...children, ...(pending.length ? [{ id: '__approval', agent: 'user · approval', model: `${pending.length} pending`, status: 'waiting', currentTool: { name: pending[0].action, target: pending[0].resource }, tokens: { input: 0, output: 0, cacheRead: 0 } }] : [])];
  const rows = Math.max(3, Math.ceil(items.length / 4));
  networkHeight = Math.max(540, 120 + rows * 105);
  hub = [682, networkHeight / 2]; $('.hub').style.top = `${hub[1] - 118}px`;
  const points = new Map();
  const ring = [[75,165],[330,55],[840,55],[1090,165],[75,355],[330,415],[840,415],[1090,355]];
  items.forEach((a, i) => {
    const p = items.length <= 8 ? ring[i] : [[55,295,865,1105][i % 4], 65 + Math.floor(i / 4) * 105];
    points.set(a.id, [p[0] + 100, p[1] + 48]);
    let el = nodeElements.get(a.id);
    if (!el) { el = document.createElement('article'); $('#nodes').append(el); nodeElements.set(a.id, el); }
    if (a.id !== '__approval') {
      el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute('aria-expanded', String(openGroupId === a.id));
      el.onclick = () => openGroupId === a.id ? popover.hidePopover() : showSessions(a.id, el);
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
    }
    el.className = `node ${a.status}${a.id === '__approval' ? ' approval' : ''}`;
    el.style.transform = `translate(${p[0]}px,${p[1]}px)`;
    el.title = `${a.agent} · ${a.model}\n${a.title || ''}\n${a.currentTool?.target || ''}`;
    const content = `<div class="cap"><strong>${esc(a.agent)}${a.count > 1 ? ` <small>×${a.count}</small>` : ''}</strong><span class="tag">${esc(a.id === '__approval' ? a.model : shortModel(a.model))}</span></div><div class="rows"><div class="row"><span>${esc(a.currentTool?.name || 'state')}</span><span>${esc(a.currentTool?.target || a.status)}</span></div><div class="row"><span>${a.id === '__approval' ? 'action' : 'tokens'}</span><span>${a.id === '__approval' ? 'confirm in OpenCode' : fmt(totalTokens(a))}</span></div></div>`;
    if (el.innerHTML !== content) el.innerHTML = content;
  });
  for (const [id, el] of nodeElements) if (!items.some(a => a.id === id)) { el.remove(); nodeElements.delete(id); }
  edges = children.map((a, i) => {
    const p = points.get(a.id), dx = p[0] - hub[0], dy = p[1] - hub[1], k = 116 / Math.hypot(dx, dy);
    return { id: a.id, a: [hub[0] + dx * k, hub[1] + dy * k], b: p, status: a.status, active: a.status === 'working' || a.status === 'waiting', bend: i % 2 ? 30 : -25, returning: a.status === 'done' };
  });
  if (pending.length) for (const p of pending) { const sourceId = agents.find(a => a.sessions.some(s => s.id === p.sessionID))?.id; const source = points.get(sourceId) || hub; edges.push({ id: '__approval', sourceId, a: source, b: points.get('__approval'), status: 'waiting', active: true, bend: 22 }); }
  put('#transport', `${edges.length} connections · ${paused ? 'motion paused' : 'white → pink / token transport'}`);
  const events = state.events.filter(e => selected.has(e.groupId)).slice(-60).reverse();
  html('#events', events.map(e => `<div class="event" title="${esc(e.agent + ' · ' + e.kind + ' · ' + e.text)}"><time>${validDate(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><em>${esc(e.kind === 'permission asked' ? 'wait' : e.kind === 'tool complete' ? 'done' : e.kind === 'tool start' ? 'tool' : e.kind)}</em>${esc(e.agent)} → ${esc(e.text)}</div>`).join('') || '<div class="muted">no recent events</div>');
  const ag = state.aggregates, max = Math.max(1, ...ag.hourly.map(b => b.total));
  html('#hourly', ag.hourly.map(b => `<div class="bars" title="${esc(Object.entries(b.models).map(([m, n]) => `${m}: ${fmt(n)}`).join('\n') || 'no tokens')}"><time>${validDate(b.time).getHours().toString().padStart(2, '0')}</time><div class="track"><i style="width:${b.total / max * 100}%"></i></div><b>${fmt(b.total)}</b></div>`).join(''));
  put('#cacheValue', `${Math.round(ag.cacheHit * 100)}%`); $('#cacheRing').setAttribute('stroke-dasharray', `${ag.cacheHit * 270} 270`);
  const heat = ag.heat.filter(a => selected.has(a.id)), peak = Math.max(1, ...heat.flatMap(a => a.values));
  html('#heat', heat.map(a => `<div class="heat-row"><span title="${esc(a.agent)}">${esc(a.agent)}</span>${a.values.map((n, i) => `<i title="${esc(a.agent)} / ${(12 - i) * 5}–${(11 - i) * 5} min ago: ${n} events" style="opacity:${.1 + .9 * n / peak}"></i>`).join('')}</div>`).join('') || '<div class="muted">no activity</div>');
  put('#total', fmt(ag.totalToday)); put('#estimate', `≈ $${ag.estimate.toFixed(2)} est.`);
  html('#today', Object.entries(ag.today).sort((a, b) => b[1].total - a[1].total).map(([m, t]) => `<div title="${esc(m)} · input ${t.input} / output ${t.output} / cache ${t.cacheRead}">${esc(shortModel(m))} · ${fmt(t.total)} · ≈ $${t.estimate.toFixed(2)}</div>`).join('') || 'no tokens today');
  html('#ledger', agents.map(a => `<div title="${esc(a.title)}"><b class="${a.status}">[ ${a.status.padEnd(7, ' ')} ]</b> ${esc(a.agent)}</div>`).join('') || '<span class="muted">no agents</span>');
  put('#health', `transport / public HTTP + SSE · read-only${state.permissionHealth.ok ? '' : ' · approvals unavailable'}`);
  put('#clock', `${validDate(state.updatedAt).toLocaleString()} · snapshot`);
  resize();
  if (openGroupId) showSessions(openGroupId, popoverAnchor);
}
// Seven-strand Bezier harnesses and particle transport, adapted from concept5-flow.
function updateAnchors() {
  const rect = $('.network').getBoundingClientRect(), scale = rect.width / 1364;
  const center = el => { const r = el.getBoundingClientRect(); return [(r.left + r.width / 2 - rect.left) / scale, (r.top + r.height / 2 - rect.top) / scale]; };
  if (!$('.hub').hidden) hub = center($('.hub'));
  const dock = (el, target) => {
    const c = center(el), r = el.getBoundingClientRect(), dx = target[0] - c[0], dy = target[1] - c[1];
    const k = Math.min((r.width / scale / 2 + 3) / (Math.abs(dx) || .001), (r.height / scale / 2 + 3) / (Math.abs(dy) || .001));
    return [c[0] + dx * k, c[1] + dy * k];
  };
  for (const e of edges) {
    const node = nodeElements.get(e.id), source = nodeElements.get(e.sourceId);
    if (!node) continue;
    const target = center(node), start = source ? center(source) : hub;
    const dx = target[0] - start[0], dy = target[1] - start[1], k = 116 / (Math.hypot(dx, dy) || 1);
    e.a = source ? dock(source, target) : [hub[0] + dx * k, hub[1] + dy * k];
    e.b = dock(node, start);
  }
}
function curve(e, t, j) {
  const [x,y] = e.a, [X,Y] = e.b, dx = X-x, dy = Y-y, l = Math.hypot(dx,dy) || 1, off = (j-3)*5+e.bend, u = 1-t;
  const cx=x+dx*.34-dy/l*off, cy=y+dy*.34+dx/l*off, ex=x+dx*.68+dy/l*off*.6, ey=y+dy*.68-dx/l*off*.6;
  return [u*u*u*x+3*u*u*t*cx+3*u*t*t*ex+t*t*t*X,u*u*u*y+3*u*u*t*cy+3*u*t*t*ey+t*t*t*Y];
}
function ball(x,y,r,alpha=1) { ctx.globalAlpha=alpha;ctx.shadowColor='#ff3d8b';ctx.shadowBlur=r*7;ctx.fillStyle='#ffeaf5';ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0; }
function draw(ms, force = false) {
  if (document.hidden) return;
  if (!force && (paused || document.hidden || ms - lastFrame < 32)) return;
  if (!paused && !document.hidden) motionTime += Math.min(.1, Math.max(0, (ms - lastFrame) / 1000));
  lastFrame = ms; const t = motionTime;
  if (flow) { flow.draw(edges, hub, agents.length > 0, t); return; }
  ctx.clearRect(0,0,1364,networkHeight);ctx.globalCompositeOperation='lighter';
  edges.forEach((e,ei)=>{for(let j=0;j<7;j++){ctx.globalAlpha=e.active?.29:.1;ctx.strokeStyle=j%3?'#ff448c':'#b57bff';ctx.lineWidth=.7;ctx.beginPath();for(let k=0;k<=45;k++){const p=curve(e,k/45,j);k?ctx.lineTo(...p):ctx.moveTo(...p)}ctx.stroke();for(let p=0;p<(e.active?4:1);p++){const f=(t*(.075+j*.008)+p*.237+j*.133+ei*.173)%1;const pos=curve(e,e.returning?1-f:f,j);ball(...pos,(p+j)%5===0?2.5:1.1,e.active?.9:.28)}}ball(...e.a,e.active?3:1.6,.9);ball(...e.b,e.active?3.4:1.8,.95)});
  if (agents.length) for(let i=0;i<35;i++){const a=i*2.399+t*.012,r=118+Math.sin(i*7)*6;ball(hub[0]+Math.cos(a)*r,hub[1]+Math.sin(a)*r,i%6===0?1.5:.65,.35+(i%4)*.15)}
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
}
function animate(ms) { draw(ms); requestAnimationFrame(animate); }
requestAnimationFrame(animate);
function connect() {
  stream?.close(); const version = ++requestVersion; connected = false; state = null; applyView();
  if (view === 'session' && !sessionId) return;
  const query = view === 'session' ? `?session=${encodeURIComponent(sessionId)}` : '';
  put('#connection', 'connecting');
  // Clear previous-session content immediately; late requests cannot replace the new scope.
  $('main').hidden = true;
  const accept = data => { if (version !== requestVersion) return; state = data; $('main').hidden = false; render(); };
  stream = new EventSource(`/api/stream${query}`);
  stream.addEventListener('state', e => { try { accept(JSON.parse(e.data)); } catch { put('#connection', 'invalid state'); } });
  stream.onopen = () => { connected = true; put('#connection', 'live'); $('.status').classList.remove('offline'); };
  stream.onerror = () => { connected = false; put('#connection', 'reconnecting'); $('.status').classList.add('offline'); };
  fetch(`/api/state${query}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(data => { if (!state) accept(data); }).catch(() => { if (version === requestVersion && !connected) put('#connection', 'server unavailable'); });
}
saveView(); connect(); loadSessions(); setInterval(loadSessions, 10000);
