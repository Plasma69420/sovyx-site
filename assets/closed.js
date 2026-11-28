// "Temporarily closed" notice. To reopen the site, set CLOSED to false (and bump ?v= on the script tags).
(function () {
  var CLOSED = true;
  var DISCORD = 'https://discord.gg/ar6zmuxpu';
  if (!CLOSED) return;

  var path = location.pathname.toLowerCase();
  if (path.indexOf('/admin') === 0) return;
  // Existing customers can still sign in, use their dashboard and download pages, and read the legal pages: they get a banner.
  // Everywhere else the notice takes over the whole page.
  var bannerOnly = /^\/(portal|login|b\/|terms|privacy|refunds)/.test(path);

  var css = document.createElement('style');
  css.textContent =
    '#svc{font-family:Inter,system-ui,sans-serif;color:#ededed;box-sizing:border-box}#svc *{box-sizing:border-box;margin:0;padding:0}' +
    '#svc.full{position:fixed;inset:0;z-index:2147483000;background:radial-gradient(ellipse at 50% 0,rgba(225,29,72,.22),transparent 60%),#0a0a0a;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;overflow:auto}' +
    '#svc.full .in{max-width:620px;margin:auto}#svc.full img{width:56px;height:56px;object-fit:contain;margin:0 auto 22px;display:block}' +
    '#svc .tag{display:inline-block;font-size:12px;font-weight:600;color:#fb7185;border:1px solid rgba(225,29,72,.4);background:rgba(225,29,72,.1);border-radius:999px;padding:5px 14px;margin-bottom:20px}' +
    '#svc.full h1{font-size:clamp(30px,6vw,52px);line-height:1.08;letter-spacing:-1.5px;font-weight:800;margin-bottom:16px}' +
    '#svc.full p{font-size:16.5px;line-height:1.6;color:#a1a1aa;margin-bottom:30px}#svc.full p b{color:#ededed;display:block;font-size:19px;margin-bottom:6px}' +
    '#svc a.go{display:inline-block;background:#e11d48;color:#fff;font-weight:600;font-size:14.5px;text-decoration:none;border-radius:10px;padding:12px 24px;box-shadow:0 8px 28px -8px rgba(225,29,72,.75)}#svc a.go:hover{background:#f43f5e}' +
    '#svc .links{margin-top:34px;display:flex;gap:22px;justify-content:center;flex-wrap:wrap}#svc .links a{color:#8a8a8a;font-size:13px;text-decoration:none}#svc .links a:hover{color:#fff}' +
    '#svc.bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:#1a0b10;border-top:1px solid rgba(225,29,72,.55);padding:12px 18px;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;text-align:center;font-size:13.5px}' +
    '#svc.bar b{color:#fb7185}#svc.bar a.go{padding:7px 15px;font-size:13px;box-shadow:none}' +
    'html.svc-full,html.svc-full body{overflow:hidden!important}html.svc-bar body{padding-bottom:76px}html.svc-bar #cookie-bar{bottom:84px!important}';
  (document.head || document.documentElement).appendChild(css);
  document.documentElement.classList.add(bannerOnly ? 'svc-bar' : 'svc-full');

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function discordButton(label) {
    var a = el('a', label, 'go');
    a.href = DISCORD; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function show() {
    if (document.getElementById('svc')) return;
    var box = el('div', '', bannerOnly ? 'bar' : 'full');
    box.id = 'svc';
    box.setAttribute('role', bannerOnly ? 'status' : 'dialog');
    box.setAttribute('aria-label', 'Sovyx is temporarily closed');
    if (bannerOnly) {
      var msg = el('span');
      msg.appendChild(el('b', 'We’re temporarily closing. '));
      msg.appendChild(document.createTextNode('All orders are paused. More info in our Discord server.'));
      box.appendChild(msg);
      box.appendChild(discordButton('Join the Discord'));
    } else {
      var inner = el('div', '', 'in');
      var logo = el('img'); logo.src = '/logo.webp'; logo.alt = 'Sovyx';
      var p = el('p');
      p.appendChild(el('b', 'All orders are paused.'));
      p.appendChild(document.createTextNode('More info in our Discord server.'));
      var links = el('div', '', 'links');
      [['Existing customers: log in', '/login'], ['Terms', '/terms'], ['Privacy', '/privacy'], ['Refunds', '/refunds']].forEach(function (l) {
        var a = el('a', l[0]); a.href = l[1]; links.appendChild(a);
      });
      inner.appendChild(logo); inner.appendChild(el('span', 'Notice', 'tag')); inner.appendChild(el('h1', 'We’re temporarily closing.'));
      inner.appendChild(p); inner.appendChild(discordButton('Join the Discord')); inner.appendChild(links);
      box.appendChild(inner);
      // keep keyboard and screen readers inside the notice
      Array.prototype.forEach.call(document.body.children, function (c) { if (c.tagName !== 'SCRIPT') c.setAttribute('inert', ''); });
    }
    document.body.appendChild(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
