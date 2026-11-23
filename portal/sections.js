import { db, PLAN_LABEL, esc, $, toMs, fmtDate, ago, initials, randBlock, randHex, toast, closeModal, openModal, confirmBox, copy } from '/assets/fb.js';
import { collection, doc, getDocs, addDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, serverTimestamp, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { S, LIMITS, loaders } from './state.js';

const col = name => collection(db, 'apps', S.app.id, name);
const ref = (name, id) => doc(db, 'apps', S.app.id, name, id);
const fetchAll = async name => (await getDocs(col(name))).docs.map(d => ({ id: d.id, ...d.data() }));
const durLabel = d => d === 0 ? 'Lifetime' : d === 1 ? '1 day' : d % 365 === 0 ? (d / 365) + 'y' : d + ' days';
const expiry = days => days === 0 ? 0 : Timestamp.fromMillis(Date.now() + days * 86400000);
const empty = (n, t) => `<tr><td colspan="${n}" class="empty">${t}</td></tr>`;

// ---------- Licenses ----------
let licenses = [], licFilter = '';
loaders.licenses = async () => { licenses = await fetchAll('licenses'); renderLicenses(); };
$('lic-seg').addEventListener('click', e => {
  if (!e.target.dataset || e.target.tagName !== 'BUTTON') return;
  licFilter = e.target.dataset.f;
  $('lic-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target));
  renderLicenses();
});

function renderLicenses() {
  const q = $('lic-q').value.toLowerCase();
  const list = licenses
    .filter(l => !licFilter || l.status === licFilter)
    .filter(l => !q || [l.key, l.usedBy, l.note].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
  const tag = { unused: 't-off', used: 't-live', banned: 't-bad' };
  $('lic-body').innerHTML = list.length ? list.map(l => `<tr>
    <td><span class="mono">${esc(l.key)}</span>${l.note ? `<div class="u-sub">${esc(l.note)}</div>` : ''}</td>
    <td class="muted">${durLabel(l.days)}</td>
    <td>${l.usedBy ? esc(l.usedBy) : '<span class="dimc">—</span>'}</td>
    <td class="mono dimc">${l.hwid ? esc(l.hwid.slice(0, 18)) + '…' : '—'}</td>
    <td><span class="tag ${tag[l.status] || 't-off'}">${esc(l.status || 'unused')}</span></td>
    <td class="muted">${fmtDate(l.createdAt)}</td>
    <td><div class="acts">
      <button class="btn btn-sm" onclick="copy('${esc(l.key)}')">Copy</button>
      ${l.hwid ? `<button class="btn btn-sm" onclick="resetLicHwid('${l.id}')">Reset HWID</button>` : ''}
      <button class="btn btn-sm" onclick="toggleLicBan('${l.id}')">${l.status === 'banned' ? 'Unban' : 'Ban'}</button>
      <button class="btn btn-sm btn-danger" onclick="delLicense('${l.id}')">Delete</button></div></td></tr>`).join('')
    : empty(7, licenses.length ? 'No licenses match' : 'No licenses yet — create some above');
}
window.renderLicenses = renderLicenses;

let lastGenerated = [];
window.genLicenses = async () => {
  const qty = Math.max(1, Math.min(100, parseInt($('gl-qty').value) || 1));
  const days = parseInt($('gl-days').value);
  const lim = LIMITS[S.plan].licenses;
  if (licenses.length + qty > lim) return toast(`Your ${PLAN_LABEL[S.plan]} plan allows ${lim} licenses per application.`, true);
  const prefix = ($('gl-prefix').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SVX').slice(0, 10);
  const note = $('gl-note').value.trim();
  const btn = $('gl-btn'); btn.disabled = true;
  const batch = writeBatch(db);
  lastGenerated = [];
  for (let i = 0; i < qty; i++) {
    const key = `${prefix}-${randBlock()}-${randBlock()}-${randBlock()}`;
    lastGenerated.push(key);
    batch.set(doc(col('licenses')), { key, days, note, status: 'unused', usedBy: null, hwid: null, createdAt: serverTimestamp() });
  }
  try {
    await batch.commit();
    $('gl-list').value = lastGenerated.join('\n');
    $('gl-label').textContent = `${qty} license${qty > 1 ? 's' : ''} created`;
    $('gl-out').style.display = '';
    toast(`${qty} license(s) created`);
    loaders.licenses();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
};
window.copyGenerated = () => copy(lastGenerated.join('\n'));

window.exportLicenses = () => {
  const rows = [['key', 'duration_days', 'status', 'used_by', 'hwid', 'note']]
    .concat(licenses.map(l => [l.key, l.days, l.status, l.usedBy || '', l.hwid || '', l.note || '']));
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${S.app.name.replace(/\W+/g, '_')}_licenses.csv`;
  a.click();
};

window.resetLicHwid = async id => { await updateDoc(ref('licenses', id), { hwid: null }); toast('HWID reset'); loaders.licenses(); };
window.toggleLicBan = async id => {
  const l = licenses.find(x => x.id === id);
  await updateDoc(ref('licenses', id), { status: l.status === 'banned' ? (l.usedBy ? 'used' : 'unused') : 'banned' });
  loaders.licenses();
};
window.delLicense = id => confirmBox('Delete this license? Anyone using it loses access.', async () => {
  await deleteDoc(ref('licenses', id)); toast('License deleted'); loaders.licenses();
});

// ---------- Users ----------
let appUsers = [];
loaders.users = async () => { appUsers = await fetchAll('appUsers'); renderUsers(); };
function renderUsers() {
  const q = $('usr-q').value.toLowerCase();
  const now = Date.now();
  const list = appUsers.filter(u => !q || [u.username, u.hwid].some(v => (v || '').toLowerCase().includes(q)));
  $('usr-body').innerHTML = list.length ? list.map(u => {
    const exp = toMs(u.expiresAt);
    const st = u.banned ? '<span class="tag t-bad">Banned</span>' : exp && exp < now ? '<span class="tag t-warn">Expired</span>' : '<span class="tag t-live">Active</span>';
    return `<tr>
      <td><div class="u-cell"><div class="av">${esc(initials(u.username))}</div><div><div class="u-name">${esc(u.username)}</div><div class="u-sub">${esc(u.id.slice(0, 8))}</div></div></div></td>
      <td class="mono dimc">${u.hwid ? esc(u.hwid.slice(0, 20)) + '…' : '—'}</td>
      <td class="muted">${fmtDate(u.expiresAt)}</td>
      <td class="muted">${ago(u.lastLogin)}</td>
      <td>${st}</td>
      <td><div class="acts">
        <button class="btn btn-sm" onclick="openExtend('appUsers','${u.id}')">Extend</button>
        ${u.hwid ? `<button class="btn btn-sm" onclick="resetUserHwid('${u.id}')">Reset HWID</button>` : ''}
        <button class="btn btn-sm" onclick="toggleUserBan('${u.id}')">${u.banned ? 'Unban' : 'Ban'}</button>
        <button class="btn btn-sm btn-danger" onclick="delAppUser('${u.id}')">Delete</button></div></td></tr>`;
  }).join('') : empty(6, appUsers.length ? 'No users match' : 'No users yet — they appear when a license is redeemed');
}
window.renderUsers = renderUsers;

window.createAppUser = async () => {
  const username = $('nu-name').value.trim();
  if (!username) return toast('Enter a username', true);
  await addDoc(col('appUsers'), { username, hwid: null, banned: false, expiresAt: expiry(parseInt($('nu-days').value)), lastLogin: null, createdAt: serverTimestamp() });
  $('nu-name').value = ''; closeModal('m-newuser'); toast('User created'); loaders.users();
};
window.resetUserHwid = async id => { await updateDoc(ref('appUsers', id), { hwid: null }); toast('HWID reset'); loaders.users(); };
window.toggleUserBan = async id => {
  const u = appUsers.find(x => x.id === id);
  await updateDoc(ref('appUsers', id), { banned: !u.banned }); toast(u.banned ? 'User unbanned' : 'User banned'); loaders.users();
};
window.delAppUser = id => confirmBox('Delete this user?', async () => { await deleteDoc(ref('appUsers', id)); toast('User deleted'); loaders.users(); });

window.openExtend = (kind, id) => { $('ex-kind').value = kind; $('ex-id').value = id; openModal('m-extend'); };
window.doExtend = async () => {
  const kind = $('ex-kind').value, id = $('ex-id').value, days = parseInt($('ex-days').value) || 0;
  const u = appUsers.find(x => x.id === id);
  const cur = toMs(u?.expiresAt);
  if (cur === 0) { closeModal('m-extend'); return toast('Already lifetime'); }
  const base = Math.max(Date.now(), cur || 0);
  await updateDoc(ref(kind, id), { expiresAt: Timestamp.fromMillis(base + days * 86400000) });
  closeModal('m-extend'); toast(`Extended by ${days} days`); loaders.users();
};

// ---------- Sessions (live) ----------
let sessions = [], unsubSessions = null, sessTimer = null;
loaders.sessions = () => {
  if (unsubSessions) unsubSessions();
  const appId = S.app.id;
  unsubSessions = onSnapshot(col('sessions'), snap => {
    if (S.app?.id !== appId) return;
    sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSessions();
  }, () => { sessions = []; renderSessions(); });
  clearInterval(sessTimer);
  sessTimer = setInterval(() => { if (S.view === 'sessions') renderSessions(); else { clearInterval(sessTimer); unsubSessions?.(); unsubSessions = null; } }, 5000);
};
function renderSessions() {
  const now = Date.now(), midnight = new Date().setHours(0, 0, 0, 0);
  const isLive = s => now - (toMs(s.lastSeen) || 0) < 60000;
  const live = sessions.filter(isLive);
  $('ss-live').textContent = live.length;
  $('ss-stale').textContent = sessions.length - live.length;
  $('ss-today').textContent = sessions.filter(s => (toMs(s.startedAt) || 0) >= midnight).length;
  $('ss-devices').textContent = new Set(sessions.map(s => s.hwid).filter(Boolean)).size;
  $('ss-count').textContent = sessions.length;
  const q = $('ss-q').value.toLowerCase();
  const list = sessions.filter(s => !q || [s.username, s.ip, s.hwid, s.key].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (toMs(b.lastSeen) || 0) - (toMs(a.lastSeen) || 0));
  $('ss-body').innerHTML = list.length ? list.map(s => `<tr>
    <td><div class="u-cell"><div class="av">${esc(initials(s.username))}</div><div><div class="u-name">${esc(s.username || 'unknown')}</div><div class="u-sub">${esc(s.id.slice(0, 8))}</div></div></div></td>
    <td class="mono muted">${esc(s.ip || '—')}</td>
    <td class="mono dimc">${s.hwid ? esc(s.hwid.slice(0, 22)) + '…' : '—'}</td>
    <td class="muted">${ago(s.lastSeen)}</td>
    <td>${isLive(s) ? '<span class="dot"></span>Live' : '<span class="dot idle"></span><span class="muted">Stale</span>'}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="endSession('${s.id}')">End</button></div></td></tr>`).join('')
    : empty(6, sessions.length ? 'No sessions match' : 'No connected clients. Sessions appear here once your software calls the Sovyx SDK.');
}
window.renderSessions = renderSessions;
window.endSession = async id => { await deleteDoc(ref('sessions', id)); toast('Session ended'); };
window.endAllSessions = () => confirmBox('End every session for this application? All clients will be signed out.', async () => {
  const batch = writeBatch(db);
  sessions.forEach(s => batch.delete(ref('sessions', s.id)));
  await batch.commit(); toast('All sessions ended');
});

// ---------- Blacklist ----------
loaders.blacklist = async () => {
  const list = await fetchAll('blacklist');
  $('bl-body').innerHTML = list.length ? list.map(b => `<tr>
    <td><span class="tag t-off">${b.type === 'ip' ? 'IP' : 'HWID'}</span></td><td class="mono">${esc(b.value)}</td>
    <td class="muted">${esc(b.reason || '—')}</td><td class="muted">${fmtDate(b.createdAt)}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="delBlacklist('${b.id}')">Remove</button></div></td></tr>`).join('')
    : empty(5, 'Nothing blacklisted');
};
window.addBlacklist = async () => {
  const value = $('bl-val').value.trim();
  if (!value) return toast('Enter a value', true);
  await addDoc(col('blacklist'), { type: $('bl-type').value, value, reason: $('bl-reason').value.trim(), createdAt: serverTimestamp() });
  $('bl-val').value = $('bl-reason').value = ''; closeModal('m-bl'); toast('Added to blacklist'); loaders.blacklist();
};
window.delBlacklist = async id => { await deleteDoc(ref('blacklist', id)); loaders.blacklist(); };

// ---------- API keys ----------
let secretShown = false;
loaders.api = () => {
  secretShown = false;
  $('api-appid').textContent = S.app.id;
  $('api-secret').textContent = '••••••••••••••••';
  $('api-seller').textContent = S.app.sellerKey || '—';
};
window.toggleSecret = () => { secretShown = !secretShown; $('api-secret').textContent = secretShown ? S.app.secret : '••••••••••••••••'; };
window.copySecret = () => copy(S.app.secret);
window.copyEl = id => copy($(id).textContent);
window.rotateSecret = () => confirmBox('Rotate the app secret? Servers using the old one will stop working.', async () => {
  const secret = randHex(24);
  await updateDoc(doc(db, 'apps', S.app.id), { secret }); S.app.secret = secret; loaders.api(); toast('Secret rotated');
});
window.rotateSeller = async () => {
  const sellerKey = randHex(16);
  await updateDoc(doc(db, 'apps', S.app.id), { sellerKey }); S.app.sellerKey = sellerKey; loaders.api(); toast('New seller key generated');
};

// ---------- Webhooks ----------
loaders.webhooks = async () => {
  const list = await fetchAll('webhooks');
  $('hook-body').innerHTML = list.length ? list.map(h => `<tr>
    <td class="mono">${esc(h.url)}</td><td>${(h.events || []).map(e => `<span class="tag t-off" style="margin-right:4px">${esc(e)}</span>`).join('')}</td>
    <td class="muted">${fmtDate(h.createdAt)}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="delHook('${h.id}')">Delete</button></div></td></tr>`).join('')
    : empty(4, 'No webhooks yet');
};
window.addHook = async () => {
  const url = $('hk-url').value.trim();
  if (!/^https:\/\//i.test(url)) return toast('Use an https:// URL', true);
  const events = [...document.querySelectorAll('#m-hook input[type=checkbox]:checked')].map(c => c.value);
  if (!events.length) return toast('Pick at least one event', true);
  await addDoc(col('webhooks'), { url, events, createdAt: serverTimestamp() });
  $('hk-url').value = ''; closeModal('m-hook'); toast('Webhook added'); loaders.webhooks();
};
window.delHook = async id => { await deleteDoc(ref('webhooks', id)); loaders.webhooks(); };

// ---------- Variables ----------
loaders.variables = async () => {
  const list = await fetchAll('variables');
  $('var-body').innerHTML = list.length ? list.map(v => `<tr>
    <td class="mono">${esc(v.name)}</td><td class="muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.value)}</td>
    <td>${v.auth ? '<span class="tag t-live">Yes</span>' : '<span class="tag t-off">No</span>'}</td>
    <td><div class="acts"><button class="btn btn-sm btn-danger" onclick="delVar('${v.id}')">Delete</button></div></td></tr>`).join('')
    : empty(4, 'No variables yet');
};
window.addVar = async () => {
  const name = $('vr-name').value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return toast('Use letters, numbers and underscores', true);
  await addDoc(col('variables'), { name, value: $('vr-val').value, auth: $('vr-auth').value === '1', createdAt: serverTimestamp() });
  $('vr-name').value = $('vr-val').value = ''; closeModal('m-var'); toast('Variable added'); loaders.variables();
};
window.delVar = async id => { await deleteDoc(ref('variables', id)); loaders.variables(); };

// ---------- Discord ----------
loaders.discord = () => {
  const d = S.app.discord || {};
  $('dc-guild').value = d.guildId || ''; $('dc-role').value = d.roleId || ''; $('dc-hook').value = d.logWebhook || '';
  $('dc-redeem').value = d.onRedeem === false ? '0' : '1'; $('dc-hwid').value = d.onHwid === false ? '0' : '1';
};
window.saveDiscord = async () => {
  const hook = $('dc-hook').value.trim();
  if (hook && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)) return toast('That isn’t a Discord webhook URL', true);
  const discord = { guildId: $('dc-guild').value.trim(), roleId: $('dc-role').value.trim(), logWebhook: hook, onRedeem: $('dc-redeem').value === '1', onHwid: $('dc-hwid').value === '1' };
  await updateDoc(doc(db, 'apps', S.app.id), { discord }); S.app.discord = discord; toast('Discord settings saved');
};

// ---------- Resellers ----------
let resellers = [];
loaders.resellers = async () => {
  resellers = await fetchAll('resellers');
  $('res-body').innerHTML = resellers.length ? resellers.map(r => `<tr>
    <td><div class="u-cell"><div class="av">${esc(initials(r.name))}</div><div><div class="u-name">${esc(r.name)}</div><div class="u-sub">${esc(r.email)}</div></div></div></td>
    <td>${r.balance ?? 0}</td><td class="muted">${r.created ?? 0}</td>
    <td>${(r.durations || []).map(d => `<span class="tag t-off" style="margin-right:4px">${durLabel(d)}</span>`).join('')}</td>
    <td>${r.active === false ? '<span class="tag t-warn">Suspended</span>' : '<span class="tag t-live">Active</span>'}</td>
    <td><div class="acts"><button class="btn btn-sm" onclick="editReseller('${r.id}')">Edit</button>
      <button class="btn btn-sm btn-danger" onclick="delReseller('${r.id}')">Remove</button></div></td></tr>`).join('')
    : empty(6, 'No resellers yet');
};
window.editReseller = id => {
  const r = resellers.find(x => x.id === id);
  $('res-title').textContent = id ? 'Edit reseller' : 'Add reseller';
  $('rs-id').value = id || '';
  $('rs-name').value = r?.name || ''; $('rs-email').value = r?.email || '';
  $('rs-bal').value = r?.balance ?? 10; $('rs-active').value = r?.active === false ? '0' : '1';
  $('rs-durs').value = (r?.durations || [1, 7, 30, 365]).join(',');
  openModal('m-res');
};
document.querySelector('[onclick="openModal(\'m-res\')"]')?.setAttribute('onclick', "editReseller('')");
window.saveReseller = async () => {
  const id = $('rs-id').value;
  const data = {
    name: $('rs-name').value.trim(), email: $('rs-email').value.trim().toLowerCase(),
    balance: Math.max(0, parseInt($('rs-bal').value) || 0), active: $('rs-active').value === '1',
    durations: $('rs-durs').value.split(',').map(s => parseInt(s.trim())).filter(n => n >= 0),
  };
  if (!data.name || !data.email) return toast('Name and email are required', true);
  if (id) await updateDoc(ref('resellers', id), data);
  else await addDoc(col('resellers'), { ...data, created: 0, createdAt: serverTimestamp() });
  closeModal('m-res'); toast('Reseller saved'); loaders.resellers();
};
window.delReseller = id => confirmBox('Remove this reseller? Licenses they created keep working.', async () => {
  await deleteDoc(ref('resellers', id)); loaders.resellers();
});
