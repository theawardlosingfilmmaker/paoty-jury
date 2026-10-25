// PAOTY S2 — Jury app
(function () {
  const P = window.PAOTY, CFG = window.PAOTY_CONFIG || {};
  const API = (CFG.API_URL || '').trim();
  const TOP_N = CFG.TOP_N || 10;
  const DEVICE = P.device();
  // secret jury code from the link (?k=...), remembered on this device
  const urlK = new URLSearchParams(location.search).get('k');
  if (urlK) localStorage.setItem('paoty.k', urlK.trim());
  const K = localStorage.getItem('paoty.k') || '';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  let DATA = [], byId = {};
  let juror = null, st = P.emptyState(), queue = [], log = [], serverHist = [];
  let view = 'art', filter = 'all', sortBy = 'id', query = '';
  let dList = [], dIdx = -1;               // detail navigation
  const pending = {};                      // mark edits waiting to be logged
  let syncing = false, syncAgain = false, syncTimer = null, lastSync = 0, syncState = 'idle';

  // ---------- boot ----------
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    try {
      const r = await fetch('data.json', { cache: 'no-cache' });
      DATA = await r.json();
    } catch (e) {
      document.body.innerHTML = '<div class="picker"><h1>Could not load entries</h1><p>Please check your connection and reload.</p></div>';
      return;
    }
    DATA.forEach(d => byId[d.id] = d);
    if (API) {
      if (!K) return showLocked();
      if (navigator.onLine) {
        try {
          const r = await fetch(`${API}?action=check&k=${encodeURIComponent(K)}`);
          const j = await r.json();
          if (!j.ok && j.error === 'LOCKED') { localStorage.removeItem('paoty.k'); return showLocked(); }
        } catch (e) { /* offline or blocked — continue with saved code */ }
      }
    }
    const saved = localStorage.getItem('paoty.juror');
    if (saved && (CFG.JURORS || []).includes(saved)) enter(saved); else showPicker();
    bindUI();
  }

  function showLocked() {
    $('#app').classList.add('hidden'); $('#picker').classList.add('hidden'); $('#locked').classList.remove('hidden');
  }

  // ---------- profile picker ----------
  function initials(n) { return n.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
  function showPicker() {
    $('#app').classList.add('hidden'); $('#picker').classList.remove('hidden');
    $('#profiles').innerHTML = (CFG.JURORS || []).map(n => {
      const s = P.store.get('paoty.state.' + n, null);
      const done = s ? Object.keys(s.marks || {}).filter(id => s.marks[id] && s.marks[id].v != null).length : 0;
      return `<button class="profile" data-j="${P.esc(n)}"><div class="av">${initials(n)}</div><span>${P.esc(n)}</span>
        <small>${done ? `${done} of ${DATA.length} scored` : 'Jury member'}</small></button>`;
    }).join('');
    $$('#profiles .profile').forEach(b => b.onclick = () => enter(b.dataset.j));
  }

  function enter(name) {
    juror = name; localStorage.setItem('paoty.juror', name);
    st = Object.assign(P.emptyState(), P.store.get('paoty.state.' + name, {}));
    queue = P.store.get('paoty.queue.' + name, []);
    log = P.store.get('paoty.log.' + name, []);
    $('#picker').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#who .av').textContent = initials(name); $('#who span:last-child').textContent = name;
    $('#local-banner').classList.toggle('hidden', !!API);
    renderAll();
    sync(); loadHistory();
    setTimeout(saveForOffline, 1500);
  }

  // ---------- persistence ----------
  function persist() {
    P.store.set('paoty.state.' + juror, st);
    P.store.set('paoty.queue.' + juror, queue);
    P.store.set('paoty.log.' + juror, log.slice(-500));
  }
  function addEvent(ev) {
    ev.eid = P.uid(); ev.t = ev.t || Date.now(); ev.device = DEVICE;
    queue.push(ev); log.push(ev); persist(); scheduleSync();
    if (view === 'hist') renderHist();
  }

  // ---------- marks ----------
  const markOf = id => P.hasMark(st, id) ? st.marks[id].v : null;
  function setMark(id, v) {
    if (v !== null) v = Math.max(0, Math.min(100, Math.round(v)));
    const before = markOf(id);
    if (before === v) return;
    if (!pending[id]) pending[id] = { from: before };
    st.marks[id] = { v, t: Date.now() };
    persist();
    clearTimeout(pending[id].timer);
    pending[id].timer = setTimeout(() => commitEdit(id), 1200);
    flashSaved();
    refreshAfterMark(id);
  }
  function commitEdit(id) {
    const p = pending[id]; if (!p) return;
    clearTimeout(p.timer); delete pending[id];
    const to = markOf(id);
    if (p.from === to) return;
    addEvent({ type: to === null ? 'clear' : 'mark', id, from: p.from, to });
  }
  function flushEdits() { Object.keys(pending).forEach(commitEdit); }

  function moveTie(id, dir) {
    const list = P.ranked(st), i = list.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length || markOf(list[j]) !== markOf(id)) return;
    [list[i], list[j]] = [list[j], list[i]];
    st.order = { list, t: Date.now() };
    addEvent({ type: 'reorder', id, from: i + 1, to: j + 1 });
    renderTop(id); renderGrid(); updateCounts();
  }

  // ---------- sync ----------
  function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
  function setSync(kind, text) {
    syncState = kind;
    const el = $('#sync'); el.className = 'sync ' + kind; el.querySelector('.lbl').textContent = text; el.title = text;
  }
  async function sync() {
    if (!juror) return;
    if (!API) { setSync('off', 'Saved on this device'); return; }
    if (!navigator.onLine) { setSync('off', queue.length ? 'Offline · saved on device' : 'Offline'); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true; setSync('busy', 'Syncing…');
    const sent = queue.slice(), sentIds = new Set(sent.map(e => e.eid));
    try {
      const res = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'sync', k: K, juror, state: st, events: sent, device: DEVICE })
      });
      const j = await res.json();
      if (!j.ok && j.error === 'LOCKED') { localStorage.removeItem('paoty.k'); showLocked(); return; }
      if (!j.ok) throw new Error(j.error || 'Sync failed');
      const before = JSON.stringify(st);
      st = P.merge(st, j.state);
      queue = queue.filter(e => !sentIds.has(e.eid));
      persist(); lastSync = Date.now();
      setSync('ok', 'Synced · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      if (JSON.stringify(st) !== before) renderAll(true);
      if (sent.length) loadHistory();
    } catch (e) {
      setSync('off', 'Offline · saved on device');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(300); }
    }
  }
  async function loadHistory() {
    if (!API || !navigator.onLine) return;
    try {
      const r = await fetch(`${API}?action=history&k=${encodeURIComponent(K)}&juror=${encodeURIComponent(juror)}`);
      const j = await r.json();
      if (j.ok) {
        serverHist = j.history || [];
        // keep the device's copy in step with the sheet: drop synced entries the sheet no longer has
        const onServer = new Set(serverHist.map(e => e.eid)), waiting = new Set(queue.map(e => e.eid));
        const before = log.length;
        log = log.filter(e => onServer.has(e.eid) || waiting.has(e.eid));
        if (log.length !== before) persist();
        if (view === 'hist') renderHist();
      }
    } catch (e) {}
  }
  setInterval(() => { if (juror && document.visibilityState === 'visible') sync(); }, 25000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
    else flushEdits();
  });
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => setSync('off', 'Offline · saved on device'));
  window.addEventListener('pagehide', flushEdits);

  // ---------- rendering ----------
  function renderAll(fromSync) {
    updateCounts(); renderGrid();
    if (view === 'top') renderTop();
    if (view === 'hist') renderHist();
    if (dIdx >= 0 && fromSync) renderScore(dList[dIdx], true);
  }
  function scoredCount() { return DATA.filter(d => P.hasMark(st, d.id)).length; }
  function updateCounts() {
    const n = scoredCount(), total = DATA.length;
    $('#prog-bar').style.width = (total ? n / total * 100 : 0) + '%';
    $('#prog-txt').textContent = `${n} of ${total} scored`;
    $('#pill-art').textContent = `${n} of ${total} scored`;
    $('#pill-art-m').textContent = `${n}/${total}`;
    updateTopPill();
  }
  function topIds() { return P.ranked(st).slice(0, TOP_N); }
  function updateTopPill() { const el = $('#pill-top'); if (el) { const k = Math.min(TOP_N, P.ranked(st).length); el.textContent = st.final ? 'Submitted · ' + k + ' ranked' : k + ' of ' + TOP_N + ' filled'; } }

  function currentList() {
    const q = query.trim().toLowerCase();
    let list = DATA.filter(d => {
      const has = P.hasMark(st, d.id);
      if (filter === 'todo' && has) return false;
      if (filter === 'done' && !has) return false;
      if (q && !(d.id.toLowerCase().includes(q.replace(/^#?/, '#')) || d.id.includes(q) || d.title.toLowerCase().includes(q))) return false;
      return true;
    });
    if (sortBy === 'id') list.sort((a, b) => a.id < b.id ? -1 : 1);
    else {
      const rk = {}; P.ranked(st).forEach((id, i) => rk[id] = i);
      list.sort((a, b) => {
        const ha = P.hasMark(st, a.id), hb = P.hasMark(st, b.id);
        if (ha !== hb) return ha ? -1 : 1;
        if (!ha) return a.id < b.id ? -1 : 1;
        return sortBy === 'high' ? rk[a.id] - rk[b.id] : rk[b.id] - rk[a.id];
      });
    }
    return list;
  }

  function cardHTML(d, rank) {
    const m = markOf(d.id);
    return `<button class="card" data-id="${d.id}" aria-label="Entry ${d.id}, ${P.esc(d.title)}">
      <div class="ph"><img loading="lazy" src="${P.thumb(d.img)}" data-orig="${d.img}" alt=""></div>
      ${rank ? `<span class="rank-badge">Top 10 · #${rank}</span>` : ''}
      ${m === null ? '<span class="mark-badge none">Not scored</span>' : `<span class="mark-badge">${m}<small>/100</small></span>`}
      <div class="meta"><span class="id">ENTRY ${d.id}</span><span class="ttl">${P.esc(d.title)}</span></div>
    </button>`;
  }
  function renderGrid() {
    const list = currentList(), top = topIds();
    const g = $('#grid');
    if (!list.length) {
      g.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>${filter === 'todo' ? 'All entries are scored 🎉' : 'Nothing here'}</b>${filter === 'todo' ? 'Check your Top 10 tab.' : 'Try a different filter or search.'}</div>`;
      return;
    }
    g.innerHTML = list.map(d => cardHTML(d, top.indexOf(d.id) + 1)).join('');
    g.querySelectorAll('img').forEach(img => P.imgFallback(img, img.dataset.orig));
  }
  function refreshAfterMark(id) {
    updateCounts();
    // update just the affected cards' badges without rebuilding (keeps scroll position)
    const top = topIds();
    $$('#grid .card').forEach(c => {
      const d = byId[c.dataset.id], rank = top.indexOf(d.id) + 1, m = markOf(d.id);
      const mb = c.querySelector('.mark-badge'), rb = c.querySelector('.rank-badge');
      mb.className = 'mark-badge' + (m === null ? ' none' : '');
      mb.innerHTML = m === null ? 'Not scored' : `${m}<small>/100</small>`;
      if (rank && !rb) c.querySelector('.ph').insertAdjacentHTML('afterend', `<span class="rank-badge">Top 10 · #${rank}</span>`);
      else if (rank && rb) rb.textContent = `Top 10 · #${rank}`;
      else if (!rank && rb) rb.remove();
    });
    renderStanding(id);
    if (view === 'top') renderTop();
  }

  function renderTop(flashId) {
    const all = P.ranked(st), top = all.slice(0, TOP_N);
    const rows = top.map((id, i) => {
      const d = byId[id], m = markOf(id);
      const upTie = i > 0 && markOf(all[i - 1]) === m, downTie = i < all.length - 1 && i < TOP_N && markOf(all[i + 1]) === m;
      const tieNote = (upTie || downTie) ? `<div class="tie">Tied at ${m} — use the arrows to set the order</div>` : '';
      const btns = (upTie || downTie) ? `<button data-mv="-1" data-id="${id}" ${upTie ? '' : 'disabled'} aria-label="Move up">▲</button><button data-mv="1" data-id="${id}" ${downTie ? '' : 'disabled'} aria-label="Move down">▼</button>` : '';
      return `<div class="rank-item ${flashId === id ? 'flash' : ''}" data-id="${id}">
        <div class="rank-no">${i + 1}</div>
        <div class="th" data-zoom="${i}"><img src="${P.thumb(d.img)}" data-orig="${d.img}" alt=""></div>
        <div class="info" data-open="${id}"><div class="id">ENTRY ${id}</div><div class="ttl">${P.esc(d.title)}</div>${tieNote}</div>
        <div class="rank-mark">${m}<small>/100</small></div>
        <div class="tie-btns">${btns}</div>
      </div>`;
    });
    for (let i = top.length; i < TOP_N; i++) rows.push(`<div class="rank-empty-slot"><div class="rank-no">${i + 1}</div><div>Empty — score more artworks to fill this spot</div></div>`);
    $('#ranks').innerHTML = rows.join('');
    $$('#ranks img').forEach(img => P.imgFallback(img, img.dataset.orig));

    const rest = all.slice(TOP_N);
    const more = $('#more');
    more.classList.toggle('hidden', !rest.length);
    more.innerHTML = rest.length ? `<h3>Also scored (${rest.length})</h3><div class="mini-list">${rest.map((id, k) => {
      const d = byId[id];
      return `<div class="mini-row" data-open="${id}"><span class="n">${TOP_N + k + 1}</span><img src="${P.thumb(d.img)}" alt="" loading="lazy"><span class="t"><b>${id}</b>${P.esc(d.title)}</span><span class="m">${markOf(id)}</span></div>`;
    }).join('')}</div>` : '';

    // final submission note
    const f = st.final, note = $('#final-note');
    $('#submit-final').disabled = !top.length;
    if (!f) { note.innerHTML = ''; $('#submit-final').textContent = 'Submit final Top 10'; $('#submit-final').classList.remove('done'); return; }
    const same = JSON.stringify(f.top.map(x => x.id + ':' + x.v)) === JSON.stringify(top.map(id => id + ':' + markOf(id)));
    $('#submit-final').textContent = same ? 'Submitted ✓' : 'Submit updated Top 10';
    $('#submit-final').disabled = same;
    $('#submit-final').classList.toggle('done', same);
    note.innerHTML = same
      ? `<div class="final-note">✓ Final Top 10 submitted · ${P.when(f.t)}</div>`
      : `<div class="final-note changed">You've changed your list since submitting on ${P.when(f.t)}. Submit again to update it.</div>`;
  }

  function evText(e) {
    const id = e.id ? `<b>${P.esc(e.id)}</b> ` : '';
    const type = e.type || ({ 'Marks changed': 'mark', 'Marks cleared': 'clear', 'Tie order changed': 'reorder', 'Submitted final Top 10': 'final' })[e.change];
    const from = e.from === '' || e.from === null || e.from === undefined ? null : Number(e.from);
    const to = e.to === '' || e.to === null || e.to === undefined ? null : e.to;
    if (type === 'mark') {
      if (from === null) return `${id}scored <b>${to}</b>`;
      const up = Number(to) > from;
      return `${id}${from} → <b>${to}</b> <span class="${up ? 'delta-up' : 'delta-down'}">${up ? '▲' : '▼'} ${Math.abs(to - from)}</span>`;
    }
    if (type === 'clear') return `${id}marks cleared (was ${from})`;
    if (type === 'reorder') return `${id}tie order: #${from} → #${to}`;
    if (type === 'final') return `Submitted final Top 10`;
    return P.esc(e.change || type);
  }
  function renderHist() {
    const seen = new Set(), rows = [];
    [...serverHist, ...log].forEach(e => { if (!e.eid || seen.has(e.eid)) return; seen.add(e.eid); rows.push(e); });
    rows.sort((a, b) => b.t - a.t);
    const unsynced = new Set(queue.map(e => e.eid));
    $('#timeline').innerHTML = rows.length ? rows.slice(0, 400).map(e => `
      <div class="tl-row"><div class="tl-time">${P.when(e.t)}</div><div class="tl-dot"></div>
        <div class="tl-card"><div class="what">${evText(e)}</div><div class="sub">${P.esc(e.device || '')}${unsynced.has(e.eid) ? ' · waiting to sync' : ''}</div></div></div>`).join('')
      : '<div class="empty"><b>No changes yet</b>Your marks and ranking changes will appear here.</div>';
  }

  // ---------- detail ----------
  function openDetail(id, list) {
    dList = (list || currentList().map(d => d.id));
    if (!dList.includes(id)) dList = DATA.map(d => d.id);
    dIdx = dList.indexOf(id);
    $('#detail').classList.add('open'); document.body.classList.add('no-scroll');
    if (location.hash !== '#entry') history.pushState({ entry: 1 }, '', '#entry');
    showDetail();
  }
  function showDetail() {
    const id = dList[dIdx], d = byId[id];
    const img = $('#d-img');
    img.classList.add('loading'); img.onload = () => img.classList.remove('loading');
    img.src = P.large(d.img); P.imgFallback(img, d.img); img.alt = d.title;
    $('#d-id').textContent = 'ENTRY ' + id;
    $('#d-title').textContent = d.title;
    const desc = $('#d-desc');
    desc.textContent = d.desc || 'No description was provided for this artwork.';
    desc.classList.toggle('empty-desc', !d.desc);
    $('#d-pos').textContent = `${dIdx + 1} of ${dList.length}`;
    $('#d-prev').disabled = dIdx <= 0; $('#d-next').disabled = dIdx >= dList.length - 1;
    $('.d-body').scrollTop = 0;
    renderScore(id);
  }
  function renderScore(id, soft) {
    if (soft && (pending[id] || document.activeElement === $('#s-input'))) return;
    const m = markOf(id);
    $('#s-input').value = m === null ? '' : m;
    $('#s-range').value = m === null ? 50 : m;
    $('#s-range').style.opacity = m === null ? .45 : 1;
    $('#s-clear').classList.toggle('hidden', m === null);
    renderStanding(id);
  }
  function renderStanding(id) {
    if (dIdx < 0 || dList[dIdx] !== id) return;
    const m = markOf(id), el = $('#s-standing');
    $('#s-clear').classList.toggle('hidden', m === null);
    if (m === null) { el.textContent = 'Not scored yet'; return; }
    const r = P.ranked(st).indexOf(id) + 1;
    el.innerHTML = r <= TOP_N ? `Currently <b>#${r}</b> in your Top 10` : `Ranked #${r} — outside your Top 10`;
  }
  function closeDetail(fromPop) {
    flushEdits();
    $('#detail').classList.remove('open'); document.body.classList.remove('no-scroll');
    $('#d-img').src = '';
    const last = dList[dIdx]; dIdx = -1;
    if (!fromPop && location.hash === '#entry') history.back();
    renderGrid(); if (view === 'top') renderTop();
    const c = document.querySelector(`.card[data-id="${CSS.escape(last || '')}"]`);
    if (c && view === 'art') c.scrollIntoView({ block: 'nearest' });
  }
  function stepDetail(dir) {
    const n = dIdx + dir; if (n < 0 || n >= dList.length) return;
    flushEdits(); dIdx = n; showDetail();
  }
  let savedTimer;
  function flashSaved() {
    const s = $('#s-saved'); s.classList.add('show'); clearTimeout(savedTimer);
    savedTimer = setTimeout(() => s.classList.remove('show'), 1400);
  }

  // ---------- viewer ----------
  function openViewer(ids, i) {
    const list = ids.map(id => ({ img: byId[id].img, alt: byId[id].title, caption: `<b>${id}</b>${P.esc(byId[id].title)}` }));
    P.viewer.open(list, i, { onIndex: k => { if (dIdx >= 0 && ids === dList && k !== dIdx) { flushEdits(); dIdx = k; showDetail(); } } });
  }

  // ---------- views ----------
  function go(v) {
    view = v;
    ['art', 'top', 'hist'].forEach(k => $('#v-' + k).classList.toggle('hidden', k !== v));
    $$('[data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === v && b.classList.contains('tab')));
    if (v === 'top') renderTop();
    if (v === 'hist') { renderHist(); loadHistory(); }
    window.scrollTo({ top: 0 });
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- offline photos ----------
  async function saveForOffline() {
    const chip = $('#dl');
    if (!('caches' in window) || !navigator.onLine) return;
    const urls = DATA.flatMap(d => [P.thumb(d.img), P.large(d.img)]);
    let done = 0;
    try {
      const c = await caches.open('paoty-art');
      const update = () => { chip.innerHTML = done < urls.length ? `⬇ Saving artworks for offline viewing… ${Math.round(done / urls.length * 100)}%` : `✓ All ${DATA.length} artworks are saved on this device for offline viewing`; };
      update();
      let i = 0;
      async function worker() {
        while (i < urls.length) {
          const u = urls[i++];
          try {
            if (!(await c.match(u, { ignoreVary: true }))) {
              const r = await fetch(u, { mode: 'no-cors' });
              if (r && (r.ok || r.type === 'opaque')) await c.put(u, r);
            }
          } catch (e) {}
          done++; if (done % 6 === 0 || done === urls.length) update();
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch (e) { chip.innerHTML = ''; }
  }

  // ---------- events ----------
  function bindUI() {
    document.addEventListener('click', e => {
      const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); return; }
      const card = e.target.closest('.card'); if (card) { openDetail(card.dataset.id); return; }
      const mv = e.target.closest('[data-mv]'); if (mv) { moveTie(mv.dataset.id, Number(mv.dataset.mv)); return; }
      const z = e.target.closest('[data-zoom]'); if (z) { openViewer(topIds(), Number(z.dataset.zoom)); return; }
      const o = e.target.closest('[data-open]'); if (o) {
        const ids = view === 'top' ? P.ranked(st) : null; openDetail(o.dataset.open, ids); return;
      }
    });
    $('#who').onclick = () => { flushEdits(); persist(); juror = null; localStorage.removeItem('paoty.juror'); showPicker(); };
    $$('#filter button').forEach(b => b.onclick = () => {
      filter = b.dataset.f; $$('#filter button').forEach(x => x.classList.toggle('active', x === b)); renderGrid();
    });
    $('#sort').onchange = e => { sortBy = e.target.value; renderGrid(); };
    $('#q').oninput = e => { query = e.target.value; renderGrid(); };

    // detail
    $('#d-close').onclick = () => closeDetail();
    $('#d-prev').onclick = () => stepDetail(-1);
    $('#d-next').onclick = () => stepDetail(1);
    $('#d-img').onclick = () => openViewer(dList, dIdx);
    const cur = () => dList[dIdx];
    $('#s-range').oninput = e => { setMark(cur(), Number(e.target.value)); $('#s-input').value = e.target.value; $('#s-range').style.opacity = 1; };
    $('#s-input').oninput = e => {
      const raw = e.target.value;
      if (raw === '') return;
      let v = Number(raw); if (isNaN(v)) return;
      if (v > 100) { v = 100; e.target.value = 100; }
      setMark(cur(), v); $('#s-range').value = v; $('#s-range').style.opacity = 1;
    };
    $('#s-input').onkeydown = e => { if (e.key === 'Enter') { e.target.blur(); } };
    $('#s-input').onblur = () => renderScore(cur());
    $('#s-plus').onclick = () => { const m = markOf(cur()); setMark(cur(), m === null ? 50 : m + 1); renderScore(cur()); };
    $('#s-minus').onclick = () => { const m = markOf(cur()); setMark(cur(), m === null ? 50 : m - 1); renderScore(cur()); };
    $('#s-clear').onclick = () => { setMark(cur(), null); renderScore(cur()); };

    document.addEventListener('keydown', e => {
      if (dIdx < 0 || document.querySelector('.viewer.open')) return;
      const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'number';
      if (e.key === 'Escape') closeDetail();
      if (!typing && e.key === 'ArrowLeft') stepDetail(-1);
      if (!typing && e.key === 'ArrowRight') stepDetail(1);
    });
    window.addEventListener('popstate', () => {
      if (document.querySelector('.viewer.open')) { P.viewer.close(); if (dIdx >= 0) history.pushState({ entry: 1 }, '', '#entry'); return; }
      if (dIdx >= 0 && location.hash !== '#entry') closeDetail(true);
    });

    $('#submit-final').onclick = () => {
      const top = topIds();
      if (!top.length) return;
      const missing = DATA.length - scoredCount();
      const msg = missing ? `You still have ${missing} unscored artwork${missing > 1 ? 's' : ''}. Submit your Top ${top.length} anyway?` : `Submit your Top ${top.length} as final?`;
      if (!confirm(msg)) return;
      flushEdits();
      st.final = { t: Date.now(), top: top.map(id => ({ id, v: markOf(id) })) };
      addEvent({ type: 'final', id: '', from: '', to: top.join(', ') });
      persist(); renderTop(); sync();
      toast('Top 10 submitted. Thank you!');
    };
  }

  boot();
})();
