/* Site-wide: mobile nav, today's row in hours tables, AdSense slot init. */
(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var today = days[new Date().getDay()];
  document.querySelectorAll('[data-hours] tr[data-day="' + today + '"]').forEach(function (row) {
    row.classList.add('is-today');
  });

  // Back-to-top button on long pages (state lists run to hundreds of shops).
  if (document.documentElement.scrollHeight > window.innerHeight * 4) {
    var top = document.createElement('button');
    top.type = 'button';
    top.className = 'to-top';
    top.setAttribute('aria-label', 'Back to top');
    top.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
    top.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(top);
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        top.classList.toggle('is-visible', window.scrollY > window.innerHeight * 1.5);
        ticking = false;
      });
    }, { passive: true });
  }

  // One push per <ins>, after the page has parsed. Slots keep their
  // reserved height whether or not an ad fills.
  var slots = document.querySelectorAll('ins.adsbygoogle');
  for (var i = 0; i < slots.length; i++) {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* blocked */ }
  }
})();
