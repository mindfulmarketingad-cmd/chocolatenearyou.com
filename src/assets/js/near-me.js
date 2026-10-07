/* Homepage "Use my location": loads a compact index of every listing and
   shows the closest ones. The location stays in the browser. */
(function () {
  'use strict';

  var btn = document.querySelector('[data-near-me]');
  var status = document.querySelector('[data-near-me-status]');
  var section = document.querySelector('[data-near-me-results]');
  var list = document.querySelector('[data-near-me-list]');
  if (!btn || !section || !list) return;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function miles(lat1, lng1, lat2, lng2) {
    var r = Math.PI / 180;
    var a = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lng2 - lng1) * r / 2), 2);
    return 7917.6 * Math.asin(Math.sqrt(a));
  }

  btn.addEventListener('click', function () {
    if (!navigator.geolocation) { status.textContent = 'Location is not available in this browser. Browse by state below instead.'; return; }
    status.textContent = 'Finding your location...';
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      fetch('/data/near-me.json')
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          var near = rows
            .map(function (x) { return { n: x[0], u: x[1], d: miles(lat, lng, x[2], x[3]), c: x[4], s: x[5], r: x[6], v: x[7] }; })
            .sort(function (a, b) { return a.d - b.d; })
            .slice(0, 12);
          list.innerHTML = near.map(function (x) {
            return '<li class="card"><div class="card-body"><h3><a href="' + esc(x.u) + '">' + esc(x.n) + '</a></h3>' +
              '<p class="small">' + esc(x.c) + ', ' + esc(x.s) + ' &middot; ' + x.d.toFixed(1) + ' mi' +
              (x.r ? ' &middot; ' + x.r.toFixed(1) + ' rating (' + x.v.toLocaleString('en-US') + ')' : '') + '</p></div></li>';
          }).join('');
          section.hidden = false;
          status.textContent = near.length && near[0].d > 75
            ? 'The closest shop we list is ' + near[0].d.toFixed(0) + ' miles away.'
            : 'Showing the ' + near.length + ' closest shops.';
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          btn.disabled = false;
        })
        .catch(function () { status.textContent = 'Could not load the directory. Browse by state below.'; btn.disabled = false; });
    }, function () {
      status.textContent = 'Location permission was declined. Pick your state below instead.';
      btn.disabled = false;
    }, { timeout: 10000, maximumAge: 600000 });
  });
})();
