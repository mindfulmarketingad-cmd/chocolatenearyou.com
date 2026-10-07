/* Progressive filter/sort for ranked hub lists. The list is fully rendered
   server-side; this only hides and reorders entries that are already there. */
(function () {
  'use strict';

  var list = document.querySelector('[data-hub-list]');
  var bar = document.querySelector('[data-hub-toolbar]');
  if (!list || !bar) return;
  bar.hidden = false;

  var q = bar.querySelector('[data-filter-q]');
  var city = bar.querySelector('[data-filter-city]');
  var sort = bar.querySelector('[data-filter-sort]');
  var openOnly = bar.querySelector('[data-filter-open]');
  var count = bar.querySelector('[data-filter-count]');
  var empty = document.querySelector('[data-filter-empty]');
  var entries = Array.prototype.slice.call(list.querySelectorAll('li.entry'));
  var ads = Array.prototype.slice.call(list.querySelectorAll('li.entry-ad'));
  var original = entries.slice();
  var here = null;

  var DAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  /* Open now is worked out in the shop's own time zone, from the hours its
     listing carries. Unknown hours count as "not known", never as open. */
  function openState(el) {
    var tz = el.getAttribute('data-tz');
    var h = el.getAttribute('data-h');
    if (!tz || !h) return null;
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    } catch (e) { return null; }
    var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return ''; };
    var day = DAY_INDEX[get('weekday')];
    var mins = Number(get('hour')) * 60 + Number(get('minute'));
    var days = h.split('|');
    function within(d, m) {
      var v = days[(d + 7) % 7];
      if (!v) return null;
      if (v === 'x') return false;
      var oc = v.split('-');
      return m >= Number(oc[0]) && m < Number(oc[1]);
    }
    var todayOpen = within(day, mins);
    var spill = within(day - 1, mins + 1440); // last night's late close
    if (todayOpen === null && spill === null) return null;
    return Boolean(todayOpen || spill);
  }

  entries.forEach(function (el) {
    var state = openState(el);
    el.__open = state;
    if (state === null) return;
    var badge = document.createElement('span');
    badge.className = 'open-badge ' + (state ? 'is-open' : 'is-closed');
    badge.textContent = state ? 'Open now' : 'Closed now';
    var head = el.querySelector('.entry-head');
    if (head) head.appendChild(badge);
  });

  function distance(el) {
    if (!here) return Infinity;
    var lat = Number(el.getAttribute('data-lat'));
    var lng = Number(el.getAttribute('data-lng'));
    var toRad = Math.PI / 180;
    var a = Math.pow(Math.sin((lat - here.lat) * toRad / 2), 2) +
      Math.cos(here.lat * toRad) * Math.cos(lat * toRad) * Math.pow(Math.sin((lng - here.lng) * toRad / 2), 2);
    return 7917.6 * Math.asin(Math.sqrt(a));
  }

  function apply() {
    var term = q ? q.value.trim().toLowerCase() : '';
    var c = city ? city.value : '';
    var mode = sort ? sort.value : 'rank';
    var onlyOpen = openOnly && openOnly.checked;
    var filtered = term || c || onlyOpen || mode !== 'rank';

    var shown = 0;
    entries.forEach(function (el) {
      var ok = (!term || el.getAttribute('data-name').indexOf(term) !== -1 || el.getAttribute('data-city').indexOf(term) !== -1) &&
        (!c || el.getAttribute('data-city') === c) &&
        (!onlyOpen || el.__open === true);
      el.classList.toggle('is-hidden', !ok);
      if (ok) shown++;
    });
    // In-feed ads only make sense in the original order.
    ads.forEach(function (ad) { ad.classList.toggle('is-hidden', filtered); });

    var ordered = original.slice();
    if (mode === 'reviews') ordered.sort(function (a, b) { return b.getAttribute('data-reviews') - a.getAttribute('data-reviews'); });
    if (mode === 'name') ordered.sort(function (a, b) { return a.getAttribute('data-name').localeCompare(b.getAttribute('data-name')); });
    if (mode === 'distance' && here) ordered.sort(function (a, b) { return distance(a) - distance(b); });
    if (mode === 'rank') {
      // Restore the server order, ads included.
      original.forEach(function (el) { list.appendChild(el); });
      ads.forEach(function (ad) {
        var before = ad.__before;
        if (before) list.insertBefore(ad, before);
      });
    } else {
      ordered.forEach(function (el) { list.appendChild(el); });
    }

    if (count) count.textContent = shown + ' of ' + entries.length + ' shown';
    if (empty) empty.hidden = shown !== 0;
  }

  ads.forEach(function (ad) { ad.__before = ad.nextElementSibling; });

  if (q) q.addEventListener('input', apply);
  if (city) city.addEventListener('change', apply);
  if (openOnly) openOnly.addEventListener('change', apply);
  if (sort) sort.addEventListener('change', function () {
    if (sort.value === 'distance' && !here) {
      if (!navigator.geolocation) { if (count) count.textContent = 'Location is not available in this browser.'; sort.value = 'rank'; return; }
      if (count) count.textContent = 'Finding your location...';
      navigator.geolocation.getCurrentPosition(function (pos) {
        here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        apply();
      }, function () {
        sort.value = 'rank';
        if (count) count.textContent = 'Location permission was declined. Showing our ranking.';
      }, { timeout: 10000, maximumAge: 600000 });
      return;
    }
    apply();
  });
  if (count) count.textContent = entries.length + ' shops';
})();
