import { auth, db, API_BASE, $, esc, toMs, fmtDate, ago, toast, copy, confirmBox } from '/assets/fb.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { S, loaders } from './state.js';

const DURS = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Lifetime']];
const durLabel = d => (DURS.find(x => x[0] === d) || [d, d + ' days'])[1];
const when = iso => iso ? ago(new Date(iso)) : '—';
let selected = null, lastKeys = [], tab = 'overview', keyRows = [], timer = null;

export async function loadPanels() {
  const snap = await getDocs(query(collection(db, 'panelAccess'), where('uid', '==', S.user.uid))).catch(() => ({ docs: [] }));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  await Promise.all(list.map(async g => {
    const p = await getDoc(doc(db, 'products', g.productId)).catch(() => null);
    g.product = p?.exists() ? p.data() : null;
  }));
  S.panels = list.sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
}

const current = () => S.panels.find(g => g.id === selected);
const canGen = g => g.canGenerate !== false;
const canDl = g => g.canDownload !== false;
const canManage = g => !!g.canManage;
const canSess = g => !!g.canSessions;
const canAct = g => !!g.canActivity;

function state(g) {
  if (g.status === 'suspended') return { ok: false, label: 'Suspended', cls: 't-warn', why: 'This panel is suspended.' };
  const m = toMs(g.expiresAt);
  if (m && m < Date.now()) return { ok: false, label: 'Expired', cls: 't-bad', why: 'This panel has expired.' };
  if (g.product && g.product.active === false) return { ok: false, label: 'Product off', cls: 't-warn', why: 'This product is switched off right now.' };
  return { ok: true, label: 'Active', cls: 't-live', why: '' };
}

function tabsFor(g) {
  const t = [['overview', 'Overview']];
  if (canGen(g) || canManage(g)) t.push(['keys', 'Keys']);
  if (canSess(g)) t.push(['sessions', 'Sessions']);
  if (canAct(g)) t.push(['activity', 'Activity']);
  return t;
}

function setMsg(id, type, text) { const m = $(id); m.className = 'msg ' + type; m.textContent = text; }

async function api(path, opts = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(API_BASE + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } })
    .catch(() => { throw new Error('Couldn’t reach the server. Try again in a moment.'); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

function renderPanels() {
  if (!S.panels.length) { $('pn-cards').innerHTML = '<div class="empty">You don’t have any panels yet.</div>'; $('pn-detail').style.display = 'none'; return; }
  if (!current()) selected = S.panels[0].id;
  $('pn-cards').innerHTML = S.panels.map(g => {
    const st = state(g);
    return `<button class="pcard${g.id === selected ? ' on' : ''}" onclick="pickPanel('${g.id}')"><b>${esc(g.productName || g.productId)}</b>
      <span class="tag ${st.cls}">${st.label}</span>
      <div class="pc-meta"><span>${canGen(g) ? `${g.credits || 0} credits` : 'Product access'}</span><span>${g.expiresAt === 0 || g.expiresAt == null ? 'No end date' : 'Ends ' + fmtDate(g.expiresAt)}</span></div></button>`;
  }).join('');
  renderDetail();
}

function renderDetail() {
  const g = current(); if (!g) return;
  const st = state(g), ends = toMs(g.expiresAt), tabs = tabsFor(g);
  if (!tabs.some(t => t[0] === tab)) tab = 'overview';
  $('pn-detail').style.display = '';
  $('pn-name').textContent = g.productName || g.productId;
  $('pn-status').innerHTML = `<span class="tag ${st.cls}">${st.label}</span>`;
  $('pn-credits-stat').style.display = canGen(g) ? '' : 'none';
  $('pn-credits').textContent = g.credits || 0;
  $('pn-ends').textContent = g.expiresAt === 0 || g.expiresAt == null ? 'Never' : fmtDate(g.expiresAt);
  $('pn-ends-s').textContent = ends ? (ends > Date.now() ? `${Math.ceil((ends - Date.now()) / 86400000)} days left` : 'Ended') : 'No end date';
  $('pn-made').textContent = g.keysMade || 0;

  $('pn-tabs').style.display = tabs.length > 1 ? '' : 'none';
  $('pn-tabs').innerHTML = tabs.map(([id, label]) => `<button data-t="${id}" class="${id === tab ? 'on' : ''}">${label}</button>`).join('');

  $('pn-dl-card').style.display = canDl(g) ? '' : 'none';
  $('pn-dl-btn').disabled = !st.ok;
  setMsg('pn-dl-msg', st.ok ? '' : 'err', st.ok ? '' : st.why);

  $('pn-gen-card').style.display = canGen(g) ? '' : 'none';
  $('pn-overview-empty').style.display = canDl(g) || canGen(g) ? 'none' : '';
  $('pn-result').style.display = 'none';
  setMsg('pn-gen-msg', '', '');
  const costs = g.product?.costs || {};
  const opts = DURS.filter(([d]) => costs[d] > 0), prev = $('pn-days').value;
  $('pn-days').innerHTML = opts.map(([d, l]) => `<option value="${d}">${l} (${costs[d]} credit${costs[d] === 1 ? '' : 's'})</option>`).join('') || '<option value="">No prices set</option>';
  if (opts.some(([d]) => String(d) === prev)) $('pn-days').value = prev;
  $('pn-gen-btn').disabled = !st.ok || !opts.length;
  if (!st.ok) setMsg('pn-gen-msg', 'err', st.why);
  else if (!opts.length) setMsg('pn-gen-msg', 'err', 'The owner hasn’t set prices for this product yet.');
  pnCost();
  showTab(tab);
}

function showTab(t) {
  const g = current(); if (!g) return;
  tab = t;
  clearInterval(timer);
  document.querySelectorAll('#pn-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  for (const id of ['overview', 'keys', 'sessions', 'activity']) $('pn-t-' + id).style.display = id === t ? '' : 'none';
  if (t === 'keys') loadKeys(g);
  if (t === 'sessions') { loadSessions(g); timer = setInterval(() => { if (S.view === 'panels' && tab === 'sessions') loadSessions(g); else clearInterval(timer); }, 8000); }
  if (t === 'activity') loadActivity(g);
}
$('pn-tabs').addEventListener('click', e => { if (e.target.dataset?.t) showTab(e.target.dataset.t); });

window.pickPanel = id => { selected = id; renderPanels(); };

window.pnCost = () => {
  const g = current(); if (!g) return;
  const d = parseInt($('pn-days').value), qty = Math.max(1, Math.min(50, parseInt($('pn-qty').value) || 1));
  const cost = g.product?.costs?.[d];
  if (!(cost > 0)) { $('pn-cost').textContent = ''; return; }
  const total = cost * qty, have = g.credits || 0;
  $('pn-cost').innerHTML = `Costs <b>${total}</b> credit${total === 1 ? '' : 's'}${total > have ? ` <span style="color:var(--pink)">· you have ${have}</span>` : ` · ${have - total} left after`}`;
};

// ---------- make keys ----------
window.pnGenerate = async () => {
  const g = current(); if (!g) return;
  const days = parseInt($('pn-days').value), qty = Math.max(1, Math.min(50, parseInt($('pn-qty').value) || 1));
  const btn = $('pn-gen-btn'); btn.disabled = true; btn.textContent = 'Making…'; setMsg('pn-gen-msg', '', '');
  try {
    const r = await api(`/api/panels/${g.id}/keys`, { method: 'POST', body: JSON.stringify({ days, qty, note: $('pn-note').value.trim() }) });
    g.credits = r.credits; g.keysMade = (g.keysMade || 0) + r.keys.length;
    lastKeys = r.keys;
    renderPanels();
    $('pn-result').style.display = ''; $('pn-result-list').value = lastKeys.join('\n');
    $('pn-result-label').textContent = `${r.keys.length} key${r.keys.length === 1 ? '' : 's'} · ${durLabel(days)} · ${r.cost} credits spent`;
    toast(`${r.keys.length} key(s) made`);
  } catch (e) { setMsg('pn-gen-msg', 'err', e.message); }
  finally { btn.textContent = 'Make keys'; btn.disabled = !state(current() || g).ok; }
};
window.pnCopyAll = () => copy(lastKeys.join('\n'));

// ---------- keys ----------
async function loadKeys(g) {
  $('pn-keys').innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
  try {
    const r = await api(`/api/panels/${g.id}/keys`);
    if (selected !== g.id) return;
    keyRows = r.keys;
    $('pn-page').innerHTML = r.page ? `Buyers enter keys at <b>sovyx.cc/b/${esc(r.page)}</b>` : 'The owner hasn’t published a download page for this product yet.';
    pnRenderKeys();
  } catch (e) { keyRows = []; $('pn-count').textContent = 0; $('pn-keys').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`; }
}

window.pnRenderKeys = () => {
  const g = current(); if (!g) return;
  const q = $('pn-q').value.toLowerCase();
  const rows = keyRows.filter(k => !q || [k.key, k.usedBy, k.note, k.reseller].some(v => (v || '').toLowerCase().includes(q)));
  $('pn-count').textContent = rows.length;
  const tag = { unused: 't-off', used: 't-live', banned: 't-bad' }, ok = state(g).ok;
  $('pn-keys').innerHTML = rows.length ? rows.map(k => `<tr>
    <td><span class="mono">${esc(k.key)}</span>${k.note ? `<div class="u-sub">${esc(k.note)}</div>` : ''}</td>
    <td class="muted">${esc(durLabel(k.days))}</td><td><span class="tag ${tag[k.status] || 't-off'}">${esc(k.status || 'unused')}</span></td>
    <td class="muted">${k.usedBy ? esc(k.usedBy) : '—'}</td><td class="mono dimc">${k.hwid ? esc(k.hwid) : '—'}</td>
    <td class="muted">${k.mine ? 'You' : esc(k.reseller || '—')}</td>
    <td><div class="acts"><button class="btn btn-sm" onclick="copy('${esc(k.key)}')">Copy</button>
      ${canManage(g) && ok ? `${k.hwid ? `<button class="btn btn-sm" onclick="pnKeyAction('${esc(k.id)}','reset-hwid')">Reset HWID</button>` : ''}
        ${k.status === 'banned' ? `<button class="btn btn-sm" onclick="pnKeyAction('${esc(k.id)}','unban')">Unban</button>` : `<button class="btn btn-sm btn-danger" onclick="pnBan('${esc(k.id)}','${esc(k.key)}')">Ban</button>`}` : ''}</div></td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">${keyRows.length ? 'No keys match' : canGen(g) ? 'No keys yet. Make some on the Overview tab.' : 'No keys yet.'}</td></tr>`;
};

window.pnKeyAction = async (id, action) => {
  const g = current();
  const label = { 'reset-hwid': 'HWID reset', ban: 'Key banned', unban: 'Key unbanned' }[action];
  try { await api(`/api/panels/${g.id}/keys/${id}/${action}`, { method: 'POST' }); toast(label); loadKeys(g); }
  catch (e) { toast(e.message, true); }
};
window.pnBan = (id, key) => confirmBox(`Ban ${key}? The buyer can't use it until you unban it.`, () => pnKeyAction(id, 'ban'), 'Ban key');

// ---------- sessions ----------
async function loadSessions(g) {
  try {
    const r = await api(`/api/panels/${g.id}/sessions`);
    if (selected !== g.id || tab !== 'sessions') return;
    $('pn-sess-count').textContent = r.sessions.length;
    const live = s => Date.now() - (s.lastSeen ? new Date(s.lastSeen).getTime() : 0) < 60000;
    $('pn-sess').innerHTML = r.sessions.length ? r.sessions.map(s => `<tr>
      <td><div class="u-cell"><div class="av">${esc((s.username || '?').slice(0, 2).toUpperCase())}</div><span class="u-name">${esc(s.username || 'unknown')}</span></div></td>
      <td class="mono muted">${esc(s.ip || '—')}</td><td class="mono dimc">${s.hwid ? esc(s.hwid) : '—'}</td>
      <td class="muted">${when(s.lastSeen)}</td>
      <td>${live(s) ? '<span class="dot"></span>Live' : '<span class="dot idle"></span><span class="muted">Stale</span>'}</td>
      <td><div class="acts">${canManage(g) ? `<button class="btn btn-sm btn-danger" onclick="pnEndSession('${esc(s.id)}')">End</button>` : ''}</div></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Nobody is connected right now.</td></tr>';
  } catch (e) { $('pn-sess').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`; }
}
window.pnEndSession = async id => {
  const g = current();
  try { await api(`/api/panels/${g.id}/sessions/${id}/end`, { method: 'POST' }); toast('Session ended'); loadSessions(g); }
  catch (e) { toast(e.message, true); }
};

// ---------- activity ----------
async function loadActivity(g) {
  $('pn-act').innerHTML = '<tr><td colspan="3" class="empty">Loading…</td></tr>';
  try {
    const r = await api(`/api/panels/${g.id}/activity`);
    if (selected !== g.id || tab !== 'activity') return;
    $('pn-act-count').textContent = r.events.length;
    $('pn-act').innerHTML = r.events.length ? r.events.map(e => `<tr><td>${esc(e.text)}</td><td class="muted">${esc(e.by || '—')}</td><td class="muted">${when(e.at)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">Nothing yet.</td></tr>';
  } catch (e) { $('pn-act').innerHTML = `<tr><td colspan="3" class="empty">${esc(e.message)}</td></tr>`; }
}

// ---------- download ----------
window.pnDownload = async () => {
  const g = current(); if (!g) return;
  const btn = $('pn-dl-btn'); btn.disabled = true; setMsg('pn-dl-msg', '', '');
  try {
    const r = await api(`/api/panels/${g.id}/download`, { method: 'POST' });
    const a = document.createElement('a'); a.href = API_BASE + r.url; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setMsg('pn-dl-msg', 'ok', `Downloading ${r.filename}${r.size ? ` · ${(r.size / 1048576).toFixed(1)} MB` : ''}`);
  } catch (e) { setMsg('pn-dl-msg', 'err', e.message); }
  finally { btn.disabled = !state(current() || g).ok; }
};

loaders.panels = renderPanels;
