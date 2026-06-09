// NAGA ARENA admin screen: polls /api/admin/history and renders 24h activity.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token');
  const url = '/api/admin/history' + (token ? '?token=' + encodeURIComponent(token) : '');

  function fmtTime(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function card(k, v, accent) { return `<div class="card"><div class="k">${k}</div><div class="v${accent ? ' accent' : ''}">${v}</div></div>`; }

  function drawChart(samples) {
    const cv = $('chart'), g = cv.getContext('2d');
    // Match the canvas backing store to its displayed size for crisp lines.
    const w = cv.clientWidth || 900, h = cv.height; cv.width = w;
    g.clearRect(0, 0, w, h);
    if (!samples.length) { $('chart-note').textContent = 'No data yet.'; return; }
    const now = Date.now(), start = now - 24 * 3600 * 1000;
    const maxY = Math.max(2, ...samples.map((s) => s.humans));
    const X = (t) => ((t - start) / (now - start)) * (w - 40) + 30;
    const Y = (v) => h - 24 - (v / maxY) * (h - 40);
    // axes / gridlines
    g.strokeStyle = 'rgba(40,60,96,0.6)'; g.lineWidth = 1; g.fillStyle = '#7f8aa3'; g.font = '11px system-ui';
    for (let i = 0; i <= maxY; i += Math.max(1, Math.ceil(maxY / 4))) {
      g.beginPath(); g.moveTo(30, Y(i)); g.lineTo(w - 10, Y(i)); g.stroke();
      g.fillText(String(i), 4, Y(i) + 3);
    }
    // humans line
    g.strokeStyle = '#39ff14'; g.lineWidth = 2; g.beginPath();
    samples.forEach((s, i) => { const x = X(s.t), y = Y(s.humans); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    // bots line
    g.strokeStyle = '#0a84ff'; g.lineWidth = 1.5; g.beginPath();
    samples.forEach((s, i) => { const x = X(s.t), y = Y(s.bots); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    $('chart-note').innerHTML = '<span style="color:#39ff14">● players</span> &nbsp; <span style="color:#0a84ff">● bots</span> &nbsp; (sampled every minute)';
  }

  function renderTable(samples) {
    // Only show samples with some activity; hide the whole panel if all are 0.
    const rows = samples.filter((s) => s.humans || s.rooms || s.bots);
    const panel = $('samples-panel');
    if (!rows.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    const tb = $('table').querySelector('tbody');
    tb.innerHTML = rows.slice(-30).reverse().map((s) =>
      `<tr><td>${fmtTime(s.t)}</td><td>${s.humans}</td><td>${s.rooms}</td><td>${s.bots}</td></tr>`).join('');
  }

  async function load() {
    try {
      const res = await fetch(url);
      if (res.status === 403) { $('status').innerHTML = '<span class="err">Forbidden — append ?token=YOUR_TOKEN to the URL.</span>'; return; }
      const d = await res.json();
      $('status').textContent = 'Updated ' + fmtTime(d.now);
      $('cards').innerHTML =
        card('PLAYERS NOW', d.current.humans, true) +
        card('ROOMS NOW', d.current.rooms) +
        card('BOTS NOW', d.current.bots) +
        card('PEAK PLAYERS (24h)', d.peakHumans24h) +
        card('JOINS (24h)', d.joins24h) +
        card('LEAVES (24h)', d.leaves24h);
      drawChart(d.samples || []);
      renderTable(d.samples || []);
    } catch (e) {
      $('status').innerHTML = '<span class="err">Failed to load history.</span>';
    }
  }
  load();
  setInterval(load, 15000);
  window.addEventListener('resize', load);
})();
