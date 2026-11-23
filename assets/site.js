(function () {
  var nav = document.getElementById('nav');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 24); }
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  var els = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .08, rootMargin: '0px 0px -30px 0px' });
    els.forEach(function (el) { io.observe(el); });
  } else els.forEach(function (el) { el.classList.add('in'); });

  var bar = document.getElementById('cookie-bar');
  if (bar && !localStorage.getItem('sv_cookie')) {
    bar.style.display = 'flex';
    document.getElementById('ck-accept').onclick = function () { localStorage.setItem('sv_cookie', '1'); bar.style.display = 'none'; };
    document.getElementById('ck-decline').onclick = function () { localStorage.setItem('sv_cookie', '0'); bar.style.display = 'none'; };
  }

  // Table of contents. Docs have a static list; legal pages build one from their headings.
  var toc = document.getElementById('toc');
  var legal = document.querySelectorAll('.lg .legal-section');
  if (toc && legal.length && !toc.querySelector('a')) {
    var used = {}, html = '<b>On this page</b>';
    legal.forEach(function (sec) {
      var h = sec.querySelector('h2'); if (!h) return;
      var id = sec.id || h.id;
      if (!id) {
        id = h.textContent.toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
        while (used[id]) id += '-2';
        sec.id = id;
      }
      used[id] = 1;
      html += '<a href="#' + id + '">' + h.textContent.replace(/^\d+\.\s*/, '') + '</a>';
    });
    toc.innerHTML = html;
  }
  if (toc && 'IntersectionObserver' in window) {
    var links = [].slice.call(toc.querySelectorAll('a[href^="#"]'));
    var map = {};
    links.forEach(function (a) { var t = document.getElementById(a.getAttribute('href').slice(1)); if (t) map[t.id] = a; });
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { links.forEach(function (a) { a.classList.remove('on'); }); if (map[e.target.id]) map[e.target.id].classList.add('on'); } });
    }, { rootMargin: '-90px 0px -70% 0px' });
    Object.keys(map).forEach(function (id) { spy.observe(document.getElementById(id)); });
  }

  // Code blocks with language tabs and a copy button
  var saved = localStorage.getItem('sv_lang');
  function show(block, lang) {
    var any = false;
    block.querySelectorAll('pre[data-lang]').forEach(function (p) { var on = p.dataset.lang === lang; p.hidden = !on; any = any || on; });
    block.querySelectorAll('.cb-h button[data-lang]').forEach(function (b) { b.classList.toggle('on', b.dataset.lang === lang); });
    return any;
  }
  document.querySelectorAll('.cb').forEach(function (block) {
    var tabs = block.querySelectorAll('.cb-h button[data-lang]');
    if (tabs.length) {
      var first = tabs[0].dataset.lang;
      var has = saved && block.querySelector('pre[data-lang="' + saved + '"]');
      show(block, has ? saved : first);
      tabs.forEach(function (b) {
        b.addEventListener('click', function () {
          localStorage.setItem('sv_lang', b.dataset.lang);
          document.querySelectorAll('.cb').forEach(function (other) { if (other.querySelector('pre[data-lang="' + b.dataset.lang + '"]')) show(other, b.dataset.lang); });
        });
      });
    }
    var cp = block.querySelector('.cp');
    if (cp) cp.addEventListener('click', function () {
      var pre = block.querySelector('pre:not([hidden])');
      if (!pre) return;
      navigator.clipboard.writeText(pre.innerText).then(function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy'; }, 1400); });
    });
  });
})();
