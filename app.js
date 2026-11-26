/* Fuel Log PWA — every fill-up, every mile, every dollar.
 *
 * No build step, no dependencies, no account, no server. Fill-ups live
 * in this device's localStorage and move as one plain JSON file.
 *
 * Bikes live in the SHARED Pocket Garage roster (the "pocket-garage-
 * bikes" key, via the vendored bike-profile.js — the same b1/b2/b3
 * roster the other apps use). This app never invents a second bike
 * model: a fill-up points at a roster key, and the roster is the
 * only place bike names live. Add a bike here and it is added to the
 * shared roster; there is no delete-bike here in v1 — roster
 * management belongs to the landing dashboard (Phase 2), so a bike
 * you mistype is removed there, not here.
 *
 * MPG rule, stated plainly wherever MPG appears:
 *   MPG for a fill-up = miles since the previous fill-up on that bike
 *   divided by the gallons bought at THIS fill-up.
 * That only means something when both fill-ups are full tanks, so:
 *   - the first fill-up on a bike has no MPG (nothing before it);
 *   - a partial fill has no MPG, and the fill-up after a partial has
 *     no MPG either (its miles were partly paid for by the partial's
 *     gallons). Totals still count partials — gallons, cost, and miles
 *     are all real money and real miles.
 * Running average MPG = eligible segment miles / eligible segment
 * gallons (full-to-full segments only), never an average of rounded
 * per-fill-up figures. Cost per mile = total cost / total miles.
 * Every figure on screen is either typed in by the rider or computed
 * from typed-in figures by the formulas above — nothing is invented,
 * and no tank size, price, or MPG figure is ever suggested.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
var STORAGE_KEY = 'fuel-log-v1';
var VERSION = 1;

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */
function round2(x) { return Math.round(x * 100) / 100; }
function round1(x) { return Math.round(x * 10) / 10; }

function isDateISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayISO() {
  var d = new Date();
  var m = '' + (d.getMonth() + 1);
  var day = '' + d.getDate();
  return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
}

function fmtMoney(x) {
  return '$' + (Math.round(x * 100) / 100).toFixed(2);
}

function fmtMpg(x) {
  if (x === null || x === undefined) return '—';
  return round1(x).toFixed(1);
}

function fmtCostPerMile(x) {
  if (x === null || x === undefined) return '—';
  return '$' + x.toFixed(3) + ' / mi';
}

function slugify(name) {
  var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'bike';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */
function emptyStore() {
  return { version: VERSION, fillups: [] };
}

/* A fill-up, validated. Throws with a plain message on bad input.
 * odometer is miles (integer, whole miles — gas pumps and odometers
 * both read whole miles here). gallons and price_per_gal are positive
 * decimals as typed. total is computed, never typed: gallons × price,
 * rounded to cents. */
function validateFillupFields(f) {
  if (!f || typeof f !== 'object') throw new Error('fill-up must be an object');
  if (typeof f.bike_key !== 'string' || !f.bike_key) throw new Error('fill-up needs a bike');
  if (!isDateISO(f.date)) throw new Error('fill-up needs a real date (YYYY-MM-DD)');
  var odo = Number(f.odometer);
  if (f.odometer === '' || f.odometer === null || f.odometer === undefined || isNaN(odo) || odo < 0 || Math.floor(odo) !== odo)
    throw new Error('odometer must be a whole number of miles, 0 or more');
  var gal = Number(f.gallons);
  if (f.gallons === '' || f.gallons === null || f.gallons === undefined || isNaN(gal) || gal <= 0)
    throw new Error('gallons must be more than 0');
  var ppg = Number(f.price_per_gal);
  if (f.price_per_gal === '' || f.price_per_gal === null || f.price_per_gal === undefined || isNaN(ppg) || ppg <= 0)
    throw new Error('price per gallon must be more than $0');
  return {
    bike_key: f.bike_key,
    date: f.date,
    odometer: odo,
    gallons: gal,
    price_per_gal: ppg,
    total: round2(gal * ppg),
    station: typeof f.station === 'string' ? f.station.trim() : '',
    partial: !!f.partial,
    notes: typeof f.notes === 'string' ? f.notes : ''
  };
}

function nextFillupId(store) {
  var max = 0;
  store.fillups.forEach(function (f) {
    var m = /^f(\d+)$/.exec(f.id || '');
    if (m && +m[1] > max) max = +m[1];
  });
  return 'f' + (max + 1);
}

/* Fill-ups for one bike, oldest first — odometer order, then date,
 * then id. MPG is computed over this order, so the order is the data. */
function fillupsForBike(store, bikeKey) {
  return store.fillups.filter(function (f) { return f.bike_key === bikeKey; })
    .sort(function (a, b) {
      if (a.odometer !== b.odometer) return a.odometer - b.odometer;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

function addFillup(store, fields) {
  var f = validateFillupFields(fields);
  /* No odometer-order check here, deliberately: a rider backfilling
   * old receipts enters lower readings after higher ones, and that is
   * legitimate. MPG is computed over the odometer-sorted order, so a
   * backfilled fill-up just slots into its place. A wrong reading
   * shows up as a 0.0 or absurd MPG on its row, not as a crash. */
  f.id = nextFillupId(store);
  store.fillups.push(f);
  return f;
}

function deleteFillup(store, id) {
  for (var i = 0; i < store.fillups.length; i++) {
    if (store.fillups[i].id === id) { store.fillups.splice(i, 1); return true; }
  }
  return false;
}

/* Same bike + same date + same odometer: the same fill-up typed twice.
 * The sample loader uses this so tapping "Load example data" twice
 * never doubles the log. */
function hasFillup(store, bikeKey, date, odometer) {
  return store.fillups.some(function (f) {
    return f.bike_key === bikeKey && f.date === date && f.odometer === odometer;
  });
}

/* ------------------------------------------------------------------ */
/* MPG + totals — the whole point of the app                           */
/* ------------------------------------------------------------------ */
/* Rows for one bike, newest first for display. Each row carries:
 *   mpg — number (1-decimal display) or null, with mpgNote saying why
 *   miles — miles since the previous fill-up, or null on the first one
 * The running average uses only full-to-full segments, computed from
 * raw miles and gallons, never from rounded per-fill-up MPGs. */
function fillupRows(store, bikeKey) {
  var asc = fillupsForBike(store, bikeKey);
  var rows = asc.map(function (f, i) {
    var row = {
      id: f.id, bike_key: f.bike_key, date: f.date, odometer: f.odometer,
      gallons: f.gallons, price_per_gal: f.price_per_gal, total: f.total,
      station: f.station, partial: !!f.partial, notes: f.notes,
      miles: null, mpg: null, mpgNote: ''
    };
    if (i === 0) {
      row.mpgNote = 'first fill-up — no MPG yet';
      return row;
    }
    var prev = asc[i - 1];
    row.miles = f.odometer - prev.odometer;
    if (f.partial) { row.mpgNote = 'partial fill — no MPG'; return row; }
    if (prev.partial) { row.mpgNote = 'previous fill was partial — no MPG'; return row; }
    row.mpg = round1(row.miles / f.gallons);
    return row;
  });
  return rows.reverse();
}

function bikeStats(store, bikeKey) {
  var asc = fillupsForBike(store, bikeKey);
  var stats = {
    bike_key: bikeKey, fillups: asc.length, totalGallons: 0, totalCost: 0,
    totalMiles: 0, avgMpg: null, costPerMile: null, firstDate: null, lastDate: null
  };
  if (!asc.length) return stats;
  var eligMiles = 0, eligGallons = 0;
  asc.forEach(function (f, i) {
    stats.totalGallons = round2(stats.totalGallons + f.gallons);
    stats.totalCost = round2(stats.totalCost + f.total);
    if (i > 0) {
      var prev = asc[i - 1];
      if (!f.partial && !prev.partial) {
        eligMiles += f.odometer - prev.odometer;
        eligGallons += f.gallons;
      }
    }
  });
  stats.totalGallons = round2(stats.totalGallons);
  stats.totalMiles = asc[asc.length - 1].odometer - asc[0].odometer;
  stats.firstDate = asc[0].date;
  stats.lastDate = asc[asc.length - 1].date;
  if (eligGallons > 0) stats.avgMpg = round1(eligMiles / eligGallons);
  if (stats.totalMiles > 0) stats.costPerMile = Math.round(stats.totalCost / stats.totalMiles * 1000) / 1000;
  return stats;
}

function allBikeStats(store) {
  var keys = {};
  store.fillups.forEach(function (f) { keys[f.bike_key] = true; });
  var total = { fillups: 0, totalGallons: 0, totalCost: 0, totalMiles: 0, avgMpg: null, costPerMile: null };
  var eligMiles = 0, eligGallons = 0;
  Object.keys(keys).forEach(function (k) {
    var s = bikeStats(store, k);
    total.fillups += s.fillups;
    total.totalGallons = round2(total.totalGallons + s.totalGallons);
    total.totalCost = round2(total.totalCost + s.totalCost);
    total.totalMiles += s.totalMiles;
    /* Recompute the eligible sums from the raw rows — never average
     * per-bike averages. */
    var asc = fillupsForBike(store, k);
    asc.forEach(function (f, i) {
      if (i > 0) {
        var prev = asc[i - 1];
        if (!f.partial && !prev.partial) {
          eligMiles += f.odometer - prev.odometer;
          eligGallons += f.gallons;
        }
      }
    });
  });
  if (eligGallons > 0) total.avgMpg = round1(eligMiles / eligGallons);
  if (total.totalMiles > 0) total.costPerMile = Math.round(total.totalCost / total.totalMiles * 1000) / 1000;
  return total;
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */
function validateImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('import must be a JSON object');
  if (!Array.isArray(data.fillups)) throw new Error('import needs a fillups array');
  var out = emptyStore();
  var seen = {};
  data.fillups.forEach(function (raw) {
    if (!raw || typeof raw !== 'object') throw new Error('each fill-up must be an object');
    var f = validateFillupFields(raw);
    /* Ids are re-minted on import in sequence, so a file that was
     * edited by hand with duplicate or missing ids still loads. */
    f.id = nextFillupId(out);
    out.fillups.push(f);
    seen[f.id] = true;
  });
  return out;
}

function bikeFuelExport(store, bikeKey) {
  var rows = fillupRows(store, bikeKey);
  var stats = bikeStats(store, bikeKey);
  return {
    app: 'fuel-log', version: VERSION, bike_key: bikeKey,
    exported: todayISO(), stats: stats,
    fillups: rows.slice().reverse().map(function (r) {
      return {
        id: r.id, date: r.date, odometer: r.odometer, gallons: r.gallons,
        price_per_gal: r.price_per_gal, total: r.total, station: r.station,
        partial: r.partial, notes: r.notes, miles: r.miles, mpg: r.mpg
      };
    })
  };
}

function bikeFuelText(store, bikeKey, bikeName) {
  var exp = bikeFuelExport(store, bikeKey);
  var s = exp.stats;
  var lines = [];
  lines.push('Fuel log — ' + (bikeName || bikeKey));
  lines.push('Exported ' + exp.exported);
  lines.push('');
  lines.push(s.fillups + ' fill-ups — ' + s.totalMiles + ' mi — ' +
    s.totalGallons.toFixed(2) + ' gal — ' + fmtMoney(s.totalCost) +
    ' — avg ' + fmtMpg(s.avgMpg) + ' MPG — ' + fmtCostPerMile(s.costPerMile));
  lines.push('');
  exp.fillups.forEach(function (f) {
    lines.push(f.date + ' @ ' + f.odometer + ' mi — ' + f.gallons + ' gal @ ' +
      fmtMoney(f.price_per_gal) + '/gal — ' + fmtMoney(f.total) +
      (f.partial ? ' (partial)' : '') +
      (f.mpg !== null ? ' — ' + fmtMpg(f.mpg) + ' MPG' : ' — no MPG') +
      (f.station ? ' — ' + f.station : '') +
      (f.notes ? ' — ' + f.notes : ''));
  });
  lines.push('');
  lines.push('MPG = miles since the previous fill-up ÷ gallons at this fill-up. ' +
    'A partial fill has no MPG, and neither does the fill-up after one.');
  return lines.join('\n') + '\n';
}

function exportFilename(bikeName, ext) {
  return 'fuel-log-' + slugify(bikeName) + '-fillups.' + ext;
}

/* ------------------------------------------------------------------ */
/* Sample data — the 1995 Fat Boy (b1), real arithmetic, no invented  */
/* prices beyond the example itself. Every number below is one the    */
/* sample types in; MPG and totals are computed by the same code the  */
/* app runs on real fill-ups.                                          */
/* ------------------------------------------------------------------ */
function sampleStore() {
  var s = emptyStore();
  var rows = [
    { bike_key: 'b1', date: '2026-10-20', odometer: 42100, gallons: 4.0, price_per_gal: 3.89, station: 'QT — 51st Ave', partial: false, notes: '' },
    { bike_key: 'b1', date: '2026-10-27', odometer: 42285, gallons: 4.3, price_per_gal: 3.90, station: 'QT — 51st Ave', partial: false, notes: '' },
    { bike_key: 'b1', date: '2026-11-03', odometer: 42470, gallons: 4.1, price_per_gal: 3.80, station: 'Chevron — Bell Rd', partial: false, notes: '' },
    { bike_key: 'b1', date: '2026-11-10', odometer: 42640, gallons: 4.0, price_per_gal: 4.00, station: 'QT — 51st Ave', partial: true, notes: 'topped off before the ride' },
    { bike_key: 'b1', date: '2026-11-17', odometer: 42820, gallons: 4.2, price_per_gal: 3.95, station: 'Shell — 83rd Ave', partial: false, notes: '' },
    { bike_key: 'b1', date: '2026-11-24', odometer: 43005, gallons: 4.3, price_per_gal: 3.89, station: 'QT — 51st Ave', partial: false, notes: '' }
  ];
  rows.forEach(function (r) { addFillup(s, r); });
  return s;
}

/* ------------------------------------------------------------------ */
/* DOM layer — browser only. The pure logic above runs in Node tests. */
/* ------------------------------------------------------------------ */
if (typeof document !== 'undefined') {
  var BikeProfile = (typeof window !== 'undefined' && window.PG_BikeProfile) ? window.PG_BikeProfile : null;
  var SWUpdate = (typeof window !== 'undefined' && window.PG_SWUpdate) ? window.PG_SWUpdate : null;

  var storage = (function () {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.getItem('__fuel_log_probe__'); return localStorage; }
    } catch (e) { /* private mode / blocked storage: memory only */ }
    var mem = {};
    return {
      getItem: function (k) { return mem.hasOwnProperty(k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  })();

  var profile = BikeProfile ? BikeProfile.create(storage) : null;
  var store = emptyStore();

  function loadStore() {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (raw) store = validateImport(JSON.parse(raw));
    } catch (e) { store = emptyStore(); }
  }
  function saveStore() {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* quota: keep the in-memory copy */ }
  }

  function bikes() {
    if (!profile) return [];
    try { return profile.listBikes(); } catch (e) { return []; }
  }
  function bikeName(key) {
    var b = null;
    try { b = profile ? profile.getBike(key) : null; } catch (e) { b = null; }
    return b ? b.name : key;
  }

  function el(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function fillBikeSelects() {
    var list = bikes();
    var opts = list.map(function (b) {
      return '<option value="' + escapeHtml(b.key) + '">' + escapeHtml(b.name) + '</option>';
    }).join('');
    ['log-bike', 'f-bike', 'summary-bike', 'export-bike'].forEach(function (id) {
      var sel = el(id);
      if (!sel) return;
      var keep = sel.value;
      if (id === 'summary-bike') {
        sel.innerHTML = '<option value="">All bikes</option>' + opts;
      } else {
        sel.innerHTML = opts;
      }
      if (keep) sel.value = keep;
    });
  }

  function renderLog() {
    var key = el('log-bike').value;
    var rows = key ? fillupRows(store, key) : [];
    var html = '';
    if (!key) {
      html = '<p class="muted">Add a bike first — the fuel log needs a bike to hang fill-ups on.</p>';
    } else if (!rows.length) {
      html = '<p class="muted">No fill-ups yet for ' + escapeHtml(bikeName(key)) + '. Log the first one below — it sets the odometer baseline, and MPG starts on the second full fill-up.</p>';
    } else {
      html = '<table><thead><tr><th>Date</th><th class="num">Odo</th><th class="num">Gal</th><th class="num">$/gal</th><th class="num">Total</th><th class="num">MPG</th><th></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        html += '<tr><td>' + escapeHtml(r.date) + (r.partial ? ' <span class="badge">partial</span>' : '') +
          (r.station ? '<br><span class="muted">' + escapeHtml(r.station) + '</span>' : '') +
          (r.notes ? '<br><span class="muted">' + escapeHtml(r.notes) + '</span>' : '') +
          '</td><td class="num">' + r.odometer.toLocaleString('en-US') + '</td>' +
          '<td class="num">' + r.gallons + '</td>' +
          '<td class="num">' + fmtMoney(r.price_per_gal) + '</td>' +
          '<td class="num">' + fmtMoney(r.total) + '</td>' +
          '<td class="num">' + (r.mpg === null ? '<span class="muted" title="' + escapeHtml(r.mpgNote) + '">—</span>' : fmtMpg(r.mpg)) + '</td>' +
          '<td><button class="mini danger" data-del="' + r.id + '">Delete</button></td></tr>';
      });
      html += '</tbody></table>';
      html += '<p class="muted">MPG = miles since the previous fill-up ÷ gallons at this fill-up. A partial fill has no MPG, and neither does the fill-up after one.</p>';
    }
    el('fillup-list').innerHTML = html;
    el('fillup-list').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (deleteFillup(store, btn.getAttribute('data-del'))) { saveStore(); renderAll(); toast('Fill-up deleted.'); }
      });
    });
  }

  function renderSummary() {
    var key = el('summary-bike').value;
    var html = '';
    if (!key) {
      var total = allBikeStats(store);
      html = '<div class="card"><h3>All bikes</h3>' +
        '<p>' + total.fillups + ' fill-ups — ' + total.totalMiles.toLocaleString('en-US') + ' mi — ' +
        total.totalGallons.toFixed(2) + ' gal — ' + fmtMoney(total.totalCost) +
        ' — avg ' + fmtMpg(total.avgMpg) + ' MPG — ' + fmtCostPerMile(total.costPerMile) + '</p></div>';
      bikes().forEach(function (b) {
        var s = bikeStats(store, b.key);
        if (!s.fillups) return;
        html += '<div class="card"><h3>' + escapeHtml(b.name) + '</h3>' +
          '<p>' + s.fillups + ' fill-ups — ' + s.totalMiles.toLocaleString('en-US') + ' mi — ' +
          s.totalGallons.toFixed(2) + ' gal — ' + fmtMoney(s.totalCost) +
          ' — avg ' + fmtMpg(s.avgMpg) + ' MPG — ' + fmtCostPerMile(s.costPerMile) + '</p>' +
          '<p class="muted">' + escapeHtml(s.firstDate) + ' to ' + escapeHtml(s.lastDate) + '</p></div>';
      });
      if (!total.fillups) html += '<p class="muted">No fill-ups yet. Log one on the Log tab and the numbers start here.</p>';
    } else {
      var s2 = bikeStats(store, key);
      html = '<div class="card"><h3>' + escapeHtml(bikeName(key)) + '</h3>';
      if (!s2.fillups) {
        html += '<p class="muted">No fill-ups yet for this bike.</p>';
      } else {
        html += '<p>' + s2.fillups + ' fill-ups — ' + s2.totalMiles.toLocaleString('en-US') + ' mi — ' +
          s2.totalGallons.toFixed(2) + ' gal — ' + fmtMoney(s2.totalCost) +
          ' — avg ' + fmtMpg(s2.avgMpg) + ' MPG — ' + fmtCostPerMile(s2.costPerMile) + '</p>' +
          '<p class="muted">' + escapeHtml(s2.firstDate) + ' to ' + escapeHtml(s2.lastDate) + '</p>';
      }
      html += '</div>';
    }
    el('summary-cards').innerHTML = html;
  }

  function renderBikes() {
    var list = bikes();
    var html = '';
    if (!list.length) {
      html = '<p class="muted">No bikes yet. The shared roster starts with the 1995 Fat Boy, the 1990 Softail, and the 1947 Knucklehead — add yours below.</p>';
    } else {
      html = '<ul class="bike-list">';
      list.forEach(function (b) {
        var s = bikeStats(store, b.key);
        html += '<li><b>' + escapeHtml(b.name) + '</b>' +
          (b.year ? ' (' + escapeHtml(String(b.year)) + ')' : '') +
          (b.model ? ' — ' + escapeHtml(b.model) : '') +
          '<br><span class="muted">' + s.fillups + ' fill-ups' +
          (s.fillups ? ' — avg ' + fmtMpg(s.avgMpg) + ' MPG' : '') + '</span></li>';
      });
      html += '</ul>';
    }
    el('bikes-list').innerHTML = html;
  }

  function renderData() {
    var total = allBikeStats(store);
    el('data-counts').textContent = total.fillups + ' fill-ups — ' +
      total.totalGallons.toFixed(2) + ' gal — ' + fmtMoney(total.totalCost) +
      ' — ' + bikes().length + ' bikes on the shared roster.';
  }

  function renderAll() {
    fillBikeSelects();
    renderLog();
    renderSummary();
    renderBikes();
    renderData();
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === name); });
  }

  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });

  el('log-bike').addEventListener('change', renderLog);
  el('summary-bike').addEventListener('change', renderSummary);

  el('fillup-form').addEventListener('submit', function (e) {
    e.preventDefault();
    try {
      var f = addFillup(store, {
        bike_key: el('f-bike').value,
        date: el('f-date').value,
        odometer: el('f-odometer').value,
        gallons: el('f-gallons').value,
        price_per_gal: el('f-price').value,
        station: el('f-station').value,
        partial: el('f-partial').checked,
        notes: el('f-notes').value
      });
      saveStore();
      el('fillup-form').reset();
      el('f-date').value = todayISO();
      el('log-bike').value = f.bike_key;
      renderAll();
      toast('Fill-up logged — ' + fmtMoney(f.total) + '.');
    } catch (err) { toast(err.message); }
  });

  el('bike-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!profile) { toast('Bike roster unavailable on this device.'); return; }
    var name = el('bike-name').value.trim();
    if (!name) { toast('Give the bike a name.'); return; }
    var year = el('bike-year').value.trim();
    var key = profile.addBike({
      name: name,
      year: year ? parseInt(year, 10) : null,
      model: el('bike-model').value.trim(),
      carb: '',
      notes: el('bike-notes').value.trim()
    });
    el('bike-form').reset();
    renderAll();
    toast('Bike added to the shared roster (' + key + ').');
  });

  el('export-btn').addEventListener('click', function () {
    download('fuel-log-backup.json', JSON.stringify(store, null, 2));
    toast('Backup downloaded.');
  });
  el('copy-export-btn').addEventListener('click', function () {
    var done = function () { toast('Backup copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(JSON.stringify(store, null, 2)).then(done, function () { toast('Copy failed — use Download instead.'); });
    } else { toast('Clipboard unavailable — use Download instead.'); }
  });
  el('export-json-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    if (!key) { toast('Pick a bike first.'); return; }
    download(exportFilename(bikeName(key), 'json'), JSON.stringify(bikeFuelExport(store, key), null, 2));
  });
  el('export-text-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    if (!key) { toast('Pick a bike first.'); return; }
    download(exportFilename(bikeName(key), 'txt'), bikeFuelText(store, key, bikeName(key)), 'text/plain');
  });
  el('copy-text-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    if (!key) { toast('Pick a bike first.'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(bikeFuelText(store, key, bikeName(key))).then(function () { toast('Copied.'); }, function () { toast('Copy failed — use Download instead.'); });
    } else { toast('Clipboard unavailable — use Download instead.'); }
  });
  el('import-btn').addEventListener('click', function () {
    var file = el('import-file').files && el('import-file').files[0];
    var text = el('import-text').value.trim();
    var apply = function (raw) {
      try {
        var next = validateImport(JSON.parse(raw));
        store = next;
        saveStore();
        renderAll();
        toast('Imported ' + next.fillups.length + ' fill-ups. (Replaces the old log.)');
      } catch (err) { toast('Import failed: ' + err.message); }
    };
    if (file) {
      var reader = new FileReader();
      reader.onload = function () { apply(String(reader.result)); };
      reader.readAsText(file);
    } else if (text) {
      apply(text);
    } else {
      toast('Pick a file or paste JSON first.');
    }
  });
  el('sample-btn').addEventListener('click', function () {
    var sample = sampleStore();
    var added = 0;
    sample.fillups.forEach(function (f) {
      if (hasFillup(store, f.bike_key, f.date, f.odometer)) return; /* already there: tapping twice never doubles the log */
      try { addFillup(store, f); added++; } catch (e) { /* a sample row that collides with existing data is skipped, not forced */ }
    });
    saveStore();
    renderAll();
    toast(added ? 'Example fill-ups loaded on the 1995 Fat Boy.' : 'Example fill-ups are already in the log.');
  });
  el('clear-btn').addEventListener('click', function () {
    if (!window.confirm('Delete all fuel-log fill-ups? The shared bike roster is NOT touched — only this app\u2019s fill-ups go.')) return;
    store = emptyStore();
    saveStore();
    renderAll();
    toast('Fuel log cleared. Bikes are untouched.');
  });

  loadStore();
  el('f-date').value = todayISO();
  renderAll();
  if (SWUpdate) SWUpdate.init({ container: document.body });
}

if (typeof module !== 'undefined' && module.exports) {
  var BikeProfileModule = null;
  try { BikeProfileModule = require('./bike-profile.js'); } catch (e) { BikeProfileModule = null; }
  module.exports = {
    STORAGE_KEY: STORAGE_KEY, VERSION: VERSION,
    round2: round2, round1: round1, isDateISO: isDateISO, todayISO: todayISO,
    fmtMoney: fmtMoney, fmtMpg: fmtMpg, fmtCostPerMile: fmtCostPerMile,
    slugify: slugify, escapeHtml: escapeHtml,
    emptyStore: emptyStore, validateFillupFields: validateFillupFields,
    nextFillupId: nextFillupId, fillupsForBike: fillupsForBike,
    addFillup: addFillup, deleteFillup: deleteFillup, hasFillup: hasFillup,
    fillupRows: fillupRows, bikeStats: bikeStats, allBikeStats: allBikeStats,
    validateImport: validateImport,
    bikeFuelExport: bikeFuelExport, bikeFuelText: bikeFuelText,
    exportFilename: exportFilename, sampleStore: sampleStore,
    BikeProfile: BikeProfileModule
  };
}
