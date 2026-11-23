import { auth, db, PLAN_LABEL, esc, $, toMs, fmtDate, ago, initials, randBlock, randHex, toast, openModal, closeModal, confirmBox, copy } from '/assets/fb.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, query, where, orderBy, limit, serverTimestamp, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const I = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  users:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>',
  store:'<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
  box:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  pulse:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu:'<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};
const NAV = [
  { sec: 'Overview' },
  { id: 'dash', label: 'Dashboard', icon: 'grid' },
  { sec: 'Customers' },
  { id: 'users', label: 'Customers', icon: 'users' },
  { id: 'keys', label: 'Subscription keys', icon: 'key' },
  { id: 'resellers', label: 'Resellers', icon: 'store' },
  { sec: 'Strive' },
  { id: 'products', label: 'Products', icon: 'box' },
  { id: 'access', label: 'Panel access', icon: 'users' },
  { sec: 'Platform' },
  { id: 'apps', label: 'Applications', icon: 'box' },
  { id: 'sessions', label: 'Live sessions', icon: 'pulse' },
  { id: 'hwid', label: 'HWID resets', icon: 'cpu', badge: 'hwid' },
  { sec: 'System' },
  { id: 'activity', label: 'Activity log', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

let users = [], keys = [], resellers = [], apps = [], hwids = [], activity = [], settings = {}, products = [], panels = [];
let view = 'dash', uFilter = '', kFilter = '', lastKeys = [];
const now = () => Date.now();
const isPaid = u => (u.plan && u.plan !== 'free') && !(toMs(u.expiresAt) && toMs(u.expiresAt) < now());
const isExpired = u => u.plan && u.plan !== 'free' && toMs(u.expiresAt) && toMs(u.expiresAt) < now();
const durLabel = d => d === 0 ? 'Lifetime' : d % 365 === 0 ? (d / 365) + ' year' : d + ' days';
const empty = (n, t) => `<tr><td colspan="${n}" class="empty">${t}</td></tr>`;
const adminId = email => email.toLowerCase().replace(/[^a-z0-9]/g, '_');

async function log(action, details = '') {
  try { await addDoc(collection(db, 'activity'), { action, details, admin: auth.currentUser?.email || '', at: serverTimestamp() }); } catch {}
}

// ---------- Auth ----------
onAuthStateChanged(auth, async u => {
  $('loading').style.display = 'none';
  if (!u) { $('login').style.display = 'flex'; $('app').style.display = 'none'; return; }
  const allowed = await checkAdmin(u);
  if (!allowed) {
    await signOut(auth);
    $('li-err').className = 'msg err'; $('li-err').textContent = 'This account is not an admin.';
    return;
  }
  $('login').style.display = 'none'; $('app').style.display = '';
  $('me-email').textContent = u.email; $('me-av').textContent = initials(u.email);
  view = NAV.some(n => n.id === location.hash.slice(1)) ? location.hash.slice(1) : 'dash';
  await refresh();
});

async function checkAdmin(u) {
  try {
    if ((await getDoc(doc(db, 'admins', adminId(u.email)))).exists()) return true;
    if (!(await getDocs(query(collection(db, 'admins'), where('email', '==', u.email), limit(1)))).empty) return true;
    const any = await getDocs(query(collection(db, 'admins'), limit(1)));
    if (any.empty) { await setDoc(doc(db, 'admins', adminId(u.email)), { email: u.email, addedAt: serverTimestamp() }); return true; }
    return false;
  } catch { return false; }
}

window.doLogin = async () => {
  const btn = $('li-btn'), err = $('li-err');
  err.className = 'msg'; btn.disabled = true; btn.textContent = 'Signing in…';
  try { await signInWithEmailAndPassword(auth, $('li-email').value.trim(), $('li-pass').value); }
  catch (e) { err.className = 'msg err'; err.textContent = e.code === 'auth/invalid-credential' ? 'Wrong email or password.' : e.message; }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
};
$('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') window.doLogin(); });
window.doLogout = () => signOut(auth);

// ---------- Nav ----------
function renderNav() {
  const pending = hwids.filter(h => h.status !== 'done').length;
  $('side-nav').innerHTML = NAV.map(n => n.sec ? `<div class="side-sec">${n.sec}</div>` :
    `<button class="side-item${view === n.id ? ' on' : ''}" data-v="${n.id}" onclick="go('${n.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n.icon]}</svg>${n.label}${n.badge && pending ? `<span class="tag t-warn">${pending}</span>` : ''}</button>`).join('');
}
function go(v) {
  const n = NAV.find(x => x.id === v) || NAV[1];
  view = n.id; history.replaceState(null, '', '#' + n.id);
  $('crumb').textContent = n.label;
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + n.id));
  renderNav();
  ({ dash: renderDash, users: renderUsers, keys: renderKeys, resellers: renderResellers, products: renderProducts, access: renderAccess, apps: renderApps, sessions: loadSessions, hwid: renderHwid, activity: renderActivity, settings: renderSettings })[n.id]?.();
}
window.go = go;

const all = async (name, ...q) => {
  try { return (await getDocs(q.length ? query(collection(db, name), ...q) : collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { console.warn(name, e.message); return []; }
};
async function refresh() {
  [users, keys, resellers, apps, hwids, activity, products, panels] = await Promise.all([
    all('users'), all('licenseKeys'), all('resellers'), all('apps'),
    all('hwid_resets'), all('activity', orderBy('at', 'desc'), limit(200)), all('products'), all('panelAccess'),
  ]);
  const s = await getDoc(doc(db, 'settings', 'site')).catch(() => null);
  const p = await getDoc(doc(db, 'settings', 'plans')).catch(() => null);
  settings = { ...(p?.data() || {}), ...(s?.data() || {}) };
  renderNav();
  go(view);
}
window.refresh = refresh;

// ---------- Dashboard ----------
function renderDash() {
  const paid = users.filter(isPaid);
  const week = users.filter(u => (toMs(u.createdAt) || 0) > now() - 7 * 86400000).length;
  $('d-users').textContent = users.length;
  $('d-users-s').textContent = `+${week} this week`;
  $('d-paying').textContent = paid.length;
  $('d-plans').textContent = ['basic', 'pro', 'ultimate'].map(p => `${paid.filter(u => u.plan === p).length} ${PLAN_LABEL[p]}`).join(' · ');
  const unused = keys.filter(k => !k.assigned);
  $('d-stock').textContent = unused.length;
  $('d-stock-s').textContent = `${keys.length - unused.length} redeemed all time`;
  $('d-hwid').textContent = hwids.filter(h => h.status !== 'done').length;

  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (13 - i)); return d.getTime(); });
  const counts = days.map(d => users.filter(u => { const m = toMs(u.createdAt); return m && m >= d && m < d + 86400000; }).length);
  const max = Math.max(1, ...counts);
  $('d-chart').innerHTML = counts.map(c => `<div class="bar" data-v="${c}" style="height:${c / max * 100}%"></div>`).join('');
  $('d-chart-x').innerHTML = days.map((d, i) => `<span>${i % 2 ? '' : new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`).join('');

  const soon = users.filter(u => { const m = toMs(u.expiresAt); return isPaid(u) && m && m - now() < 7 * 86400000; })
    .sort((a, b) => toMs(a.expiresAt) - toMs(b.expiresAt)).slice(0, 6);
  $('d-expiring').innerHTML = soon.length ? soon.map(u => `<div class="kv"><span>${esc(u.email)} <span class="tag t-${u.plan}">${PLAN_LABEL[u.plan]}</span></span><span>${fmtDate(u.expiresAt)}</span></div>`).join('') : '<div class="dimc">None</div>';
  $('d-activity').innerHTML = activity.length ? activity.slice(0, 6).map(a => `<div class="kv"><span>${esc(a.action)} <span class="dimc">${esc(a.details)}</span></span><span class="dimc">${ago(a.at)}</span></div>`).join('') : '<div class="dimc">Nothing yet</div>';
}

// ---------- Customers ----------
$('u-seg').addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') return; uFilter = e.target.dataset.f; $('u-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); renderUsers(); });
function renderUsers() {
  const q = $('u-q').value.toLowerCase();
  const appCount = {}; apps.forEach(a => appCount[a.ownerUid] = (appCount[a.ownerUid] || 0) + 1);
  const f = { paying: isPaid, free: u => !u.plan || u.plan === 'free', expired: isExpired, banned: u => u.banned }[uFilter] || (() => true);
  const list = users.filter(f).filter(u => !q || [u.email, u.username, u.discordUsername].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
  $('u-body').innerHTML = list.length ? list.map(u => {
    const st = u.banned ? '<span class="tag t-bad">Banned</span>' : isExpired(u) ? '<span class="tag t-warn">Expired</span>' : '<span class="tag t-live">Active</span>';
    const av = u.discordAvatar ? `<img src="${esc(u.discordAvatar)}" alt=""/>` : esc(initials(u.username || u.email));
    return `<tr>
      <td><div class="u-cell"><div class="av">${av}</div><div><div class="u-name">${esc(u.username || u.email)}</div><div class="u-sub">${esc(u.email)}${u.discordUsername ? ' · ' + esc(u.discordUsername) : ''}</div></div></div></td>
      <td><span class="tag t-${u.plan || 'free'}">${PLAN_LABEL[u.plan] || 'Free'}</span></td>
      <td class="muted">${!u.plan || u.plan === 'free' ? '—' : u.expiresAt == null || u.expiresAt === 0 ? 'Never' : fmtDate(u.expiresAt)}</td>
      <td class="muted">${appCount[u.id] || 0}</td><td class="muted">${u.credits || 0}</td>
      <td class="muted">${fmtDate(u.createdAt)}</td><td>${st}</td>
      <td><div class="acts"><button class="btn btn-sm" onclick="editUser('${u.id}')">Edit</button>
        <button class="btn btn-sm" onclick="toggleBan('${u.id}')">${u.banned ? 'Unban' : 'Ban'}</button>
        <button class="btn btn-sm btn-danger" onclick="delUser('${u.id}')">Delete</button></div></td></tr>`;
  }).join('') : empty(8, 'No customers match');
}
window.renderUsers = renderUsers;

window.editUser = id => {
  const u = users.find(x => x.id === id);
  $('eu-id').value = id; $('eu-email').textContent = u.email;
  $('eu-name').value = u.username || ''; $('eu-plan').value = u.plan || 'free';
  $('eu-credits').value = u.credits || 0; $('eu-note').value = u.adminNote || ''; $('eu-mode').value = u.portalMode === 'products' ? 'products' : 'full';
  const m = toMs(u.expiresAt);
  $('eu-exp').value = m ? new Date(m).toISOString().slice(0, 10) : '';
  openModal('m-user');
};
window.bumpExp = days => {
  const cur = $('eu-exp').value ? new Date($('eu-exp').value).getTime() : 0;
  $('eu-exp').value = new Date(Math.max(cur, now()) + days * 86400000).toISOString().slice(0, 10);
};
window.saveUser = async () => {
  const id = $('eu-id').value, u = users.find(x => x.id === id);
  const exp = $('eu-exp').value;
  const data = { username: $('eu-name').value.trim(), plan: $('eu-plan').value, credits: parseInt($('eu-credits').value) || 0,
    expiresAt: exp ? Timestamp.fromDate(new Date(exp + 'T23:59:59')) : 0, adminNote: $('eu-note').value.trim(), portalMode: $('eu-mode').value };
  await updateDoc(doc(db, 'users', id), data);
  Object.assign(u, data); closeModal('m-user'); toast('Customer saved');
  log('Customer edited', `${u.email} → ${PLAN_LABEL[data.plan]}`); renderUsers();
};
window.toggleBan = async id => {
  const u = users.find(x => x.id === id);
  await updateDoc(doc(db, 'users', id), { banned: !u.banned }); u.banned = !u.banned;
  toast(u.banned ? 'Customer banned' : 'Customer unbanned'); log(u.banned ? 'Customer banned' : 'Customer unbanned', u.email); renderUsers();
};
window.delUser = id => {
  const u = users.find(x => x.id === id);
  confirmBox(`Delete ${u.email}'s account data? Their sign-in still exists in Firebase Auth.`, async () => {
    await deleteDoc(doc(db, 'users', id)); users = users.filter(x => x.id !== id);
    toast('Customer deleted'); log('Customer deleted', u.email); renderUsers();
  });
};

// ---------- Keys ----------
$('k-seg').addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') return; kFilter = e.target.dataset.f; $('k-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); renderKeys(); });
const oldKeys = () => keys.filter(k => !k.assigned && k.key && k.id !== k.key);
window.migrateKeys = async () => {
  const list = oldKeys();
  for (let i = 0; i < list.length; i += 200) {
    const b = writeBatch(db);
    list.slice(i, i + 200).forEach(({ id, ...data }) => { b.set(doc(db, 'licenseKeys', data.key), data); b.delete(doc(db, 'licenseKeys', id)); });
    await b.commit();
  }
  toast(`${list.length} key(s) migrated`); log('Keys migrated', `${list.length} unused keys re-saved by key`);
  keys = await all('licenseKeys'); renderKeys();
};

function renderKeys() {
  $('migrate-btn').style.display = oldKeys().length ? '' : 'none';
  $('migrate-btn').textContent = `Migrate ${oldKeys().length} old key(s)`;
  const q = $('k-q').value.toLowerCase();
  const email = uid => users.find(u => u.id === uid)?.email;
  const list = keys.filter(k => !kFilter || (kFilter === 'used') === !!k.assigned)
    .filter(k => !q || [k.key, k.note, k.assignedEmail, email(k.assignedTo)].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
  $('k-body').innerHTML = list.length ? list.map(k => `<tr>
    <td><span class="mono">${esc(k.key)}</span>${k.note ? `<div class="u-sub">${esc(k.note)}</div>` : ''}${k.reseller ? `<div class="u-sub">via ${esc(k.reseller)}</div>` : ''}</td>
    <td><span class="tag t-${k.plan}">${PLAN_LABEL[k.plan] || k.plan}</span></td>
    <td class="muted">${durLabel(k.days ?? k.durationDays ?? 30)}</td>
    <td>${k.assigned ? esc(k.assignedEmail || email(k.assignedTo) || k.assignedTo) + `<div class="u-sub">${fmtDate(k.assignedAt)}</div>` : '<span class="tag t-off">Unused</span>'}</td>
    <td class="muted">${fmtDate(k.createdAt)}</td>
    <td><div class="acts"><button class="btn btn-sm" onclick="copy('${esc(k.key)}')">Copy</button>
      <button class="btn btn-sm btn-danger" onclick="delKey('${k.id}')">${k.assigned ? 'Revoke' : 'Delete'}</button></div></td></tr>`).join('')
    : empty(6, 'No keys match');
}
window.renderKeys = renderKeys;

window.genKeys = async () => {
  const qty = Math.max(1, Math.min(200, parseInt($('gk-qty').value) || 1));
  const plan = $('gk-plan').value, days = parseInt($('gk-days').value), note = $('gk-note').value.trim();
  const pfx = { basic: 'BSC', pro: 'PRO', ultimate: 'ULT' }[plan];
  $('gk-btn').disabled = true;
  try {
    const batch = writeBatch(db); lastKeys = [];
    for (let i = 0; i < qty; i++) {
      const key = `SVX-${pfx}-${randBlock()}-${randBlock()}-${randBlock()}`;
      lastKeys.push(key);
      batch.set(doc(db, 'licenseKeys', key), { key, plan, days, note, assigned: false, createdBy: auth.currentUser.email, createdAt: serverTimestamp() });
    }
    await batch.commit();
    $('gk-list').value = lastKeys.join('\n'); $('gk-label').textContent = `${qty} ${PLAN_LABEL[plan]} key(s), ${durLabel(days)}`;
    $('gk-out').style.display = '';
    toast(`${qty} key(s) generated`); log('Keys generated', `${qty} × ${PLAN_LABEL[plan]} ${durLabel(days)}`);
    keys = await all('licenseKeys'); renderKeys();
  } catch (e) { toast(e.message, true); }
  finally { $('gk-btn').disabled = false; }
};
window.copyGenerated = () => copy(lastKeys.join('\n'));

window.delKey = id => {
  const k = keys.find(x => x.id === id);
  const msg = k.assigned ? `Revoke ${k.key}? The customer drops to Free.` : `Delete ${k.key}?`;
  confirmBox(msg, async () => {
    if (k.assigned && k.assignedTo) {
      const u = users.find(x => x.id === k.assignedTo);
      if (u?.licenseKey === k.key) await updateDoc(doc(db, 'users', u.id), { plan: 'free', licenseKey: null, expiresAt: null }).catch(() => {});
    }
    await deleteDoc(doc(db, 'licenseKeys', id));
    keys = keys.filter(x => x.id !== id); toast(k.assigned ? 'Key revoked' : 'Key deleted');
    log(k.assigned ? 'Key revoked' : 'Key deleted', k.key); renderKeys();
  });
};

window.exportKeys = () => {
  const rows = [['key', 'plan', 'days', 'redeemed', 'redeemed_by', 'note']].concat(keys.map(k => [k.key, k.plan, k.days ?? '', k.assigned ? 'yes' : 'no', k.assignedEmail || k.assignedTo || '', k.note || '']));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = 'sovyx_keys.csv'; a.click();
};

// ---------- Resellers ----------
function renderResellers() {
  $('r-count').textContent = resellers.length;
  $('r-active').textContent = `${resellers.filter(r => r.active !== false).length} active`;
  $('r-credits').textContent = resellers.reduce((s, r) => s + (r.balance || 0), 0);
  $('r-keys').textContent = resellers.reduce((s, r) => s + (r.keysGenerated || 0), 0);
  const c = settings.credits || {};
  $('r-cost').textContent = `${c.basic ?? 1} · ${c.pro ?? 2} · ${c.ultimate ?? 4}`;
  $('r-body').innerHTML = resellers.length ? resellers.map(r => {
    const exp = toMs(r.panelExpires);
    const st = r.active === false ? '<span class="tag t-warn">Suspended</span>' : exp && exp < now() ? '<span class="tag t-bad">Expired</span>' : '<span class="tag t-live">Active</span>';
    return `<tr>
      <td><div class="u-cell"><div class="av">${esc(initials(r.name))}</div><div><div class="u-name">${esc(r.name)}</div><div class="u-sub">${esc(r.email)}</div></div></div></td>
      <td>${r.balance || 0}</td><td class="muted">${r.keysGenerated || 0}</td>
      <td>${(r.plans || []).map(p => `<span class="tag t-${p}" style="margin-right:4px">${PLAN_LABEL[p]}</span>`).join('')}</td>
      <td class="muted">${exp ? fmtDate(r.panelExpires) : 'Never'}</td><td>${st}</td>
      <td><div class="acts"><button class="btn btn-sm" onclick="editReseller('${r.id}')">Manage</button>
        <button class="btn btn-sm btn-danger" onclick="delReseller('${r.id}')">Remove</button></div></td></tr>`;
  }).join('') : empty(7, 'No resellers yet');
}
window.editReseller = id => {
  const r = resellers.find(x => x.id === id) || {};
  $('rs-title').textContent = id ? 'Manage reseller' : 'Add reseller';
  $('rs-id').value = id; $('rs-name').value = r.name || ''; $('rs-email').value = r.email || '';
  $('rs-bal').value = r.balance || 0; $('rs-add').value = ''; $('rs-active').value = r.active === false ? '0' : '1';
  ['basic', 'pro', 'ultimate'].forEach(p => $('rs-p-' + p).checked = id ? (r.plans || []).includes(p) : p !== 'ultimate');
  const m = toMs(r.panelExpires); $('rs-exp').value = m ? new Date(m).toISOString().slice(0, 10) : '';
  openModal('m-res');
};
window.addResCredits = () => { $('rs-bal').value = (parseInt($('rs-bal').value) || 0) + (parseInt($('rs-add').value) || 0); $('rs-add').value = ''; };
window.saveReseller = async () => {
  const id = $('rs-id').value, exp = $('rs-exp').value;
  const data = { name: $('rs-name').value.trim(), email: $('rs-email').value.trim().toLowerCase(),
    balance: Math.max(0, parseInt($('rs-bal').value) || 0), active: $('rs-active').value === '1',
    plans: ['basic', 'pro', 'ultimate'].filter(p => $('rs-p-' + p).checked),
    panelExpires: exp ? Timestamp.fromDate(new Date(exp + 'T23:59:59')) : 0 };
  if (!data.name || !data.email) return toast('Name and email are required', true);
  if (id) await updateDoc(doc(db, 'resellers', id), data);
  else await setDoc(doc(db, 'resellers', adminId(data.email)), { ...data, keysGenerated: 0, createdAt: serverTimestamp() });
  closeModal('m-res'); toast('Reseller saved'); log(id ? 'Reseller updated' : 'Reseller added', `${data.email} · ${data.balance} credits`);
  resellers = await all('resellers'); renderResellers();
};
window.delReseller = id => {
  const r = resellers.find(x => x.id === id);
  confirmBox(`Remove ${r.name}? Keys they already sold keep working.`, async () => {
    await deleteDoc(doc(db, 'resellers', id)); resellers = resellers.filter(x => x.id !== id);
    log('Reseller removed', r.email); renderResellers();
  });
};

// ---------- Applications ----------
function renderApps() {
  const q = $('a-q').value.toLowerCase();
  const owner = uid => users.find(u => u.id === uid);
  const list = apps.filter(a => !q || [a.name, owner(a.ownerUid)?.email].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
  $('a-body').innerHTML = list.length ? list.map(a => { const o = owner(a.ownerUid); return `<tr>
    <td><div class="u-cell"><div class="av">${esc(initials(a.name))}</div><div><div class="u-name">${esc(a.name)}</div><div class="u-sub">${esc(a.id)}</div></div></div></td>
    <td>${esc(o?.email || a.ownerUid)}</td><td><span class="tag t-${o?.plan || 'free'}">${PLAN_LABEL[o?.plan] || 'Free'}</span></td>
    <td class="muted">${esc(a.version || '—')}</td><td class="muted">${fmtDate(a.createdAt)}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="delApp('${a.id}')">Delete</button></div></td></tr>`; }).join('')
    : empty(6, 'No applications yet');
}
window.renderApps = renderApps;
window.delApp = id => {
  const a = apps.find(x => x.id === id);
  confirmBox(`Delete "${a.name}"? Every license for it stops working.`, async () => {
    await deleteDoc(doc(db, 'apps', id)); apps = apps.filter(x => x.id !== id); log('Application deleted', a.name); renderApps();
  });
};

// ---------- Sessions ----------
let sessions = [];
async function loadSessions() {
  try { sessions = (await getDocs(collectionGroup(db, 'sessions'))).docs.map(d => ({ id: d.id, path: d.ref.path, appId: d.ref.parent.parent?.id, ...d.data() })); }
  catch (e) { sessions = []; console.warn('sessions', e.message); }
  const live = s => now() - (toMs(s.lastSeen) || 0) < 60000;
  $('s-live').textContent = sessions.filter(live).length;
  $('s-stale').textContent = sessions.filter(s => !live(s)).length;
  $('s-apps').textContent = new Set(sessions.filter(live).map(s => s.appId)).size;
  $('s-dev').textContent = new Set(sessions.map(s => s.hwid).filter(Boolean)).size;
  const appName = id => apps.find(a => a.id === id)?.name || id;
  $('s-body').innerHTML = sessions.length ? sessions.sort((a, b) => (toMs(b.lastSeen) || 0) - (toMs(a.lastSeen) || 0)).map(s => `<tr>
    <td><div class="u-cell"><div class="av">${esc(initials(s.username))}</div><span class="u-name">${esc(s.username || 'unknown')}</span></div></td>
    <td class="muted">${esc(appName(s.appId))}</td><td class="mono muted">${esc(s.ip || '—')}</td>
    <td class="mono dimc">${s.hwid ? esc(s.hwid.slice(0, 20)) + '…' : '—'}</td>
    <td>${live(s) ? '<span class="dot"></span>' : '<span class="dot idle"></span>'}${ago(s.lastSeen)}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="killSession('${esc(s.path)}')">End</button></div></td></tr>`).join('')
    : empty(6, 'No sessions. They appear once customer software connects through the SDK.');
}
window.killSession = async path => { await deleteDoc(doc(db, path)); toast('Session ended'); log('Session ended', path.split('/')[1]); loadSessions(); };

// ---------- HWID ----------
function renderHwid() {
  const list = [...hwids].sort((a, b) => (a.status === 'done') - (b.status === 'done') || (toMs(b.requestedAt) || 0) - (toMs(a.requestedAt) || 0));
  $('h-body').innerHTML = list.length ? list.map(r => {
    const uid = r.uid || r.userId; const u = users.find(x => x.id === uid);
    return `<tr><td><div class="u-name">${esc(r.username || u?.username || '—')}</div><div class="u-sub">${esc(r.email || u?.email || uid)}</div></td>
      <td class="mono dimc">${esc(u?.hwid || r.oldHwid || '—')}</td><td class="muted">${ago(r.requestedAt)}</td>
      <td>${r.status === 'done' ? '<span class="tag t-live">Approved</span>' : r.status === 'denied' ? '<span class="tag t-bad">Denied</span>' : '<span class="tag t-warn">Pending</span>'}</td>
      <td><div class="acts">${r.status === 'pending' || !r.status ? `<button class="btn btn-sm btn-w" onclick="approveHwid('${r.id}')">Approve</button><button class="btn btn-sm" onclick="denyHwid('${r.id}')">Deny</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="delHwid('${r.id}')">Delete</button></div></td></tr>`;
  }).join('') : empty(5, 'No requests');
}
window.approveHwid = async id => {
  const r = hwids.find(x => x.id === id), uid = r.uid || r.userId;
  if (uid) await updateDoc(doc(db, 'users', uid), { hwid: null }).catch(() => {});
  await updateDoc(doc(db, 'hwid_resets', id), { status: 'done', handledBy: auth.currentUser.email, handledAt: serverTimestamp() });
  r.status = 'done'; toast('HWID reset'); log('HWID reset approved', r.email || uid); renderHwid(); renderNav();
};
window.denyHwid = async id => {
  const r = hwids.find(x => x.id === id);
  await updateDoc(doc(db, 'hwid_resets', id), { status: 'denied', handledBy: auth.currentUser.email, handledAt: serverTimestamp() });
  r.status = 'denied'; log('HWID reset denied', r.email || ''); renderHwid(); renderNav();
};
window.delHwid = async id => { await deleteDoc(doc(db, 'hwid_resets', id)); hwids = hwids.filter(x => x.id !== id); renderHwid(); renderNav(); };

// ---------- Activity ----------
function renderActivity() {
  $('l-body').innerHTML = activity.length ? activity.map(a => `<tr><td class="u-name">${esc(a.action)}</td><td class="muted">${esc(a.details)}</td><td class="muted">${esc(a.admin)}</td><td class="muted">${ago(a.at)}</td></tr>`).join('') : empty(4, 'Nothing logged yet');
}

// ---------- Settings ----------
async function renderSettings() {
  ['basic', 'pro', 'ultimate'].forEach(p => { $('p-' + p).value = settings[p] || ''; $('c-' + p).value = settings.credits?.[p] ?? { basic: 1, pro: 2, ultimate: 4 }[p]; });
  $('s-announce').value = settings.announcement || ''; $('s-maint').value = settings.maintenance ? '1' : '0';
  const admins = await all('admins');
  $('adm-list').innerHTML = admins.map(a => `<div class="kv"><span>${esc(a.email)}</span>${a.email === auth.currentUser.email ? '<span class="dimc">You</span>' : `<button class="btn btn-sm btn-danger" onclick="removeAdmin('${a.id}')">Remove</button>`}</div>`).join('');
}
window.saveSettings = async () => {
  const plans = { basic: $('p-basic').value.trim(), pro: $('p-pro').value.trim(), ultimate: $('p-ultimate').value.trim() };
  const credits = { basic: +$('c-basic').value || 0, pro: +$('c-pro').value || 0, ultimate: +$('c-ultimate').value || 0 };
  await setDoc(doc(db, 'settings', 'plans'), plans);
  await setDoc(doc(db, 'settings', 'site'), { credits, announcement: $('s-announce').value.trim(), maintenance: $('s-maint').value === '1' });
  Object.assign(settings, plans, { credits, announcement: $('s-announce').value.trim(), maintenance: $('s-maint').value === '1' });
  toast('Settings saved'); log('Settings updated');
};
window.addAdmin = async () => {
  const email = $('adm-email').value.trim().toLowerCase();
  if (!email.includes('@')) return toast('Enter an email', true);
  await setDoc(doc(db, 'admins', adminId(email)), { email, addedBy: auth.currentUser.email, addedAt: serverTimestamp() });
  $('adm-email').value = ''; toast('Admin added'); log('Admin added', email); renderSettings();
};
window.removeAdmin = id => confirmBox('Remove this admin?', async () => { await deleteDoc(doc(db, 'admins', id)); log('Admin removed', id); renderSettings(); });

async function purge(name, filter, label) {
  const docs = (await getDocs(collection(db, name))).docs.filter(d => filter(d.data()));
  for (let i = 0; i < docs.length; i += 400) { const b = writeBatch(db); docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
  toast(`${docs.length} removed`); log(label, `${docs.length} removed`); refresh();
}
window.purgeUnusedKeys = () => confirmBox('Delete every unused subscription key?', () => purge('licenseKeys', k => !k.assigned, 'Unused keys purged'));
window.purgeHwid = () => confirmBox('Delete all approved and denied HWID requests?', () => purge('hwid_resets', r => r.status === 'done' || r.status === 'denied', 'HWID requests cleared'));
window.purgeActivity = () => confirmBox('Clear the whole activity log?', () => purge('activity', () => true, 'Activity log cleared'));

// ---------- Strive products ----------
const DURS = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Lifetime']];
const DEFAULT_COSTS = { 1: 1, 7: 3, 30: 8, 90: 20, 0: 50 };
const SEED = [['Fortnite Private', 'FNP'], ['Fortnite Slotted', 'FNS'], ['Fortnite AI', 'FNA'], ['Temp Spoofer', 'TSP'], ['Perm Spoofer', 'PSP'],
  ['R6 Private', 'R6P'], ['Rust', 'RST'], ['Retrac', 'RTC'], ['Roblox', 'RBX']];
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const durShort = d => d === 0 ? 'Life' : d + 'd';
const costText = c => DURS.filter(([d]) => c?.[d] > 0).map(([d]) => `${durShort(d)} ${c[d]}`).join(' · ') || 'No prices set';

async function makeProductApp(name) {
  const ref = await addDoc(collection(db, 'apps'), {
    ownerUid: auth.currentUser.uid, name, version: '1.0.0', secret: randHex(24), sellerKey: randHex(16), hwidLock: true, createdAt: serverTimestamp(),
  });
  return ref.id;
}

function renderProducts() {
  const counts = {}; panels.forEach(p => counts[p.productId] = (counts[p.productId] || 0) + 1);
  const list = [...products].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || (a.name || '').localeCompare(b.name || ''));
  $('pr-seed').style.display = list.length ? 'none' : '';
  $('pr-body').innerHTML = list.length ? list.map(p => `<tr>
    <td><div class="u-name">${esc(p.name)}</div><div class="u-sub">${esc(p.prefix || '')}-XXXX-XXXX-XXXX</div></td>
    <td class="muted">${esc(costText(p.costs))}</td>
    <td>${counts[p.id] || 0}</td>
    <td>${p.appId ? '<span class="tag t-live">Ready</span>' : '<span class="tag t-warn">No app</span>'}</td>
    <td>${p.active === false ? '<span class="tag t-off">Off</span>' : '<span class="tag t-live">On</span>'}</td>
    <td><div class="acts"><button class="btn btn-sm" onclick="openProduct('${p.id}')">Edit</button>
      <button class="btn btn-sm btn-danger" onclick="delProduct('${p.id}')">Delete</button></div></td></tr>`).join('')
    : empty(6, 'No products yet. Click “Add the Strive products” above.');
}

window.seedProducts = async () => {
  const btn = $('pr-seed-btn'); btn.disabled = true;
  try {
    let made = 0;
    for (const [i, [name, prefix]] of SEED.entries()) {
      const id = slugify(name);
      if (products.some(p => p.id === id)) continue;
      const appId = await makeProductApp(name);
      await setDoc(doc(db, 'products', id), { name, prefix, active: true, appId, costs: { ...DEFAULT_COSTS }, order: i, createdAt: serverTimestamp() });
      made++;
    }
    products = await all('products'); apps = await all('apps');
    toast(`${made} products added`); log('Products added', `${made} Strive products`); renderProducts();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
};

window.openProduct = id => {
  const p = products.find(x => x.id === id) || { active: true, costs: { ...DEFAULT_COSTS } };
  $('pd-id').value = id || ''; $('pd-title').textContent = id ? 'Edit product' : 'Add product';
  $('pd-name').value = p.name || ''; $('pd-prefix').value = p.prefix || ''; $('pd-active').value = p.active === false ? '0' : '1';
  DURS.forEach(([d]) => { $('pd-c-' + d).value = p.costs?.[d] > 0 ? p.costs[d] : ''; });
  $('pd-note').textContent = id ? (p.appId ? 'Linked to an application in your portal. Open sovyx.cc/portal to upload the download and set up its customer page.' : 'This product has no application yet, so panels can’t make keys for it.') : 'An application is created for it automatically.';
  openModal('m-product');
};

window.saveProduct = async () => {
  const id = $('pd-id').value, name = $('pd-name').value.trim();
  const prefix = $('pd-prefix').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!name) return toast('Give the product a name', true);
  if (prefix.length < 2) return toast('Key prefix needs 2–8 letters or numbers', true);
  const costs = {};
  for (const [d] of DURS) { const v = parseInt($('pd-c-' + d).value); if (v > 0) costs[d] = v; }
  if (!Object.keys(costs).length) return toast('Set a credit price for at least one duration', true);
  const data = { name, prefix, active: $('pd-active').value === '1', costs };
  try {
    if (id) await updateDoc(doc(db, 'products', id), data);
    else {
      const newId = slugify(name);
      if (products.some(p => p.id === newId)) return toast('A product with that name already exists', true);
      const appId = await makeProductApp(name);
      await setDoc(doc(db, 'products', newId), { ...data, appId, order: products.length, createdAt: serverTimestamp() });
    }
    closeModal('m-product'); toast('Product saved'); log('Product saved', name);
    [products, apps] = await Promise.all([all('products'), all('apps')]); renderProducts();
  } catch (e) { toast(e.message, true); }
};

window.delProduct = id => {
  const p = products.find(x => x.id === id), n = panels.filter(x => x.productId === id).length;
  if (n) return toast(`${n} panel(s) use ${p.name}. Remove them first, or switch the product off.`, true);
  confirmBox(`Delete ${p.name}? Its application and keys stay in your portal.`, async () => {
    await deleteDoc(doc(db, 'products', id)); products = products.filter(x => x.id !== id);
    log('Product deleted', p.name); renderProducts();
  });
};

// ---------- Panel access ----------
let acFilter = '';
const userOf = uid => users.find(u => u.id === uid);
const panelState = g => g.status === 'suspended' ? ['Suspended', 't-warn'] : (toMs(g.expiresAt) && toMs(g.expiresAt) < now()) ? ['Expired', 't-bad'] : ['Active', 't-live'];

function accessTags(g) {
  const t = [];
  if (g.canGenerate !== false) t.push('<span class="tag t-pro">Keys</span>');
  if (g.canManage) t.push('<span class="tag t-basic">Manage</span>');
  if (g.canSessions) t.push('<span class="tag t-basic">Sessions</span>');
  if (g.canActivity) t.push('<span class="tag t-basic">Log</span>');
  if (g.canManage && g.keyScope === 'all') t.push('<span class="tag t-ultimate">All keys</span>');
  if (!t.length) t.push('<span class="tag t-off">Access only</span>');
  if (g.canDownload === false) t.push('<span class="tag t-warn">No download</span>');
  return `<div style="display:flex;gap:4px;flex-wrap:wrap">${t.join('')}</div>`;
}

function renderAccess() {
  const sel = $('ac-prod'), keep = sel.value;
  sel.innerHTML = '<option value="">All products</option>' + [...products].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = products.some(p => p.id === keep) ? keep : '';
  const q = $('ac-q').value.toLowerCase();
  const list = panels.filter(g => !sel.value || g.productId === sel.value)
    .filter(g => !acFilter || panelState(g)[0].toLowerCase() === acFilter)
    .filter(g => !q || [g.email, g.username, g.productName].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.email || '').localeCompare(b.email || '') || (a.productName || '').localeCompare(b.productName || ''));
  const active = panels.filter(g => panelState(g)[0] === 'Active');
  $('ac-active').textContent = active.length;
  $('ac-people').textContent = `${new Set(panels.map(g => g.uid)).size} people`;
  $('ac-credits').textContent = panels.reduce((s, g) => s + (g.credits || 0), 0);
  $('ac-keys').textContent = panels.reduce((s, g) => s + (g.keysMade || 0), 0);
  $('ac-soon').textContent = active.filter(g => { const m = toMs(g.expiresAt); return m && m - now() < 7 * 86400000; }).length;
  $('ac-body').innerHTML = list.length ? list.map(g => {
    const [label, cls] = panelState(g), u = userOf(g.uid);
    return `<tr>
      <td><div class="u-cell"><div class="av">${esc(initials(g.username || g.email))}</div><div><div class="u-name">${esc(g.username || g.email)}</div><div class="u-sub">${esc(g.email || '')}</div></div></div>${u?.portalMode === 'products' ? '<span class="tag t-off" style="margin-top:6px">Products-only portal</span>' : ''}</td>
      <td>${esc(g.productName || g.productId)}</td>
      <td>${accessTags(g)}</td>
      <td>${g.canGenerate !== false ? (g.credits || 0) : '<span class="dimc">—</span>'}</td><td class="muted">${g.keysMade || 0}</td>
      <td class="muted">${g.expiresAt === 0 || g.expiresAt == null ? 'Never' : fmtDate(g.expiresAt)}</td>
      <td><span class="tag ${cls}">${label}</span></td>
      <td><div class="acts"><button class="btn btn-sm" onclick="editPanel('${g.id}')">Manage</button>
        <button class="btn btn-sm btn-danger" onclick="delPanel('${g.id}')">Remove</button></div></td></tr>`;
  }).join('') : empty(8, panels.length ? 'No panels match' : 'Nobody has a panel yet. Click “Give access”.');
}
window.renderAccess = renderAccess;
$('ac-seg').addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') return; acFilter = e.target.dataset.f; $('ac-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); renderAccess(); });

window.openGrant = () => {
  if (!products.length) return toast('Add your products first', true);
  $('ga-people').innerHTML = users.map(u => `<option value="${esc(u.email)}">${esc(u.username || '')}</option>`).join('');
  $('ga-person').value = '';
  $('ga-products').innerHTML = [...products].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map(p =>
    `<label class="chk"><input type="checkbox" value="${p.id}"${p.active === false ? ' disabled' : ''}/>${esc(p.name)}${p.active === false ? ' <span class="dimc">(off)</span>' : ''}</label>`).join('');
  $('ga-all').checked = false;
  $('ga-gen').checked = true; $('ga-dl').checked = true; $('ga-manage').checked = false; $('ga-sess').checked = false; $('ga-act').checked = false; $('ga-scope').value = 'own'; $('ga-credits').value = 0; $('ga-dur').value = '30'; $('ga-date').style.display = 'none'; $('ga-date').value = '';
  $('ga-portal').value = 'keep'; $('ga-note').value = '';
  openModal('m-grant');
};
window.toggleAllProducts = on => document.querySelectorAll('#ga-products input:not(:disabled)').forEach(i => { i.checked = on; });
window.grantPreset = kind => {
  const P = {
    reseller: { gen: 1, manage: 1, sess: 0, act: 0, scope: 'own', portal: 'keep' },
    access:   { gen: 0, manage: 0, sess: 0, act: 0, scope: 'own', portal: 'products' },
    staff:    { gen: 1, manage: 1, sess: 1, act: 1, scope: 'all', portal: 'products' },
  }[kind];
  $('ga-gen').checked = !!P.gen; $('ga-dl').checked = true; $('ga-manage').checked = !!P.manage;
  $('ga-sess').checked = !!P.sess; $('ga-act').checked = !!P.act; $('ga-scope').value = P.scope; $('ga-portal').value = P.portal;
  if (!P.gen) $('ga-credits').value = 0;
};
$('ga-dur').addEventListener('change', () => { $('ga-date').style.display = $('ga-dur').value === 'custom' ? '' : 'none'; });

function expiryFrom(sel, dateStr) {
  if (sel === '0') return 0;
  if (sel === 'custom') return dateStr ? Timestamp.fromDate(new Date(dateStr + 'T23:59:59')) : null;
  return Timestamp.fromMillis(now() + parseInt(sel) * 86400000);
}

window.saveGrant = async () => {
  const person = $('ga-person').value.trim().toLowerCase();
  const u = users.find(x => (x.email || '').toLowerCase() === person) || users.find(x => (x.username || '').toLowerCase() === person);
  if (!u) return toast('Pick someone from the list. They need a Sovyx account first.', true);
  const picks = [...document.querySelectorAll('#ga-products input:checked')].map(i => i.value);
  if (!picks.length) return toast('Choose at least one product', true);
  const expiresAt = expiryFrom($('ga-dur').value, $('ga-date').value);
  if (expiresAt === null) return toast('Pick the end date', true);
  const canGenerate = $('ga-gen').checked, canDownload = $('ga-dl').checked;
  const perms = { canManage: $('ga-manage').checked, canSessions: $('ga-sess').checked, canActivity: $('ga-act').checked, keyScope: $('ga-scope').value };
  const credits = Math.max(0, parseInt($('ga-credits').value) || 0);
  const btn = $('ga-save'); btn.disabled = true;
  try {
    let added = 0, updated = 0;
    for (const productId of picks) {
      const prod = products.find(p => p.id === productId), gid = `${u.id}_${productId}`, old = panels.find(g => g.id === gid);
      await setDoc(doc(db, 'panelAccess', gid), {
        uid: u.id, email: u.email, username: u.username || '', productId, productName: prod.name, canGenerate, canDownload, ...perms,
        credits: (old?.credits || 0) + (canGenerate ? credits : 0), expiresAt, status: 'active', note: $('ga-note').value.trim(),
        keysMade: old?.keysMade || 0, createdAt: old?.createdAt || serverTimestamp(), createdBy: auth.currentUser.email,
      });
      old ? updated++ : added++;
    }
    const mode = $('ga-portal').value;
    if (mode !== 'keep') await updateDoc(doc(db, 'users', u.id), { portalMode: mode });
    closeModal('m-grant');
    toast(`${added ? added + ' panel(s) given' : ''}${added && updated ? ', ' : ''}${updated ? updated + ' updated' : ''}`);
    log('Panel access given', `${u.email}: ${picks.length} product(s)${canGenerate ? `, ${credits} credits` : ', access only'}`);
    [panels, users] = await Promise.all([all('panelAccess'), all('users')]); renderAccess();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
};

window.editPanel = id => {
  const g = panels.find(x => x.id === id), m = toMs(g.expiresAt);
  $('ep-id').value = id; $('ep-who').textContent = `${g.username || g.email} · ${g.productName}`;
  $('ep-credits').value = g.credits || 0; $('ep-add').value = '';
  $('ep-exp').value = m ? new Date(m).toISOString().slice(0, 10) : '';
  $('ep-gen').checked = g.canGenerate !== false; $('ep-dl').checked = g.canDownload !== false;
  $('ep-manage').checked = !!g.canManage; $('ep-sess').checked = !!g.canSessions; $('ep-act').checked = !!g.canActivity; $('ep-scope').value = g.keyScope === 'all' ? 'all' : 'own';
  $('ep-status').value = g.status === 'suspended' ? 'suspended' : 'active'; $('ep-note').value = g.note || '';
  openModal('m-panel');
};
window.epAddCredits = () => { $('ep-credits').value = (parseInt($('ep-credits').value) || 0) + (parseInt($('ep-add').value) || 0); $('ep-add').value = ''; };
window.epExtend = days => { const cur = $('ep-exp').value ? new Date($('ep-exp').value).getTime() : 0; $('ep-exp').value = new Date(Math.max(cur, now()) + days * 86400000).toISOString().slice(0, 10); };
window.savePanel = async () => {
  const id = $('ep-id').value, g = panels.find(x => x.id === id), exp = $('ep-exp').value;
  const data = { credits: Math.max(0, parseInt($('ep-credits').value) || 0), canGenerate: $('ep-gen').checked, canDownload: $('ep-dl').checked,
    canManage: $('ep-manage').checked, canSessions: $('ep-sess').checked, canActivity: $('ep-act').checked, keyScope: $('ep-scope').value,
    status: $('ep-status').value, note: $('ep-note').value.trim(), expiresAt: exp ? Timestamp.fromDate(new Date(exp + 'T23:59:59')) : 0 };
  await updateDoc(doc(db, 'panelAccess', id), data);
  Object.assign(g, data); closeModal('m-panel'); toast('Panel saved');
  log('Panel updated', `${g.email} · ${g.productName} · ${data.credits} credits`); renderAccess();
};
window.delPanel = id => {
  const g = panels.find(x => x.id === id);
  confirmBox(`Remove ${g.email}'s panel for ${g.productName}? Keys they already made keep working.`, async () => {
    await deleteDoc(doc(db, 'panelAccess', id)); panels = panels.filter(x => x.id !== id);
    log('Panel removed', `${g.email} · ${g.productName}`); renderAccess();
  });
};
