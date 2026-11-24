// Affiliate links look like sovyx.cc/?ref=CODE. Remember the code and remind the visitor to use it when they buy in Discord.
(function () {
  var KEY = 'sv_ref', DISMISS = 'sv_ref_x';
  try {
    var m = /^[A-Za-z0-9]{2,20}$/;
    var fromUrl = new URLSearchParams(location.search).get('ref');
    if (fromUrl && m.test(fromUrl)) { localStorage.setItem(KEY, fromUrl.toUpperCase()); localStorage.removeItem(DISMISS); }
    var code = localStorage.getItem(KEY);
    if (!code || !m.test(code) || localStorage.getItem(DISMISS)) return;

    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;right:16px;top:64px;z-index:300;max-width:340px;background:#161616;border:1px solid rgba(225,29,72,.45);border-radius:12px;padding:14px 16px;font:13px/1.5 Inter,system-ui,sans-serif;color:#ededed;box-shadow:0 12px 40px rgba(0,0,0,.5)';
    var text = document.createElement('div');
    text.appendChild(document.createTextNode('You were referred. When you buy in our Discord, enter the code '));
    var strong = document.createElement('b'); strong.style.color = '#fb7185'; strong.textContent = code;
    text.appendChild(strong); text.appendChild(document.createTextNode(' in the ticket so they get credit.'));
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    function btn(label, primary) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'font:600 12px Inter,system-ui,sans-serif;padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid ' + (primary ? '#e11d48' : 'rgba(255,255,255,.14)') + ';background:' + (primary ? '#e11d48' : 'transparent') + ';color:#fff';
      return b;
    }
    var copy = btn('Copy code', true), close = btn('Dismiss', false);
    copy.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(code); copy.textContent = 'Copied'; };
    close.onclick = function () { localStorage.setItem(DISMISS, '1'); bar.remove(); };
    row.appendChild(copy); row.appendChild(close);
    bar.appendChild(text); bar.appendChild(row);
    document.body.appendChild(bar);
  } catch (e) { /* storage blocked: nothing to do */ }
})();
