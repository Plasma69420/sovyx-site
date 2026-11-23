import { auth, db, PLAN_LABEL, esc, $, toMs, fmtDate, ago, initials, randBlock, toast, openModal, closeModal, confirmBox, copy } from '/assets/fb.js';
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
  { sec: 'Platform' },
  { id: 'apps', label: 'Applications', icon: 'box' },
  { id: 'sessions', label: 'Live sessions', icon: 'pulse' },
  { id: 'hwid', label: 'HWID resets', icon: 'cpu', badge: 'hwid' },
  { sec: 'System' },
  { id: 'activity', label: 'Activity log', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

let users = [], keys = [], resellers = [], apps = [], hwids = [], activity = [], settings = {};
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
  ({ dash: renderDash, users: renderUsers, keys: renderKeys, resellers: renderResellers, apps: renderApps, sessions: loadSessions, hwid: renderHwid, activity: renderActivity, settings: renderSettings })[n.id]?.();
}
window.go = go;

const all = async (name, ...q) => {
  try { return (await getDocs(q.length ? query(collection(db, name), ...q) : collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { console.warn(name, e.message); return []; }
};
async function refresh() {
  [users, keys, resellers, apps, hwids, activity] = await Promise.all([
    all('users'), all('licenseKeys'), all('resellers'), all('apps'),
    all('hwid_resets'), all('activity', orderBy('at', 'desc'), limit(200)),
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
  $('eu-credits').value = u.credits || 0; $('eu-note').value = u.adminNote || '';
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
    expiresAt: exp ? Timestamp.fromDate(new Date(exp + 'T23:59:59')) : 0, adminNote: $('eu-note').value.trim() };
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
