// PAOTY S2 — Organiser dashboard
(function () {
  const P = window.PAOTY, CFG = window.PAOTY_CONFIG || {};
  const API = (CFG.API_URL || '').trim();
  const TOP_N = CFG.TOP_N || 10;
  const $ = s => document.querySelector(s);
  let key = localStorage.getItem('paoty.adminKey') || sessionStorage.getItem('paoty.adminKey') || '';
  let ART = null;
  let D = null, juror = null, sortKey = 'mark', sortDir = 1, aq = '', pm = {};

  async function load(silent) {
    if (!API) { showGate('The site is not connected to the Google Sheet yet. Add the Web app URL in config.js.'); return false; }
    try {
      if (!silent) $('#upd').textContent = 'Loading…';
      const r = await fetch(`${API}?action=admin&key=${encodeURIComponent(key)}`);
      const j = await r.json();
      if (!j.ok) { showGate(j.error || 'Could not open the dashboard'); return false; }
      if (!ART) { try { ART = {}; (await (await fetch('data.json')).json()).forEach(d => ART[d.id] = d); } catch (e) { ART = null; } }
      D = j; pm = {};
      D.participants.forEach(p => { const a = (ART || {})[p.id] || {}; p.img = p.img || a.img || ''; p.desc = p.desc || a.desc || ''; pm[p.id] = p; });
      if (!juror || !D.jurors.includes(juror)) juror = D.jurors[0];
      $('#gate').classList.add('hidden'); $('#dash').classList.remove('hidden');
      $('#upd').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      render(); return true;
    } catch (e) {
      if (D) { $('#upd').textContent = 'Offline — showing last data'; return false; }
      showGate('Could not reach the Google Sheet. Check your connection.'); return false;
    }
  }
  function showGate(msg) {
    $('#dash').classList.add('hidden'); $('#gate').classList.remove('hidden');
    $('#gate-err').textContent = msg || '';
  }

  const state = () => Object.assign(P.emptyState(), D.states[juror] || {});
  const mark = (st, id) => P.hasMark(st, id) ? st.marks[id].v : null;
  const fullName = p => p ? `${p.first} ${p.last}`.trim() : '';

  function render() {
    // juror tabs
    $('#jurors').innerHTML = D.jurors.map(j => `<button class="tab ${j === juror ? 'active' : ''}" data-j="${P.esc(j)}">${P.esc(j)}</button>`).join('');
    $('#jurors').querySelectorAll('[data-j]').forEach(b => b.onclick = () => { juror = b.dataset.j; render(); });

    const st = state(), ranked = P.ranked(st), top = ranked.slice(0, TOP_N);
    const hist = D.history.filter(h => h.juror === juror).sort((a, b) => b.t - a.t);
    const last = hist[0];
    const f = st.final;
    const finalSame = f && JSON.stringify(f.top.map(x => x.id + ':' + x.v)) === JSON.stringify(top.map(id => id + ':' + mark(st, id)));

    $('#stats').innerHTML = `
      <div class="stat"><div class="k">Scored</div><div class="v">${ranked.length}<span class="muted" style="font-size:18px"> / ${D.participants.length}</span></div><div class="s">${D.participants.length - ranked.length} still to score</div></div>
      <div class="stat"><div class="k">Final Top 10</div><div class="v ${f ? (finalSame ? 'ok' : 'warn') : ''}">${f ? (finalSame ? 'Submitted' : 'Changed') : 'Not yet'}</div><div class="s">${f ? (finalSame ? P.when(f.t) : 'Edited after submitting on ' + P.when(f.t)) : 'Juror has not submitted yet'}</div></div>
      <div class="stat"><div class="k">Last activity</div><div class="v" style="font-size:20px;line-height:1.7">${last ? P.when(last.t) : '—'}</div><div class="s">${last ? P.esc(last.device || '') : 'No activity yet'}</div></div>
      <div class="stat"><div class="k">Changes made</div><div class="v">${hist.length}</div><div class="s">across ${new Set(hist.map(h => h.device)).size || 0} device(s)</div></div>`;

    $('#top-title').textContent = `Live Top ${TOP_N} — ${juror}`;
    $('#final-info').textContent = '';
    $('#top-body').innerHTML = top.length ? top.map((id, i) => {
      const p = pm[id] || {};
      return `<tr class="row" data-id="${id}"><td class="t-rank">${i + 1}</td><td class="t-img"><img src="${P.thumb(p.img)}" data-orig="${p.img}" alt="" loading="lazy"></td>
        <td class="t-id">${id}</td><td class="t-mark">${mark(st, id)}</td><td class="t-name">${P.esc(fullName(p))}</td><td>${P.esc(p.age)}</td>
        <td class="t-sub">${P.esc(p.state)}</td><td class="t-sub">${P.esc(p.phone)}</td><td class="t-sub">${P.esc(p.email)}</td><td class="t-title">${P.esc(p.title)}</td></tr>`;
    }).join('') : `<tr><td colspan="10" class="muted" style="padding:28px;text-align:center">No marks yet. The Top 10 fills in as ${P.esc(juror)} scores artworks.</td></tr>`;

    renderAll(st, ranked);

    $('#hist-count').textContent = `${hist.length} change${hist.length === 1 ? '' : 's'}`;
    $('#hist').innerHTML = hist.length ? hist.slice(0, 500).map(h => {
      const p = pm[h.id];
      let what;
      if (h.change === 'Marks changed') what = h.from === '' || h.from === null ? `scored <b class="id">${h.id}</b> → <b>${h.to}</b>` : `<b class="id">${h.id}</b> ${h.from} → <b>${h.to}</b>`;
      else if (h.change === 'Marks cleared') what = `cleared marks on <b class="id">${h.id}</b> (was ${h.from})`;
      else if (h.change === 'Tie order changed') what = `tie order <b class="id">${h.id}</b> #${h.from} → #${h.to}`;
      else if (h.change === 'Submitted final Top 10') what = `<b>Submitted final Top 10</b>`;
      else what = P.esc(h.change);
      return `<div class="h-item"><div class="tm">${P.when(h.t)}</div><div>${what}${p ? ` <span class="t-sub">· ${P.esc(fullName(p))}</span>` : ''}<div class="dv">${P.esc(h.device || '')}</div></div></div>`;
    }).join('') : '<div class="muted" style="padding:24px 4px">No changes yet.</div>';

    document.querySelectorAll('#dash img[data-orig]').forEach(img => P.imgFallback(img, img.dataset.orig));
  }

  function renderAll(st, ranked) {
    const rk = {}; ranked.forEach((id, i) => rk[id] = i + 1);
    const q = aq.trim().toLowerCase();
    let rows = D.participants.filter(p => !q || [p.id, fullName(p), p.title, p.state, p.email, p.phone].join(' ').toLowerCase().includes(q));
    const val = p => {
      const m = mark(st, p.id);
      switch (sortKey) {
        case 'rank': case 'mark': return rk[p.id] || 1e6;
        case 'id': return p.id;
        case 'name': return fullName(p).toLowerCase();
        case 'state': return (p.state || '').toLowerCase();
        case 't': return -(st.marks[p.id] ? st.marks[p.id].t : 0);
      }
      return m;
    };
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
    $('#all-body').innerHTML = rows.map(p => {
      const m = mark(st, p.id);
      return `<tr class="row" data-id="${p.id}"><td class="t-rank" style="font-size:17px">${rk[p.id] || '—'}</td>
        <td class="t-img"><img src="${P.thumb(p.img)}" data-orig="${p.img}" alt="" loading="lazy"></td>
        <td class="t-id">${p.id}</td><td class="t-mark">${m === null ? '<span class="muted" style="font-size:14px">—</span>' : m}</td>
        <td><div class="t-name">${P.esc(fullName(p))}</div><div class="t-sub">${P.esc(p.age)} yrs</div></td>
        <td class="t-sub">${P.esc(p.state)}</td><td class="t-title">${P.esc(p.title)}</td>
        <td class="t-sub">${st.marks[p.id] ? P.when(st.marks[p.id].t) : '—'}</td></tr>`;
    }).join('');
    document.querySelectorAll('#all-body img[data-orig]').forEach(img => P.imgFallback(img, img.dataset.orig));
  }

  function openModal(id) {
    const p = pm[id], st = state(), m = mark(st, id), r = P.ranked(st).indexOf(id) + 1;
    const eh = D.history.filter(h => h.juror === juror && h.id === id).sort((a, b) => b.t - a.t);
    $('#m-card').innerHTML = `
      <div class="m-art"><img src="${P.large(p.img)}" data-orig="${p.img}" alt="${P.esc(p.title)}" id="m-img"></div>
      <div class="m-info">
        <button class="icon-btn" id="m-close" aria-label="Close">✕</button>
        <div class="d-id">ENTRY ${id}</div>
        <h2 class="d-title" style="padding-right:44px">${P.esc(p.title)}</h2>
        <div class="m-mark"><span class="t-sub">${P.esc(juror)}</span><b>${m === null ? '—' : m}</b><span class="t-sub">/100 ${r ? `· Rank #${r}` : ''}</span></div>
        <dl class="kv">
          <dt>Artist</dt><dd><b>${P.esc(fullName(p))}</b></dd>
          <dt>Age</dt><dd>${P.esc(p.age)}</dd>
          <dt>State</dt><dd>${P.esc(p.state)}</dd>
          <dt>Phone</dt><dd><a href="tel:${P.esc(String(p.phone).replace(/\s/g, ''))}">${P.esc(p.phone)}</a></dd>
          <dt>Email</dt><dd><a href="mailto:${P.esc(p.email)}">${P.esc(p.email)}</a></dd>
          <dt>Submitted</dt><dd>${new Date(p.submitted).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          <dt>Payment</dt><dd>${P.esc(p.payment)} · ${P.esc(p.fee)}</dd>
        </dl>
        <div class="d-label">Description</div>
        <div class="d-desc" style="font-size:14px">${P.esc(p.desc) || '<span class="muted">No description</span>'}</div>
        ${eh.length ? `<div class="d-label" style="margin-top:16px">Marks history</div>${eh.map(h => `<div class="t-sub" style="padding:3px 0">${P.when(h.t)} — ${P.esc(h.change)}${h.from !== '' ? ` ${P.esc(h.from)} →` : ''} ${P.esc(h.to)}</div>`).join('')}` : ''}
      </div>`;
    const img = $('#m-img'); P.imgFallback(img, p.img);
    img.onclick = () => P.viewer.open([{ img: p.img, caption: `<b>${id}</b>${P.esc(p.title)} — ${P.esc(fullName(p))}` }], 0);
    $('#m-close').onclick = closeModal;
    $('#modal').classList.add('open'); document.body.classList.add('no-scroll');
  }
  function closeModal() { $('#modal').classList.remove('open'); document.body.classList.remove('no-scroll'); }

  function csv(rows) {
    return '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportTop() {
    const st = state(), top = P.ranked(st).slice(0, TOP_N);
    download(`PAOTY S2 Top ${TOP_N} - ${juror}.csv`, csv([['Rank', 'Order ID', 'Marks', 'First name', 'Last name', 'Age', 'State', 'Phone', 'Email', 'Artwork Title', 'Artwork Image'],
      ...top.map((id, i) => { const p = pm[id]; return [i + 1, id, mark(st, id), p.first, p.last, p.age, p.state, p.phone, p.email, p.title, p.img]; })]));
  }
  function exportAll() {
    const st = state(), rk = {}; P.ranked(st).forEach((id, i) => rk[id] = i + 1);
    const rows = [...D.participants].sort((a, b) => (rk[a.id] || 1e6) - (rk[b.id] || 1e6) || (a.id < b.id ? -1 : 1));
    download(`PAOTY S2 All Marks - ${juror}.csv`, csv([['Rank', 'Order ID', 'Marks', 'First name', 'Last name', 'Age', 'State', 'Phone', 'Email', 'Artwork Title', 'Last changed'],
      ...rows.map(p => [rk[p.id] || '', p.id, mark(st, p.id) ?? '', p.first, p.last, p.age, p.state, p.phone, p.email, p.title, st.marks[p.id] ? new Date(st.marks[p.id].t).toLocaleString() : ''])]));
  }

  // ---------- events ----------
  $('#gate-form').onsubmit = async e => {
    e.preventDefault(); key = $('#key').value.trim();
    $('#gate-err').textContent = 'Checking…';
    if (await load()) {
      if ($('#remember').checked) localStorage.setItem('paoty.adminKey', key);
      else sessionStorage.setItem('paoty.adminKey', key);
    }
  };
  $('#refresh').onclick = () => load();
  $('#logout').onclick = () => { localStorage.removeItem('paoty.adminKey'); sessionStorage.removeItem('paoty.adminKey'); key = ''; D = null; showGate(''); };
  $('#csv-top').onclick = exportTop;
  $('#csv-all').onclick = exportAll;
  $('#aq').oninput = e => { aq = e.target.value; renderAll(state(), P.ranked(state())); };
  document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort; sortDir = sortKey === k ? -sortDir : 1; sortKey = k;
    document.querySelectorAll('th[data-sort]').forEach(x => x.textContent = x.textContent.replace(/ [↑↓]$/, ''));
    th.textContent += sortDir === 1 ? ' ↓' : ' ↑';
    renderAll(state(), P.ranked(state()));
  });
  document.addEventListener('click', e => {
    const r = e.target.closest('tr.row'); if (r) openModal(r.dataset.id);
    if (e.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.viewer.open')) closeModal(); });
  setInterval(() => { if (D && document.visibilityState === 'visible') load(true); }, 30000);

  if (key) load(); else showGate('');
})();
