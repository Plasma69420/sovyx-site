import { auth, db, API_BASE, $, esc, toMs, fmtDate, toast, copy } from '/assets/fb.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { S, loaders } from './state.js';

const DURS = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Lifetime']];
const durLabel = d => (DURS.find(x => x[0] === d) || [d, d + ' days'])[1];
let selected = null, lastKeys = [];

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
function state(g) {
  if (g.status === 'suspended') return { ok: false, label: 'Suspended', cls: 't-warn', why: 'This panel is suspended.' };
  const m = toMs(g.expiresAt);
  if (m && m < Date.now()) return { ok: false, label: 'Expired', cls: 't-bad', why: 'This panel has expired.' };
  if (g.product && g.product.active === false) return { ok: false, label: 'Product off', cls: 't-warn', why: 'This product is switched off right now.' };
  return { ok: true, label: 'Active', cls: 't-live', why: '' };
}
const canGen = g => g.canGenerate !== false;
const canDl = g => g.canDownload !== false;

function setMsg(id, type, text) { const m = $(id); m.className = 'msg ' + type; m.textContent = text; }

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
  const st = state(g), ends = toMs(g.expiresAt);
  $('pn-detail').style.display = '';
  $('pn-name').textContent = g.productName || g.productId;
  $('pn-status').innerHTML = `<span class="tag ${st.cls}">${st.label}</span>`;
  $('pn-credits-stat').style.display = canGen(g) ? '' : 'none';
  $('pn-credits').textContent = g.credits || 0;
  $('pn-ends').textContent = g.expiresAt === 0 || g.expiresAt == null ? 'Never' : fmtDate(g.expiresAt);
  $('pn-ends-s').textContent = ends ? (ends > Date.now() ? `${Math.ceil((ends - Date.now()) / 86400000)} days left` : 'Ended') : 'No end date';
  $('pn-made').textContent = g.keysMade || 0;

  $('pn-dl-card').style.display = canDl(g) ? '' : 'none';
  $('pn-dl-btn').disabled = !st.ok;
  setMsg('pn-dl-msg', st.ok ? '' : 'err', st.ok ? '' : st.why);

  $('pn-gen-card').style.display = canGen(g) ? '' : 'none';
  $('pn-keys-wrap').style.display = canGen(g) ? '' : 'none';
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
  if (canGen(g)) loadKeys(g);
}

window.pickPanel = id => { selected = id; renderPanels(); };

window.pnCost = () => {
  const g = current(); if (!g) return;
  const d = parseInt($('pn-days').value), qty = Math.max(1, Math.min(50, parseInt($('pn-qty').value) || 1));
  const cost = g.product?.costs?.[d];
  if (!(cost > 0)) { $('pn-cost').textContent = ''; return; }
  const total = cost * qty, have = g.credits || 0;
  $('pn-cost').innerHTML = `Costs <b>${total}</b> credit${total === 1 ? '' : 's'}${total > have ? ` <span style="color:var(--pink)">· you have ${have}</span>` : ` · ${have - total} left after`}`;
};

async function api(path, opts = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(API_BASE + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } })
    .catch(() => { throw new Error('Couldn’t reach the server. Try again in a moment.'); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

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

async function loadKeys(g) {
  $('pn-keys').innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
  try {
    const r = await api(`/api/panels/${g.id}/keys`);
    if (selected !== g.id) return;
    g.page = r.page;
    $('pn-count').textContent = r.keys.length;
    $('pn-page').innerHTML = r.page ? `Your buyers enter these keys at <b>sovyx.cc/b/${esc(r.page)}</b>` : 'The owner hasn’t published a download page for this product yet.';
    const tag = { unused: 't-off', used: 't-live', banned: 't-bad' };
    $('pn-keys').innerHTML = r.keys.length ? r.keys.map(k => `<tr>
      <td><span class="mono">${esc(k.key)}</span>${k.note ? `<div class="u-sub">${esc(k.note)}</div>` : ''}</td>
      <td class="muted">${esc(durLabel(k.days))}</td><td><span class="tag ${tag[k.status] || 't-off'}">${esc(k.status || 'unused')}</span></td>
      <td class="muted">${k.usedBy ? esc(k.usedBy) : '—'}</td><td class="muted">${k.createdAt ? fmtDate(new Date(k.createdAt)) : '—'}</td>
      <td><div class="acts"><button class="btn btn-sm" onclick="copy('${esc(k.key)}')">Copy</button></div></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No keys yet. Make some above.</td></tr>';
  } catch (e) { $('pn-keys').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`; }
}

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
