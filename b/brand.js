// Renders a seller's public key-redeem page. Used by /b/<slug> (via 404.html) and the live preview in the portal.

const SAFE_URL = /^https:\/\/[^\s"'<>]+$/i;
const HEX = /^#[0-9a-f]{6}$/i;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function link(href, label) {
  if (!SAFE_URL.test(href || '')) return null;
  const a = el('a', 'bp-link', label);
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

export function renderBrand(root, brand, { onSubmit, preview = false } = {}) {
  const b = brand || {};
  const name = (b.name || 'Your brand').trim();
  const page = el('div', `bp bp-theme-${['spotlight', 'gradient', 'dark'].includes(b.theme) ? b.theme : 'spotlight'}`);
  page.style.setProperty('--accent', HEX.test(b.accent || '') ? b.accent : '#e11d48');
  page.append(el('div', 'bp-bg'));
  if (b.announcement) page.append(el('div', 'bp-announce', b.announcement));

  const main = el('main', 'bp-main');
  if (SAFE_URL.test(b.logoUrl || '')) {
    const img = el('img', 'bp-logo');
    img.alt = ''; img.src = b.logoUrl;
    img.onerror = () => img.replaceWith(el('div', 'bp-mark', name.slice(0, 1).toUpperCase()));
    main.append(img);
  } else main.append(el('div', 'bp-mark', name.slice(0, 1).toUpperCase()));
  main.append(el('h1', 'bp-name', name));
  main.append(el('p', 'bp-tag', b.tagline || 'Enter your product key to download the loader.'));

  const form = el('form', 'bp-form');
  const input = el('input', 'bp-input');
  input.placeholder = 'Enter your product key'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 80;
  const btn = el('button', 'bp-btn', b.buttonText || 'Download');
  btn.type = 'submit';
  form.append(input, btn);
  const msg = el('div', 'bp-msg');

  const done = el('div', 'bp-done');
  const fileLine = el('div', 'bp-file');
  const links = el('div', 'bp-links');
  [link(b.discordUrl, 'Join the Discord'), link(b.supportUrl, 'Support')].forEach(a => a && links.append(a));
  const again = el('button', 'bp-again', 'Download didn’t start? Enter your key again');
  again.type = 'button';
  again.onclick = () => { page.classList.remove('is-done'); input.focus(); };
  done.append(el('div', 'bp-check', '✓'), el('h2', null, 'Your download has started'),
    el('p', null, 'Run the loader and sign in with the same key. The link only works once, for a few minutes.'), fileLine);
  if (links.children.length) done.append(links);
  done.append(again);

  main.append(form, msg, done);
  if (b.version) main.append(el('div', 'bp-ver', `Version ${b.version}`));
  page.append(main);

  const foot = el('footer', 'bp-foot');
  const sv = el('a', null, 'Sovyx'); sv.href = 'https://sovyx.cc'; sv.target = '_blank'; sv.rel = 'noopener';
  foot.append('Powered by ', sv);
  page.append(foot);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (preview) { msg.textContent = 'Preview — keys are checked on your live page.'; return; }
    const key = input.value.trim();
    if (!key) { msg.textContent = 'Enter your product key.'; return; }
    msg.textContent = ''; btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await onSubmit(key);
      fileLine.textContent = r.filename + (r.size ? ` · ${(r.size / 1048576).toFixed(1)} MB` : '');
      page.classList.add('is-done');
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong. Try again.';
    } finally {
      btn.disabled = false; btn.textContent = b.buttonText || 'Download';
    }
  });

  root.replaceChildren(page);
  return page;
}

export function renderNotFound(root) {
  const page = el('div', 'bp bp-theme-spotlight bp-404');
  page.append(el('div', 'bp-bg'));
  const main = el('main', 'bp-main');
  const home = el('a', 'bp-link', 'Go to sovyx.cc'); home.href = '/';
  main.append(el('h1', 'bp-name', 'Page not found'), el('p', 'bp-tag', 'This link doesn’t point to anything. Check the address and try again.'), home);
  page.append(main);
  root.replaceChildren(page);
}

// Standalone boot for sovyx.cc/b/<slug>
export async function boot(root) {
  const m = location.pathname.match(/^\/b\/([a-z0-9-]{2,32})\/?$/i);
  if (!m) return renderNotFound(root);
  const slug = m[1].toLowerCase();
  const [{ db, API_BASE }, { doc, getDoc }] = await Promise.all([
    import('/assets/fb.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
  ]);
  const snap = await getDoc(doc(db, 'brands', slug)).catch(() => null);
  if (!snap?.exists()) return renderNotFound(root);
  const brand = snap.data();
  document.title = `${brand.name || slug} — Download`;
  if (SAFE_URL.test(brand.logoUrl || '')) document.querySelector('link[rel=icon]')?.setAttribute('href', brand.logoUrl);
  renderBrand(root, brand, {
    onSubmit: async key => {
      const res = await fetch(`${API_BASE}/api/b/${slug}/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      }).catch(() => { throw new Error('Couldn’t reach the download server. Try again in a moment.'); });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That key isn’t valid.');
      const a = document.createElement('a');
      a.href = API_BASE + data.url; a.rel = 'noopener';
      document.body.append(a); a.click(); a.remove();
      return data;
    },
  });
}
