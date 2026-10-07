/* State map: Leaflet (self-hosted) with markers from inline JSON. */
(function () {
  'use strict';

  var el = document.getElementById('map');
  var dataEl = document.getElementById(el ? el.getAttribute('data-map-src') : '');
  if (!el || !dataEl || !window.L) return;

  var points = JSON.parse(dataEl.textContent);
  el.innerHTML = '';
  // One-finger drags scroll the page on phones until the map is tapped.
  var touch = L.Browser.mobile;
  var map = L.map(el, { scrollWheelZoom: false, dragging: !touch, tap: !touch });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  }).addTo(map);
  L.Icon.Default.imagePath = '/assets/vendor/leaflet/images/';

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var bounds = [];
  points.forEach(function (p) {
    L.circleMarker([p.a, p.o], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#4A2C1D', fillOpacity: 0.95 })
      .bindPopup('<strong><a href="' + esc(p.u) + '">' + esc(p.n) + '</a></strong><br>' + esc(p.c) + (p.r ? '<br>Rated ' + p.r.toFixed(1) : ''))
      .addTo(map);
    bounds.push([p.a, p.o]);
  });
  if (bounds.length === 1) map.setView(bounds[0], 13);
  else map.fitBounds(bounds, { padding: [30, 30] });
  map.on('click', function () { map.scrollWheelZoom.enable(); map.dragging.enable(); });
})();
