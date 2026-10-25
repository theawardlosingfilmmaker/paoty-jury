// Shared helpers for the jury app and the organiser dashboard
(function () {
  const P = {};

  // ---- images (Wix serves resized copies; fall back to the original) ----
  P.fileName = url => url.split('/').pop();
  P.thumb = url => `${url}/v1/fit/w_640,h_640,q_80/${P.fileName(url)}`;
  P.large = url => `${url}/v1/fit/w_2000,h_2000,q_88/${P.fileName(url)}`;
  P.imgFallback = (img, original) => {
    img.addEventListener('error', function onErr() {
      img.removeEventListener('error', onErr);
      if (img.src !== original) img.src = original;
    });
  };

  // ---- state: newest change wins, per artwork ----
  P.emptyState = () => ({ marks: {}, order: { list: [], t: 0 }, final: null });
  P.merge = (a, b) => {
    a = a || P.emptyState(); b = b || P.emptyState();
    const out = P.emptyState();
    const ids = new Set([...Object.keys(a.marks || {}), ...Object.keys(b.marks || {})]);
    ids.forEach(id => {
      const x = (a.marks || {})[id], y = (b.marks || {})[id];
      out.marks[id] = !x ? y : !y ? x : (y.t > x.t ? y : x);
    });
    const ao = a.order || { list: [], t: 0 }, bo = b.order || { list: [], t: 0 };
    out.order = bo.t > ao.t ? bo : ao;
    const af = a.final, bf = b.final;
    out.final = !af ? (bf || null) : !bf ? af : (bf.t > af.t ? bf : af);
    return out;
  };
  P.hasMark = (st, id) => !!(st.marks[id] && st.marks[id].v !== null && st.marks[id].v !== undefined);
  // All scored entries, best first. Same marks → juror's tie order, then entry number.
  P.ranked = st => {
    const pos = {}; (st.order.list || []).forEach((id, i) => pos[id] = i);
    return Object.keys(st.marks).filter(id => P.hasMark(st, id)).sort((x, y) =>
      (st.marks[y].v - st.marks[x].v) || ((pos[x] ?? 1e6) - (pos[y] ?? 1e6)) || (x < y ? -1 : 1));
  };

  // ---- formatting ----
  P.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  P.when = t => {
    if (!t) return '—';
    const d = new Date(t), now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + `, ${time}`;
  };
  P.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  P.device = () => {
    let d = localStorage.getItem('paoty.device');
    if (!d) {
      const ua = navigator.userAgent;
      const kind = /Android/i.test(ua) ? (/Mobile/i.test(ua) ? 'Android phone' : 'Android tablet')
        : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Windows/i.test(ua) ? 'Windows PC'
        : /Mac/i.test(ua) ? 'Mac' : 'Computer';
      d = `${kind} · ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      localStorage.setItem('paoty.device', d);
    }
    return d;
  };
  P.store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---- full-screen photo viewer with zoom & pan ----
  // open(list, index, opts) — list: [{img, caption}]
  P.viewer = (function () {
    let root, stage, img, cap, count, list = [], idx = 0, s = 1, tx = 0, ty = 0, onIndex = null;
    const ptrs = new Map(); let pinch = null, drag = null, lastTap = 0, swipeStart = null;

    function build() {
      root = document.createElement('div');
      root.className = 'viewer'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Artwork viewer');
      root.innerHTML = `
        <div class="v-stage"><img class="v-img" alt="" draggable="false"></div>
        <div class="v-top">
          <div class="v-cap"></div>
          <div class="v-tools">
            <button class="v-btn" data-a="out" aria-label="Zoom out">−</button>
            <button class="v-btn v-zoom" data-a="reset" aria-label="Reset zoom">100%</button>
            <button class="v-btn" data-a="in" aria-label="Zoom in">+</button>
            <button class="v-btn" data-a="fs" aria-label="Full screen" title="Full screen">⛶</button>
            <button class="v-btn v-close" data-a="close" aria-label="Close">✕</button>
          </div>
        </div>
        <button class="v-nav v-prev" data-a="prev" aria-label="Previous artwork">‹</button>
        <button class="v-nav v-next" data-a="next" aria-label="Next artwork">›</button>
        <div class="v-hint"><span class="long">Scroll or pinch to zoom · double-click to zoom · drag to move · ← → for next</span><span class="short">Pinch or double-tap to zoom · swipe for next</span></div>
        <div class="v-count"></div>`;
      document.body.appendChild(root);
      stage = root.querySelector('.v-stage'); img = root.querySelector('.v-img');
      cap = root.querySelector('.v-cap'); count = root.querySelector('.v-count');
      root.addEventListener('click', e => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        const act = a.dataset.a, r = stage.getBoundingClientRect();
        if (act === 'in') zoomAt(r.width / 2, r.height / 2, s * 1.5);
        if (act === 'out') zoomAt(r.width / 2, r.height / 2, s / 1.5);
        if (act === 'reset') reset();
        if (act === 'fs') toggleFs();
        if (act === 'close') close();
        if (act === 'prev') go(-1);
        if (act === 'next') go(1);
      });
      stage.addEventListener('wheel', e => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, s * Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });
      stage.addEventListener('pointerdown', down);
      stage.addEventListener('pointermove', move);
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => stage.addEventListener(t, up));
      stage.addEventListener('dblclick', e => { e.preventDefault(); });
      document.addEventListener('keydown', e => {
        if (!root.classList.contains('open')) return;
        if (e.key === 'Escape') { if (document.fullscreenElement) return; close(); }
        if (e.key === 'ArrowLeft') go(-1);
        if (e.key === 'ArrowRight') go(1);
        if (e.key === '+' || e.key === '=') { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, s * 1.4); }
        if (e.key === '-') { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, s / 1.4); }
        if (e.key === '0') reset();
      });
    }

    function apply() {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      root.querySelector('.v-zoom').textContent = Math.round(s * 100) + '%';
      root.classList.toggle('zoomed', s > 1.01);
    }
    function clamp() {
      const r = stage.getBoundingClientRect();
      const w = img.offsetWidth * s, h = img.offsetHeight * s;
      const mx = Math.max(0, (w - r.width) / 2 + 40), my = Math.max(0, (h - r.height) / 2 + 40);
      tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
    }
    // zoom keeping the point (px, py) — relative to stage — fixed
    function zoomAt(px, py, ns) {
      ns = Math.min(8, Math.max(1, ns));
      const r = stage.getBoundingClientRect();
      const cx = px - r.width / 2, cy = py - r.height / 2;
      tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns;
      if (s === 1) { tx = 0; ty = 0; }
      clamp(); apply();
    }
    function reset() { s = 1; tx = 0; ty = 0; apply(); }

    function down(e) {
      stage.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s }; drag = null; swipeStart = null;
      } else if (ptrs.size === 1) {
        drag = { x: e.clientX, y: e.clientY, tx, ty }; swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        const now = Date.now();
        if (now - lastTap < 300) {
          const r = stage.getBoundingClientRect();
          s > 1.01 ? reset() : zoomAt(e.clientX - r.left, e.clientY - r.top, 2.5);
          lastTap = 0; drag = null; swipeStart = null;
        } else lastTap = now;
      }
    }
    function move(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], r = stage.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.s * d / pinch.d);
      } else if (drag && s > 1.01) {
        tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); clamp(); apply();
      }
    }
    function up(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (swipeStart && s <= 1.01 && e.type === 'pointerup') {
        const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - swipeStart.t < 600) go(dx < 0 ? 1 : -1);
      }
      if (!ptrs.size) { drag = null; swipeStart = null; }
    }

    function show() {
      const it = list[idx];
      reset();
      img.classList.add('loading');
      img.onload = () => img.classList.remove('loading');
      img.src = P.large(it.img); P.imgFallback(img, it.img);
      img.alt = it.alt || '';
      cap.innerHTML = it.caption || '';
      count.textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : '';
      root.classList.toggle('single', list.length < 2);
      if (onIndex) onIndex(idx);
    }
    function go(d) { if (list.length < 2) return; idx = (idx + d + list.length) % list.length; show(); }
    function toggleFs() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    }
    function open(l, i, opts = {}) {
      if (!root) build();
      list = l; idx = i || 0; onIndex = opts.onIndex || null;
      root.classList.add('open'); document.body.classList.add('no-scroll');
      show();
    }
    function close() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      root.classList.remove('open'); document.body.classList.remove('no-scroll');
      img.src = ''; if (P.viewer.onClose) P.viewer.onClose(idx);
    }
    return { open, close };
  })();

  window.PAOTY = P;
})();
