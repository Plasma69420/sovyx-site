import { auth, db, API_BASE, $, fmtDate, toast, confirmBox } from '/assets/fb.js';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderBrand } from '/b/brand.js?v=2';
import { S, loaders } from './state.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'api', 'app', 'www', 'sovyx', 'login', 'portal', 'support', 'help', 'docs', 'status', 'b', 'test']);
const URL_FIELDS = { 'br-logo': 'Logo URL', 'br-discord': 'Discord invite', 'br-support': 'Support link' };
const MAX_MB = { free: 50 };
let current = null, pendingFile = null;

function formData() {
  return {
    slug: $('br-slug').value.trim().toLowerCase(),
    name: $('br-name').value.trim(),
    tagline: $('br-tagline').value.trim(),
    logoUrl: $('br-logo').value.trim(),
    accent: $('br-accent').value,
    theme: $('br-theme').value,
    buttonText: $('br-button').value.trim(),
    version: $('br-version').value.trim(),
    announcement: $('br-announce').value.trim(),
    discordUrl: $('br-discord').value.trim(),
    supportUrl: $('br-support').value.trim(),
  };
}

function renderLogo() {
  const url = $('br-logo').value.trim();
  const thumb = $('br-logo-thumb');
  thumb.replaceChildren();
  if (/^https:\/\/\S+$/i.test(url)) {
    const img = document.createElement('img');
    img.alt = ''; img.src = url;
    img.onerror = () => { if (img.isConnected) thumb.textContent = '!'; };
    thumb.append(img);
  } else thumb.textContent = ($('br-name').value.trim()[0] || '?').toUpperCase();
  $('br-logo-remove').style.display = url ? '' : 'none';
}

function preview() {
  const d = formData();
  renderBrand($('br-preview'), d, { preview: true });
  $('br-preview-url').textContent = d.slug ? `sovyx.cc/b/${d.slug}` : '';
  renderLogo();
}

const OWN_LOGO = () => `${API_BASE}/api/logo/${S.app.id}`;

async function persistLogo(url) {
  $('br-logo').value = url;
  if (S.app.brandSlug) {
    await updateDoc(doc(db, 'brands', S.app.brandSlug), { logoUrl: url, updatedAt: serverTimestamp() });
    if (current) current.logoUrl = url;
  }
  preview();
}

$('br-logo-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast('Use a PNG, JPG, WEBP or GIF image', true);
  if (file.size > 2 * 1048576) return toast('Logo must be under 2 MB', true);
  const hint = $('br-logo-hint');
  hint.textContent = 'Uploading…';
  try {
    const token = await auth.currentUser.getIdToken();
    const body = new FormData(); body.append('file', file);
    const res = await fetch(`${API_BASE}/api/apps/${S.app.id}/logo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    await persistLogo(API_BASE + data.url);
    toast(S.app.brandSlug ? 'Logo uploaded and live' : 'Logo uploaded. Save your page address to publish it');
  } catch (err) {
    toast(err.message === 'Failed to fetch' ? 'Couldn’t reach the upload server. Try again.' : err.message, true);
  } finally { hint.textContent = 'PNG, JPG, WEBP or GIF, up to 2 MB. Square images look best.'; }
});

window.removeLogo = async () => {
  const url = $('br-logo').value.trim();
  try {
    if (url.startsWith(OWN_LOGO())) {
      const token = await auth.currentUser.getIdToken();
      const res = await fetch(`${API_BASE}/api/apps/${S.app.id}/logo`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Couldn’t remove the logo. Try again.');
    }
    await persistLogo('');
    toast('Logo removed');
  } catch (err) { toast(err.message, true); }
};

function fill(b) {
  $('br-slug').value = b.slug || '';
  $('br-name').value = b.name || S.app.name || '';
  $('br-tagline').value = b.tagline || '';
  $('br-logo').value = b.logoUrl || '';
  $('br-accent').value = b.accent || '#e11d48';
  $('br-accent-hex').value = $('br-accent').value;
  $('br-theme').value = b.theme || 'spotlight';
  $('br-button').value = b.buttonText || '';
  $('br-version').value = b.version || S.app.version || '';
  $('br-announce').value = b.announcement || '';
  $('br-discord').value = b.discordUrl || '';
  $('br-support').value = b.supportUrl || '';
  const open = $('br-open');
  open.style.display = b.slug ? '' : 'none';
  if (b.slug) open.href = `/b/${b.slug}`;
}

function renderLoader() {
  const l = S.app.loader;
  $('ld-current').style.display = l ? '' : 'none';
  $('ld-delete').style.display = l ? '' : 'none';
  if (l) {
    $('ld-name').textContent = l.name;
    $('ld-meta').textContent = `${(l.size / 1048576).toFixed(1)} MB · uploaded ${fmtDate(l.uploadedAt)}`;
  }
  $('ld-limit').textContent = `Buyers download this after entering a valid key. Links work once and expire after 5 minutes. Max ${MAX_MB[S.plan] || 250} MB on your plan.`;
  $('ld-drop-text').textContent = pendingFile ? `${pendingFile.name} · ${(pendingFile.size / 1048576).toFixed(1)} MB` : (l ? 'Choose a new file to replace it' : 'Click to choose a file, or drop it here');
  $('ld-upload').disabled = !pendingFile;
}

loaders.brand = async () => {
  current = null; pendingFile = null;
  if (S.app.brandSlug) {
    const snap = await getDoc(doc(db, 'brands', S.app.brandSlug)).catch(() => null);
    if (snap?.exists()) current = snap.data();
  }
  fill(current || { slug: S.app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) });
  renderLoader();
  preview();
};

let t;
document.querySelectorAll('#v-brand input:not([type=file]), #v-brand select').forEach(i =>
  i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(preview, 120); }));
$('br-accent').addEventListener('input', () => { $('br-accent-hex').value = $('br-accent').value; });
$('br-accent-hex').addEventListener('input', () => {
  const v = $('br-accent-hex').value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) { $('br-accent').value = v; preview(); }
});

window.saveBrand = async () => {
  const d = formData();
  if (!SLUG.test(d.slug) || d.slug.length < 2) return toast('Page address: 2–32 lowercase letters, numbers or dashes', true);
  if (RESERVED.has(d.slug)) return toast('That address is reserved, pick another', true);
  if (!d.name) return toast('Add your brand name', true);
  for (const [id, label] of Object.entries(URL_FIELDS)) {
    const v = $(id).value.trim();
    if (v && !/^https:\/\/\S+$/i.test(v)) return toast(`${label} must start with https://`, true);
  }
  const btn = $('br-save'); btn.disabled = true;
  try {
    const old = S.app.brandSlug;
    if (d.slug !== old) {
      const taken = await getDoc(doc(db, 'brands', d.slug)).catch(() => null);
      if (taken?.exists() && taken.data().appId !== S.app.id) throw new Error('That page address is already taken');
    }
    await setDoc(doc(db, 'brands', d.slug), { ...d, appId: S.app.id, ownerUid: S.user.uid, hasLoader: !!S.app.loader, updatedAt: serverTimestamp() });
    if (old && old !== d.slug) await deleteDoc(doc(db, 'brands', old)).catch(() => {});
    if (old !== d.slug) { await updateDoc(doc(db, 'apps', S.app.id), { brandSlug: d.slug }); S.app.brandSlug = d.slug; }
    current = d; fill(d);
    toast('Customer page saved');
  } catch (e) {
    toast(/permission/i.test(e.message) ? 'That page address is already taken' : e.message, true);
  } finally { btn.disabled = false; }
};

// ---------- Loader upload ----------
function pick(file) {
  if (!file) return;
  const max = (MAX_MB[S.plan] || 250) * 1048576;
  if (file.size > max) { toast(`That file is over ${MAX_MB[S.plan] || 250} MB`, true); return; }
  pendingFile = file; renderLoader();
}
$('ld-file').addEventListener('change', e => pick(e.target.files[0]));
const drop = $('ld-drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => pick(e.dataTransfer.files[0]));

function setMsg(type, text) { const m = $('ld-msg'); m.className = 'msg ' + type; m.textContent = text; }

window.uploadLoader = async () => {
  if (!pendingFile) return;
  if (!S.app.brandSlug) return setMsg('err', 'Save your page address first, then upload the loader.');
  const token = await auth.currentUser.getIdToken();
  const body = new FormData();
  body.append('file', pendingFile);
  $('ld-upload').disabled = true; $('ld-progress').style.display = ''; $('ld-bar').style.width = '0%'; setMsg('', '');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/apps/${S.app.id}/loader`);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = e => { if (e.lengthComputable) $('ld-bar').style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    $('ld-progress').style.display = 'none';
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      S.app.loader = { ...data, uploadedAt: new Date() };
      pendingFile = null; $('ld-file').value = '';
      setMsg('ok', 'Loader uploaded. Buyers can download it now.');
    } else setMsg('err', data.error || `Upload failed (${xhr.status}).`);
    renderLoader();
  };
  xhr.onerror = () => { $('ld-progress').style.display = 'none'; setMsg('err', 'Couldn’t reach the upload server. Try again.'); renderLoader(); };
  xhr.send(body);
};

window.deleteLoader = () => confirmBox('Remove the loader file? Buyers won’t be able to download until you upload a new one.', async () => {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/api/apps/${S.app.id}/loader`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) return toast('Couldn’t remove the file. Try again.', true);
  delete S.app.loader; renderLoader(); toast('Loader removed');
});
