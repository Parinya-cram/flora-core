(function () {
  var root = document.documentElement;
  var PAGES = [
    { key: 'home', href: './', th: 'หน้าแรก', en: 'Home' },
    { key: 'platform', href: 'platform.html', th: 'แพลตฟอร์ม', en: 'Platform' },
    { key: 'solutions', href: 'solutions.html', th: 'โซลูชัน OR / ICU', en: 'OR / ICU' },
    { key: 'devices', href: 'devices.html', th: 'อุปกรณ์', en: 'Devices' },
    { key: 'security', href: 'security.html', th: 'ความปลอดภัย', en: 'Security' },
    { key: 'contact', href: 'contact.html', th: 'ติดต่อ', en: 'Contact' }
  ];

  function pair(th, en) { return '<span class="th">' + th + '</span><span class="en">' + en + '</span>'; }

  var header = document.querySelector('header.site-header');
  if (header) {
    var page = header.getAttribute('data-page');
    var nav = PAGES.map(function (p) {
      return '<a href="' + p.href + '"' + (p.key === page ? ' aria-current="page"' : '') + '>' + pair(p.th, p.en) + '</a>';
    }).join('');
    header.innerHTML =
      '<div class="wrap">' +
        '<a class="brand" href="./" aria-label="FLORA iCIS">' +
          '<img class="logo-light" src="flora-icis-logo.png" alt="FLORA iCIS">' +
          '<img class="logo-dark" src="flora-icis-logo-dark.png" alt="FLORA iCIS">' +
        '</a>' +
        '<nav class="nav" aria-label="Main">' + nav +
          '<button class="lang-toggle" id="lang-toggle" type="button"></button>' +
        '</nav>' +
      '</div>';
  }

  var footer = document.querySelector('footer.site-footer');
  if (footer) {
    footer.innerHTML =
      '<div class="wrap">' +
        '<span>FLORA iCIS · E.S.M. Solution Co., Ltd. · <a href="https://esm-solution.com/" target="_blank" rel="noopener">esm-solution.com</a></span>' +
        '<nav aria-label="Footer">' + PAGES.slice(1).map(function (p) { return '<a href="' + p.href + '">' + pair(p.th, p.en) + '</a>'; }).join('') + '</nav>' +
        '<span>' + pair('ต้นแบบเว็บไซต์ · ข้อมูลในกราฟเป็นข้อมูลจำลอง', 'Website prototype · charts use simulated data') + '</span>' +
      '</div>';
  }

  function current() { return root.lang === 'en' ? 'en' : 'th'; }
  function setLang(l) {
    root.lang = l;
    var b = document.getElementById('lang-toggle');
    if (b) { b.textContent = l === 'en' ? 'ไทย' : 'EN'; b.setAttribute('aria-label', l === 'en' ? 'เปลี่ยนเป็นภาษาไทย' : 'Switch to English'); }
    try { localStorage.setItem('flora-lang', l); } catch (e) {}
    document.dispatchEvent(new CustomEvent('flora:lang', { detail: l }));
  }
  var saved = 'th';
  try { saved = localStorage.getItem('flora-lang') || 'th'; } catch (e) {}
  setLang(saved === 'en' ? 'en' : 'th');
  var btn = document.getElementById('lang-toggle');
  if (btn) btn.addEventListener('click', function () { setLang(current() === 'en' ? 'th' : 'en'); });

  window.FLORA = { lang: current, pair: pair };
})();
