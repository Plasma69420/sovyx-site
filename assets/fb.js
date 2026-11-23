import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBNyhb0w6csyFDuQO1EhNTkfBZUS5pGrnQ",
  authDomain:        "sovyx-2793f.firebaseapp.com",
  projectId:         "sovyx-2793f",
  storageBucket:     "sovyx-2793f.firebasestorage.app",
  messagingSenderId: "82725494480",
  appId:             "1:82725494480:web:460ac2e4dd886f067a88d5"
};

export const fbApp = initializeApp(FIREBASE_CONFIG);
export const auth  = getAuth(fbApp);
export const db    = getFirestore(fbApp);

// Railway service that stores loaders and issues one-time download links.
export const API_BASE = "https://sovyx-site-production.up.railway.app";

export const PLAN_RANK  = { free: 0, basic: 1, pro: 2, ultimate: 3 };
export const PLAN_LABEL = { free: 'Free', basic: 'Basic', pro: 'Pro', ultimate: 'Ultimate' };

export const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
export const $ = id => document.getElementById(id);

export const toMs = t => t === 0 ? 0 : (t?.toMillis?.() ?? (t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : null)));
export const fmtDate = t => { const ms = toMs(t); return ms === 0 ? 'Lifetime' : ms ? new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'; };
export const ago = t => {
  const ms = toMs(t); if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'Just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
};
export const initials = s => (String(s || '?').replace(/[^a-z0-9]/gi,'').slice(0,2) || '?').toUpperCase();

export function randBlock(n = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(buf, b => chars[b % chars.length]).join('');
}
export function randHex(bytes = 24) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2,'0')).join('');
}

let tt;
export function toast(msg, isErr = false) {
  const el = $('toast');
  $('toast-txt').textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(tt);
  tt = setTimeout(() => el.classList.remove('show'), 3000);
}

export function openModal(id) { $(id).classList.add('open'); }
export function closeModal(id) { $(id).classList.remove('open'); }
export function confirmBox(body, cb, title = 'Are you sure?') {
  $('cf-title').textContent = title;
  $('cf-body').textContent = body;
  $('cf-ok').onclick = async () => { closeModal('m-confirm'); await cb(); };
  openModal('m-confirm');
}
export function copy(text) { navigator.clipboard.writeText(text); toast('Copied'); }

Object.assign(window, { openModal, closeModal, copy });
document.addEventListener('click', e => { if (e.target.classList?.contains('overlay')) e.target.classList.remove('open'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); });
