/* Client-side search over states, cities, specialities, guides and shops. */
(function () {
  'use strict';

  var input = document.getElementById('site-search-input');
  var status = document.getElementById('site-search-status');
  var results = document.getElementById('site-search-results');
  if (!input || !results) return;

  var MAX = 50;
  var index = [];
  var ORDER = { State: 0, City: 1, Speciality: 2, Shop: 3, Guide: 4 };

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function search(raw) {
    var q = raw.trim().toLowerCase();
    if (!q) { status.textContent = 'Start typing to search ' + index.filter(function (i) { return i.t === 'Shop'; }).length.toLocaleString('en-US') + ' shops.'; results.innerHTML = ''; return; }
    var words = q.split(/\s+/);
    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var it = index[i];
      var hay = (it.n + ' ' + it.p).toLowerCase();
      var ok = true;
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) === -1) { ok = false; break; }
      if (!ok) continue;
      var name = it.n.toLowerCase();
      hits.push({ it: it, s: (name === q ? 0 : name.indexOf(q) === 0 ? 1 : 2) * 10 + ORDER[it.t] });
    }
    hits.sort(function (a, b) { return a.s - b.s; });
    status.textContent = hits.length ? hits.length + ' result' + (hits.length === 1 ? '' : 's') + (hits.length > MAX ? ', showing the first ' + MAX : '') : 'No matches for "' + raw.trim() + '". Try a city or state name.';
    results.innerHTML = hits.slice(0, MAX).map(function (h) {
      return '<li><span class="kind">' + esc(h.it.t) + '</span><br><a href="' + esc(h.it.u) + '">' + esc(h.it.n) + '</a><p>' + esc(h.it.p) + '</p></li>';
    }).join('');
  }

  var initial = new URLSearchParams(window.location.search).get('q') || '';
  fetch('/data/search-index.json')
    .then(function (r) { return r.json(); })
    .then(function (json) { index = json; input.value = initial; search(initial); })
    .catch(function () { status.textContent = 'Search could not load. Try browsing by state instead.'; });

  var timer;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { search(input.value); }, 120);
  });
})();
