import { auth, db, PLAN_RANK, PLAN_LABEL, esc, $, toMs, fmtDate, initials, randHex, toast, openModal, closeModal, confirmBox, copy } from '/assets/fb.js';
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, getDocs, writeBatch, serverTimestamp, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { S, LIMITS, PLAN_FEATURES, loaders } from './state.js';
import './sections.js?v=2';
import './brand.js?v=4';
import { loadPanels } from './panels.js?v=3';

const I = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  box:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>',
  users:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  pulse:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  ban:'<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  code:'<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  hook:'<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 012 17c.01-.7.2-1.4.57-2"/><path d="M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 116.89-4.06"/><path d="M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 010 8"/>',
  db:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  bot:'<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4M8 14h.01M16 14h.01"/>',
  store:'<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
  card:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
};

const NAV = [
  { sec: 'Workspace' },
  { id: 'overview',  label: 'Overview',       icon: 'grid',  min: 'free' },
  { id: 'panels',    label: 'My panels',      icon: 'store', min: 'free',     panels: true },
  { id: 'apps',      label: 'Applications',   icon: 'box',   min: 'free' },
  { sec: 'Application' },
  { id: 'licenses',  label: 'Licenses',       icon: 'key',   min: 'free',     needsApp: true },
  { id: 'users',     label: 'Users',          icon: 'users', min: 'free',     needsApp: true },
  { id: 'sessions',  label: 'Sessions',       icon: 'pulse', min: 'free',     needsApp: true },
  { id: 'brand',     label: 'Customer page',  icon: 'globe', min: 'free',     needsApp: true },
  { sec: 'Development' },
  { id: 'api',       label: 'API keys',       icon: 'code',  min: 'basic',    needsApp: true },
  { id: 'webhooks',  label: 'Webhooks',       icon: 'hook',  min: 'pro',      needsApp: true },
  { id: 'variables', label: 'Variables',      icon: 'db',    min: 'pro',      needsApp: true },
  { sec: 'Protection' },
  { id: 'blacklist', label: 'Blacklist',      icon: 'ban',   min: 'pro',      needsApp: true },
  { sec: 'Organization' },
  { id: 'resellers', label: 'Reseller panel', icon: 'store', min: 'ultimate', needsApp: true },
  { id: 'discord',   label: 'Discord bot',    icon: 'bot',   min: 'ultimate', needsApp: true },
  { id: 'billing',   label: 'Plan & billing', icon: 'card',  min: 'free' },
  { id: 'settings',  label: 'Settings',       icon: 'gear',  min: 'free' },
];

const hasPlan = min => PLAN_RANK[S.plan] >= PLAN_RANK[min];

// Accounts an admin set to "products only" see just their panels and settings.
const productsOnly = () => S.data?.portalMode === 'products';
const ONLY_VIEWS = new Set(['panels', 'settings']);
const navVisible = n => n.panels ? S.panels.length > 0 : (!productsOnly() || ONLY_VIEWS.has(n.id));
function visibleNav() {
  const out = NAV.filter(n => n.sec || navVisible(n));
  return out.filter((n, i) => !n.sec || (out[i + 1] && !out[i + 1].sec));
}

function effectivePlan(d) {
  const p = d.plan || 'free';
  const exp = toMs(d.expiresAt);
  if (p !== 'free' && exp && exp < Date.now()) return 'free';
  return PLAN_RANK[p] !== undefined ? p : 'free';
}

// ---------- Auth ----------
onAuthStateChanged(auth, async u => {
  if (!u) { location.href = '/login'; return; }
  S.user = u;
  const ref = doc(db, 'users', u.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    S.data = { uid: u.uid, email: u.email, username: (u.email || 'user').split('@')[0], plan: 'free', credits: 0, licenseKey: null, hwid: null, expiresAt: null, createdAt: serverTimestamp() };
    await setDoc(ref, S.data);
  } else S.data = snap.data();
  if (S.data.banned) {
    $('loading').innerHTML = '<div style="text-align:center">This account has been suspended.<br><br><button class="btn" onclick="doLogout()">Sign out</button></div>';
    return;
  }
  S.plan = effectivePlan(S.data);
  getDoc(doc(db, 'settings', 'site')).then(s => {
    const msg = s.exists() && s.data().announcement;
    if (msg) $('announce').style.display = '', $('announce').textContent = msg;
  }).catch(() => {});
  await Promise.all([loadApps(), loadPanels()]);
  renderChrome();
  $('loading').style.display = 'none';
  $('app').style.display = '';
  go(location.hash.slice(1) || (productsOnly() ? 'panels' : 'overview'));
});

window.doLogout = () => signOut(auth).then(() => location.href = '/login');

// ---------- Apps ----------
async function loadApps() {
  const snap = await getDocs(query(collection(db, 'apps'), where('ownerUid', '==', S.user.uid))).catch(e => { console.warn('apps', e.message); return { docs: [] }; });
  S.apps = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (toMs(a.createdAt) || 0) - (toMs(b.createdAt) || 0));
  const saved = localStorage.getItem('svx_app');
  S.app = S.apps.find(a => a.id === saved) || S.apps[0] || null;
}

function selectApp(id, view = S.view) {
  S.app = S.apps.find(a => a.id === id) || null;
  if (S.app) localStorage.setItem('svx_app', S.app.id);
  closeModal('m-apps');
  renderChrome();
  go(view);
}
window.selectApp = selectApp;

window.createApp = async () => {
  const name = $('na-name').value.trim();
  if (!name) return toast('Give the application a name', true);
  if (S.apps.length >= LIMITS[S.plan].apps) return toast(`Your ${PLAN_LABEL[S.plan]} plan allows ${LIMITS[S.plan].apps} application(s). Upgrade for more.`, true);
  const ref = await addDoc(collection(db, 'apps'), {
    ownerUid: S.user.uid, name, version: $('na-ver').value.trim() || '1.0.0',
    secret: randHex(24), sellerKey: randHex(16), hwidLock: true, createdAt: serverTimestamp(),
  });
  $('na-name').value = '';
  closeModal('m-newapp');
  await loadApps();
  toast('Application created');
  selectApp(ref.id, 'overview');
};

window.saveApp = async () => {
  if (!S.app) return;
  const upd = { name: $('set-app-name').value.trim() || S.app.name, version: $('set-app-ver').value.trim(), hwidLock: $('set-app-hwid').value === '1', download: $('set-app-dl').value.trim(),
    hwidReset: { enabled: $('set-app-reset').value === '1', cooldownDays: Math.max(0, Math.min(365, parseInt($('set-app-cd').value) || 0)) } };
  await updateDoc(doc(db, 'apps', S.app.id), upd);
  Object.assign(S.app, upd);
  renderChrome(); toast('Application saved');
};

window.deleteApp = () => {
  if (!S.app) return;
  confirmBox(`Delete "${S.app.name}"? Its licenses and users stop working immediately.`, async () => {
    await deleteDoc(doc(db, 'apps', S.app.id));
    localStorage.removeItem('svx_app');
    await loadApps(); renderChrome(); go('apps'); toast('Application deleted');
  }, 'Delete application');
};

// ---------- Chrome ----------
function renderChrome() {
  const d = S.data;
  const name = d.discordUsername || d.username || d.email;
  $('me-name').textContent = name;
  $('me-plan').textContent = PLAN_LABEL[S.plan] + ' plan';
  $('me-av').innerHTML = d.discordAvatar ? `<img src="${esc(d.discordAvatar)}" alt=""/>` : esc(initials(name));
  $('top-plan').className = 'tag t-' + S.plan;
  $('top-plan').textContent = PLAN_LABEL[S.plan];
  $('ws-name').textContent = S.app ? S.app.name : 'No application';
  $('ws-av').textContent = S.app ? initials(S.app.name) : '–';
  $('crumb-app').textContent = productsOnly() ? 'Account' : (S.app ? S.app.name : '—');
  $('app-switch').style.display = productsOnly() ? 'none' : '';

  $('side-nav').innerHTML = visibleNav().map(n => {
    if (n.sec) return `<div class="side-sec">${n.sec}</div>`;
    const ok = hasPlan(n.min);
    const right = ok ? '' : `<span class="tag t-${n.min}">${PLAN_LABEL[n.min]}</span>`;
    return `<button class="side-item${ok ? '' : ' locked'}" data-v="${n.id}" onclick="go('${n.id}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n.icon]}</svg>${n.label}${right}</button>`;
  }).join('');

  $('apps-list').innerHTML = S.apps.length ? S.apps.map(a => `
    <button class="side-item${S.app?.id === a.id ? ' on' : ''}" onclick="selectApp('${a.id}')">
      <span class="ws-av">${esc(initials(a.name))}</span>${esc(a.name)}<span class="count">${esc(a.version || '')}</span></button>`).join('')
    : '<div class="empty">No applications yet</div>';
}

// ---------- Routing ----------
function go(view) {
  let n = NAV.find(x => x.id === view);
  if (!n || !navVisible(n)) n = NAV.find(x => x.id === (productsOnly() ? (S.panels.length ? 'panels' : 'settings') : 'overview'));
  S.view = n.id;
  history.replaceState(null, '', '#' + n.id);
  document.querySelectorAll('.side-item[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === n.id));
  $('crumb-view').textContent = n.label;
  let target = n.id;
  if (!hasPlan(n.min)) {
    target = 'locked';
    $('lk-title').textContent = `${n.label} is on ${PLAN_LABEL[n.min]}`;
    $('lk-body').textContent = `Upgrade to ${PLAN_LABEL[n.min]} or higher to unlock ${n.label.toLowerCase()} for your applications.`;
  } else if (n.needsApp && !S.app) target = 'noapp';
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + target));
  if (target === n.id && loaders[n.id]) loaders[n.id]();
}
window.go = go;

// ---------- Overview ----------
loaders.overview = async () => {
  const d = S.data;
  $('ov-welcome').textContent = `Welcome back, ${d.discordUsername || d.username || 'there'}.`;
  $('ov-apps').textContent = S.apps.length;
  const lim = LIMITS[S.plan];
  $('ov-apps-s').textContent = lim.apps === Infinity ? 'Unlimited on your plan' : `${lim.apps - S.apps.length} left on your plan`;

  let lic = [], users = [], sess = [];
  if (S.app) {
    const base = ['apps', S.app.id];
    [lic, users, sess] = await Promise.all(['licenses', 'appUsers', 'sessions'].map(c =>
      getDocs(collection(db, ...base, c)).then(s => s.docs.map(x => x.data())).catch(() => [])));
  }
  const live = sess.filter(s => Date.now() - (toMs(s.lastSeen) || 0) < 60000).length;
  $('ov-sessions').textContent = live;
  $('ov-users').textContent = users.length;
  $('ov-licenses').textContent = lic.length;
  $('ov-licenses-s').textContent = `${lic.filter(l => l.status === 'unused').length} unused`;

  const days = [...Array(7)].map((_, i) => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate() - (6 - i)); return t; });
  const counts = days.map(dy => lic.filter(l => { const m = toMs(l.createdAt); return m && m >= dy.getTime() && m < dy.getTime() + 86400000; }).length);
  const max = Math.max(1, ...counts);
  $('ov-chart').innerHTML = counts.map(c => `<div class="bar" data-v="${c}" style="height:${(c / max) * 100}%"></div>`).join('');
  $('ov-chart-x').innerHTML = days.map(dy => `<span>${dy.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`).join('');

  const attn = [];
  if (!S.app) attn.push('Create your first application to start issuing licenses.');
  const exp = toMs(d.expiresAt);
  if (exp && exp > Date.now() && exp - Date.now() < 7 * 86400000) attn.push(`Your plan expires ${fmtDate(d.expiresAt)}.`);
  if (lim.licenses !== Infinity && lic.length > lim.licenses * 0.8) attn.push(`You've used ${lic.length} of ${lim.licenses} licenses on this application.`);
  const banned = users.filter(u => u.banned).length;
  if (banned) attn.push(`${banned} banned user(s) in ${S.app.name}.`);
  $('ov-attn').innerHTML = attn.length ? attn.map(a => `<div class="kv"><span>${esc(a)}</span></div>`).join('') : '<div class="dimc">Nothing right now.</div>';

  $('ov-plan-sub').textContent = `${PLAN_LABEL[S.plan]}${exp ? ' · renews ' + fmtDate(d.expiresAt) : ''}`;
  $('ov-limits').innerHTML = PLAN_FEATURES[S.plan].map(f => `<div class="kv"><span>${esc(f)}</span><span style="color:var(--green)">✓</span></div>`).join('');
};

// ---------- Applications list ----------
loaders.apps = () => {
  $('apps-body').innerHTML = S.apps.length ? S.apps.map(a => `<tr>
    <td><div class="u-cell"><div class="av">${esc(initials(a.name))}</div><span class="u-name">${esc(a.name)}</span>${S.app?.id === a.id ? '<span class="tag t-live">Selected</span>' : ''}</div></td>
    <td class="mono muted">${esc(a.id)}</td><td class="muted">${esc(a.version || '—')}</td><td class="muted">${fmtDate(a.createdAt)}</td>
    <td><div class="acts"><button class="btn btn-sm" onclick="selectApp('${a.id}','overview')">Open</button></div></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No applications yet</td></tr>';
};

// ---------- Billing ----------
loaders.billing = () => {
  const d = S.data;
  $('bill-plan').innerHTML = `<span class="tag t-${S.plan}">${PLAN_LABEL[S.plan]}</span>`;
  $('bill-exp').textContent = S.plan === 'free' ? '—' : (d.expiresAt === 0 || d.expiresAt == null ? 'Never' : fmtDate(d.expiresAt));
  $('bill-key').textContent = d.licenseKey || 'None';
  $('bill-credits').textContent = d.credits || 0;
  $('bill-sub').textContent = S.plan !== (d.plan || 'free') ? 'Your previous plan has expired.' : 'Thanks for using Sovyx.';
  $('plan-cards').innerHTML = ['basic', 'pro', 'ultimate'].map(p => `
    <div class="card"${p === S.plan ? ' style="border-color:var(--b3)"' : ''}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3>${PLAN_LABEL[p]}</h3>${p === S.plan ? '<span class="tag t-live">Current</span>' : ''}</div>
      ${PLAN_FEATURES[p].map(f => `<div class="kv"><span>${esc(f)}</span></div>`).join('')}
      ${p !== S.plan ? '<a class="btn btn-sm btn-block" style="margin-top:14px" href="/#pricing">Get ' + PLAN_LABEL[p] + '</a>' : ''}
    </div>`).join('');
};

window.activateKey = async () => {
  const key = $('key-input').value.trim().toUpperCase();
  const btn = $('key-btn'), msg = $('key-msg');
  msg.className = 'msg';
  if (!key) { msg.className = 'msg err'; msg.textContent = 'Enter a key.'; return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const keyRef = doc(db, 'licenseKeys', key);
    const ks = await getDoc(keyRef).catch(() => null);
    if (!ks?.exists() || ks.data().assigned) throw new Error('Key not found or already used.');
    const kd = ks.data();
    const plan = kd.plan || ({ BSC: 'basic', PRO: 'pro', ULT: 'ultimate' }[key.split('-')[1]] ?? 'basic');
    const days = kd.days ?? kd.durationDays ?? 30;
    const expiresAt = days === 0 ? 0 : Timestamp.fromMillis(Date.now() + days * 86400000);
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', S.user.uid), { plan, licenseKey: key, expiresAt });
    batch.update(keyRef, { assigned: true, assignedTo: S.user.uid, assignedEmail: S.user.email, assignedAt: serverTimestamp() });
    await batch.commit();
    Object.assign(S.data, { plan, licenseKey: key, expiresAt });
    S.plan = effectivePlan(S.data);
    renderChrome(); loaders.billing();
    msg.className = 'msg ok'; msg.textContent = `Redeemed. You're now on ${PLAN_LABEL[plan]}.`;
    $('key-input').value = '';
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Redeem'; }
};

// ---------- Settings ----------
loaders.settings = () => {
  const d = S.data;
  $('set-username').value = d.username || '';
  $('set-email').textContent = d.email || S.user.email;
  $('set-discord').textContent = d.discordUsername || 'Not linked';
  $('set-joined').textContent = fmtDate(d.createdAt);
  if (S.app) {
    $('set-app-sub').textContent = S.app.name;
    $('set-app-name').value = S.app.name;
    $('set-app-ver').value = S.app.version || '';
    $('set-app-hwid').value = S.app.hwidLock === false ? '0' : '1';
    $('set-app-dl').value = S.app.download || '';
    $('set-app-reset').value = S.app.hwidReset?.enabled === false ? '0' : '1';
    $('set-app-cd').value = S.app.hwidReset?.cooldownDays ?? 7;
  } else $('set-app-sub').textContent = 'Create an application first';
};

window.saveAccount = async () => {
  const username = $('set-username').value.trim();
  if (!username) return toast('Username can’t be empty', true);
  await updateDoc(doc(db, 'users', S.user.uid), { username });
  S.data.username = username; renderChrome(); toast('Account saved');
};

export { go, renderChrome, copy };
