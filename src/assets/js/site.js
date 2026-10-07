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

  // One push per <ins>, after the page has parsed. Slots keep their
  // reserved height whether or not an ad fills.
  var slots = document.querySelectorAll('ins.adsbygoogle');
  for (var i = 0; i < slots.length; i++) {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* blocked */ }
  }
})();
