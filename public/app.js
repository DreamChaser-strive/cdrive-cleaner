'use strict';

(() => {
  const TOKEN = window.__CLEANER_TOKEN__ || '';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const escapeHtml = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const state = {
    path: 'C:\\',
    data: null,
    overview: null,
    currentItems: [],
    itemsByKey: new Map(),
    selected: null,
    checked: new Map(),
    hovered: null,
    hitRects: [],
    nesting: true,
    loading: false,
    scanning: false,
    scanProgress: null,
    pendingScanReload: false,
    wasScanning: false,
    liveVersion: 0,
    refreshingLive: false,
    pollTimer: null,
    searchResults: [],
    searchIndex: -1,
    searchTimer: null,
    deleteMode: 'recycle',
    deleteItems: [],
    deleteBusy: false,
    suggestItems: [],
    suggestChecked: new Set(),
    suggestBigDirs: [],
    suggestSystem: [],
  };

  const canvas = $('#treemap');
  const ctx = canvas.getContext('2d');
  const holder = $('#canvasHolder');
  const tooltip = $('#tooltip');

  // ---------- 工具函数 ----------
  function fmtBytes(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return Math.round(n) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    let dec;
    if (v >= 100) dec = 0;
    else if (v >= 10) dec = 1;
    else dec = 2;
    return v.toFixed(dec).replace(/\.0+$/, '') + ' ' + units[i];
  }

  function fmtPct(part, total) {
    if (!total || total <= 0) return '0%';
    const p = (part / total) * 100;
    if (p > 0 && p < 0.1) return '<0.1%';
    if (p >= 10) return p.toFixed(0) + '%';
    return p.toFixed(1) + '%';
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch (_) {
      return '';
    }
  }

  function fmtCount(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function basename(p) {
    if (!p) return '';
    if (/^[a-zA-Z]:\\?$/.test(p)) return 'Windows (C:)';
    const parts = p.split('\\').filter(Boolean);
    return parts[parts.length - 1] || p;
  }

  function parentPath(p) {
    if (!p || /^[a-zA-Z]:\\?$/.test(p)) return 'C:\\';
    const n = p.replace(/\\+$/, '');
    const i = n.lastIndexOf('\\');
    if (i <= 2) return 'C:\\';
    return n.slice(0, i);
  }

  function keyFor(p) {
    return String(p || '').toLowerCase();
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function fileStyle(ext) {
    const e = String(ext || '').toLowerCase();
    if (['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts'].includes(e))
      return { icon: 'i-video', cls: 'ft-video', color: { h: 207, s: 18, l: 62 } };
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.raw', '.psd', '.ai', '.svg', '.heic'].includes(e))
      return { icon: 'i-image', cls: 'ft-image', color: { h: 145, s: 14, l: 66 } };
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.dmg', '.cab'].includes(e))
      return { icon: 'i-archive', cls: 'ft-archive', color: { h: 300, s: 12, l: 64 } };
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb', '.html', '.css', '.scss', '.json', '.yml', '.yaml', '.xml', '.sh', '.bat', '.ps1', '.sql', '.vue'].includes(e))
      return { icon: 'i-code', cls: 'ft-code', color: { h: 195, s: 13, l: 60 } };
    if (['.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf'].includes(e))
      return { icon: 'i-file', cls: 'ft-doc', color: { h: 50, s: 14, l: 68 } };
    if (['.exe', '.msi', '.dll', '.sys', '.bin', '.apk', '.appx', '.msix'].includes(e))
      return { icon: 'i-file', cls: 'ft-exe', color: { h: 10, s: 17, l: 64 } };
    return { icon: 'i-file', cls: '', color: { h: 35, s: 7, l: 67 } };
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  function dirColor(name) {
    const h = hashString(String(name || ''));
    return {
      h: 20 + (h % 22),
      s: 22 + ((h >> 4) % 16),
      l: 53 + ((h >> 9) % 15),
    };
  }

  function hsl(c, dl = 0, alpha = 1) {
    const l = Math.max(20, Math.min(88, c.l + dl));
    return alpha >= 1 ? `hsl(${c.h} ${c.s}% ${l}%)` : `hsla(${c.h} ${c.s}% ${l}% / ${alpha})`;
  }

  function textColorFor(c) {
    return c.l >= 55 ? 'rgba(43,33,23,.92)' : 'rgba(255,248,238,.95)';
  }

  function api(url, opts = {}) {
    const headers = Object.assign({ 'X-Cleaner-Token': TOKEN }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, Object.assign({}, opts, { headers, cache: 'no-store' })).then(async (r) => {
      let j = null;
      try {
        j = await r.json();
      } catch (_) {}
      if (!r.ok) {
        const err = new Error((j && j.error) || '请求失败 (' + r.status + ')');
        err.status = r.status;
        err.data = j;
        throw err;
      }
      return j;
    });
  }

  // ---------- Toast ----------
  function toast(title, msg, type = 'info', actionLabel = '', actionFn = null) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    const icon = type === 'success' ? 'i-check' : type === 'error' ? 'i-alert' : 'i-info';
    el.innerHTML = `<svg><use href="#${icon}"/></svg><div class="tt"><b>${escapeHtml(title)}</b>${msg ? escapeHtml(msg) : ''}</div>`;
    if (actionLabel && actionFn) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = actionLabel;
      b.addEventListener('click', () => {
        actionFn();
        el.remove();
      });
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 280);
    }, 6500);
  }

  // ---------- 数据加载 ----------
  async function loadOverview() {
    try {
      const o = await api('/api/overview');
      state.overview = o;
      renderCapacity(o);
      renderScanUI(o.progress);
      renderStatus();
      if (o.progress && o.progress.phase === 'scanning' && !state.data) {
        updateCanvasLoadingForScan(o.progress);
        schedulePoll();
      }
      if (!state.data && !(o.progress && o.progress.phase === 'scanning' && !o.scan)) {
        const initial = pathFromHash() || 'C:\\';
        await loadPath(initial, { push: false });
        history.replaceState({ path: state.path }, '', '#' + encodeURIComponent(state.path));
      }
    } catch (e) {
      toast('无法连接本地服务', e.message, 'error');
    }
  }

  function pathFromHash() {
    try {
      const h = location.hash.replace(/^#/, '');
      if (!h) return null;
      let p = decodeURIComponent(h);
      if (/^[a-zA-Z]:/.test(p)) return p;
    } catch (_) {}
    return null;
  }

  async function loadPath(p, opts = {}) {
    if (!p) p = 'C:\\';
    state.loading = true;
    showCanvasLoading(true);
    try {
      const data = await api('/api/list?path=' + encodeURIComponent(p));
      state.data = data;
      state.path = data.path;
      state.currentItems = buildItems(data);
      state.itemsByKey = new Map(state.currentItems.map((it) => [it.key, it]));
      state.selected = null;
      state.checked.clear();
      state.hovered = null;
      hideTooltip();
      renderInspector();
      renderList();
      renderBreadcrumbs();
      renderCanvasTitle();
      updateTray();
      draw();
      const empty = state.currentItems.filter((i) => i.size > 0).length === 0;
      if (empty) showCanvasEmpty('no-items');
      else hideCanvasEmpty();
      if (opts.push) {
        history.pushState({ path: state.path }, '', '#' + encodeURIComponent(state.path));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      document.title = basename(state.path) + ' · C 盘空间清理';
    } catch (e) {
      hideCanvasEmpty();
      showCanvasEmpty('error', e.message);
      toast('无法打开目录', e.message, 'error');
      if (e.status === 404 || e.status === 403) {
        if (keyFor(state.path) !== 'c:\\') {
          setTimeout(() => loadPath(parentPath(state.path), { push: true }), 500);
        }
      }
    } finally {
      state.loading = false;
      showCanvasLoading(false);
      scheduleDraw();
    }
  }

  function buildItems(data) {
    const items = [];
    for (const d of data.dirs || []) {
      items.push({
        key: 'd:' + keyFor(d.path),
        name: d.name,
        path: d.path,
        size: Number(d.size) || 0,
        kind: 'dir',
        isDir: true,
        ext: '',
        deletable: !d.protected,
        protected: !!d.protected,
        preview: d.preview || [],
        cached: !!d.cached,
        note: d.protected ? '系统或重要目录，已禁止在此删除。' : '',
      });
    }
    for (const f of data.files || []) {
      const fs = fileStyle(f.ext);
      items.push({
        key: 'f:' + keyFor(f.path),
        name: f.name,
        path: f.path,
        size: Number(f.size) || 0,
        kind: 'file',
        isDir: false,
        ext: f.ext || '',
        deletable: !f.protected,
        protected: !!f.protected,
        preview: [],
        fileIcon: fs.icon,
        fileCls: fs.cls,
        fileColor: fs.color,
        note: f.protected ? '受保护的文件，已禁止删除。' : '',
      });
    }
    if (data.fileBucket && data.fileBucket.size > 0) {
      items.push({
        key: 'bucket:files',
        name:
          '其他文件' +
          (data.fileBucket.count > 0 ? '（' + fmtCount(data.fileBucket.count) + ' 个）' : ''),
        path: null,
        size: data.fileBucket.size,
        kind: 'bucket',
        subtype: 'file',
        isDir: false,
        deletable: false,
        protected: true,
        preview: [],
        color: { h: 32, s: 8, l: 62 },
        note: '此类项目为聚合显示，无法整体删除；请在右侧列表中进入子目录或选中单个文件。',
      });
    }
    if (data.otherBucket && data.otherBucket.size > 0) {
      items.push({
        key: 'bucket:other',
        name: '其他小目录与项目',
        path: null,
        size: data.otherBucket.size,
        kind: 'bucket',
        subtype: 'other',
        isDir: false,
        deletable: false,
        protected: true,
        preview: [],
        color: { h: 35, s: 9, l: 58 },
        note: data.otherBucket.note || '快照中未展开的小目录项目，可进入更具体的目录后查看。',
      });
    }
    for (const s of data.systemItems || []) {
      items.push({
        key: 'sys:' + keyFor(s.name),
        name: s.name,
        path: s.path || null,
        size: Number(s.size) || 0,
        kind: 'system',
        isDir: false,
        deletable: false,
        protected: true,
        preview: [],
        color: { h: 33, s: 8, l: 56 },
        note: s.note || '系统保留区域，工具不会直接删除。',
      });
    }
    items.sort((a, b) => b.size - a.size);
    return items.filter((i) => i.size > 0 || i.kind === 'dir');
  }

  // ---------- 容量与状态 ----------
  function renderCapacity(o) {
    const d = o.drive;
    if (!d || !d.total) {
      $('#capStats').textContent = '无法读取磁盘容量';
      return;
    }
    const scanned = (o.scan && o.scan.stats && o.scan.stats.bytes) || 0;
    const system = Math.max(0, d.used - scanned);
    const pct = (v) => (v / d.total) * 100;
    $('#segScan').style.width = pct(Math.min(scanned, d.used)) + '%';
    $('#segSystem').style.width = pct(Math.max(0, Math.min(system, d.used - scanned))) + '%';
    $('#segFree').style.width = pct(d.free) + '%';
    $('#capStats').innerHTML =
      '<b>' + fmtBytes(d.used) + '</b> 已用 · <b>' + fmtBytes(d.free) + '</b> 可用 / ' + fmtBytes(d.total);
    $('#capLegend').innerHTML =
      '<span><i class="dot dot-scan"></i>已分析 ' + fmtBytes(scanned) + '</span>' +
      '<span><i class="dot dot-system"></i>系统 / 未扫描 ' + fmtBytes(system) + '</span>' +
      '<span><i class="dot dot-free"></i>可用 ' + fmtBytes(d.free) + '</span>';
  }

  function renderCapacityLive(p) {
    const d = state.overview && state.overview.drive;
    if (!d || !d.total || !p) return;
    const scanned = Math.max(0, Number(p.bytes || 0));
    const system = Math.max(0, d.used - scanned);
    const pct = (v) => (v / d.total) * 100;
    $('#segScan').style.width = pct(Math.min(scanned, d.used)) + '%';
    $('#segSystem').style.width = pct(Math.min(system, d.used)) + '%';
    $('#segFree').style.width = pct(d.free) + '%';
    $('#capStats').innerHTML =
      '<b>' + fmtBytes(d.used) + '</b> 已用 · <b>' + fmtBytes(d.free) + '</b> 可用 / ' + fmtBytes(d.total);
    $('#capLegend').innerHTML =
      '<span><i class="dot dot-scan"></i>已分析 ' + fmtBytes(scanned) + '</span>' +
      '<span><i class="dot dot-system"></i>系统 / 未扫描 ' + fmtBytes(system) + '</span>' +
      '<span><i class="dot dot-free"></i>可用 ' + fmtBytes(d.free) + '</span>';
  }

  async function refreshLiveView() {
    if (state.refreshingLive) return;
    state.refreshingLive = true;
    try {
      const target = state.path || 'C:\\';
      const fresh = await api('/api/list?path=' + encodeURIComponent(target) + '&live=1');
      const hasLiveContent =
        (fresh.dirs || []).some((x) => Number(x.size) > 0) ||
        (fresh.systemItems || []).some((x) => Number(x.size) > 0);
      if (!state.data && !hasLiveContent) return;
      const old = state.data;
      const samePath = old && keyFor(old.path) === keyFor(fresh.path);
      const merged = Object.assign({}, fresh);
      if (samePath) {
        merged.files = old.files || [];
        merged.fileBucket = old.fileBucket || fresh.fileBucket;
      }
      const selectedKey = state.selected ? state.selected.key : null;
      const listEl = $('#itemList');
      const scrollTop = listEl ? listEl.scrollTop : 0;
      state.data = merged;
      state.path = merged.path;
      state.currentItems = buildItems(merged);
      state.itemsByKey = new Map(state.currentItems.map((it) => [it.key, it]));
      if (selectedKey && state.itemsByKey.has(selectedKey)) state.selected = state.itemsByKey.get(selectedKey);
      else if (selectedKey) state.selected = null;
      for (const key of Array.from(state.checked.keys())) {
        if (!state.itemsByKey.has(key)) state.checked.delete(key);
        else state.checked.set(key, state.itemsByKey.get(key));
      }
      renderInspector();
      renderList();
      updateListSelection();
      renderBreadcrumbs();
      renderCanvasTitle();
      updateTray();
      draw();
      if (listEl) listEl.scrollTop = scrollTop;
      hideCanvasEmpty();
    } catch (_) {
      // 扫描期间的局部刷新失败不打断界面，等待下一次刷新或扫描完成。
    } finally {
      state.refreshingLive = false;
    }
  }

  function renderScanUI(progress) {
    const p = progress || state.scanProgress;
    const scanning = !!(p && p.phase === 'scanning' && p.ageMs < 16000);
    const changed = state.scanning !== scanning;
    state.scanning = scanning;
    state.scanProgress = p;
    const chip = $('#scanChip');
    const rescan = $('#rescanBtn');
    const suggest = $('#suggestBtn');
    if (scanning) {
      chip.classList.remove('hidden');
      const parts = ['扫描中'];
      if (p.scannedFiles) parts.push(fmtCount(p.scannedFiles) + ' 文件');
      if (p.bytes) parts.push(fmtBytes(p.bytes));
      if (p.queueLength) parts.push('待处理 ' + fmtCount(p.queueLength));
      $('#scanChipText').textContent = parts.join(' · ');
      rescan.disabled = true;
      if (suggest) suggest.disabled = true;
      if (!state.data) {
        updateCanvasLoadingForScan(p);
      }
    } else {
      chip.classList.add('hidden');
      rescan.disabled = false;
      if (suggest) suggest.disabled = false;
      if (!state.data) {
        if (state.overview && state.overview.scan) {
          showCanvasLoading(false);
        } else {
          showCanvasEmpty('no-scan');
        }
      }
    }
    if (changed && state.data) {
      renderInspector();
      renderList();
      updateTray();
    }
    renderStatus();
  }

  function updateCanvasLoadingForScan(p) {
    showCanvasLoading(false);
    const empty = $('#canvasEmpty');
    empty.classList.remove('hidden');
    empty.innerHTML =
      '<div class="loader"></div>' +
      '<h3>正在扫描 C 盘…</h3>' +
      '<p>已发现 ' +
      fmtCount(p.scannedFiles || 0) +
      ' 个文件，累计 ' +
      fmtBytes(p.bytes || 0) +
      '。<br/>首次扫描通常需要 1–3 分钟，完成后会自动显示矩形树图。</p>';
    $('#canvasLoading').classList.add('hidden');
  }

  function renderStatus() {
    const o = state.overview;
    if (!o) {
      $('#statusLeft').textContent = '正在加载…';
      return;
    }
    const s = o.scan;
    const bits = [];
    if (s) {
      bits.push('扫描于 ' + fmtDate(s.scannedAt));
      if (s.stats) {
        bits.push(fmtCount(s.stats.dirs) + ' 个目录');
        bits.push(fmtCount(s.stats.files) + ' 个文件');
      }
      if (s.elapsedMs) bits.push('用时 ' + (s.elapsedMs / 1000).toFixed(0) + ' 秒');
    } else {
      bits.push('尚未生成扫描数据');
    }
    if (state.scanning) bits.push('正在更新扫描…');
    else if (s && s.modifiedAt) bits.push('清理后已更新');
    $('#statusLeft').innerHTML = bits.map(escapeHtml).join(' &nbsp;·&nbsp; ');
  }

  function renderCanvasTitle() {
    const el = $('#canvasTitle');
    if (!state.data) {
      el.innerHTML = '';
      return;
    }
    const d = state.data;
    const isRoot = keyFor(state.path) === 'c:\\';
    const tag = isRoot
      ? state.data.systemItems && state.data.systemItems.length
        ? '含系统保留'
        : ''
      : d.cached
      ? '已扫描'
      : '实时读取';
    el.innerHTML =
      '<span>当前目录</span><b title="' +
      escapeHtml(state.path) +
      '">' +
      escapeHtml(state.path) +
      '</b><span class="ct-size">' +
      fmtBytes(d.size) +
      '</span>' +
      (tag ? '<span class="ct-tag">' + escapeHtml(tag) + '</span>' : '');
  }

  // ---------- 面包屑 ----------
  function renderBreadcrumbs() {
    const nav = $('#breadcrumbs');
    const p = state.path || 'C:\\';
    const segs = p.split('\\').filter(Boolean);
    const crumbs = [];
    crumbs.push({ label: 'C:', path: 'C:\\' });
    let acc = 'C:\\';
    for (let i = 1; i < segs.length; i++) {
      acc = acc.replace(/\\$/, '') + '\\' + segs[i];
      crumbs.push({ label: segs[i], path: acc });
    }
    nav.innerHTML = crumbs
      .map((c, i) => {
        const current = i === crumbs.length - 1;
        return (
          (i > 0 ? '<span class="crumb-sep">›</span>' : '') +
          '<button class="crumb ' +
          (current ? 'current' : '') +
          '" data-path="' +
          escapeHtml(c.path) +
          '" title="' +
          escapeHtml(c.path) +
          '">' +
          escapeHtml(c.label) +
          '</button>'
        );
      })
      .join('');
    nav.querySelectorAll('.crumb').forEach((b) => {
      b.addEventListener('click', () => {
        const target = b.getAttribute('data-path');
        if (target && keyFor(target) !== keyFor(state.path)) loadPath(target, { push: true });
      });
    });
    const upBtn = $('#upBtn');
    upBtn.disabled = keyFor(state.path) === 'c:\\';
    nav.scrollLeft = nav.scrollWidth;
  }

  // ---------- 树图绘制 ----------
  let dpr = 1;
  let drawRaf = 0;
  let hatchCache = new Map();

  function resizeCanvas() {
    const w = holder.clientWidth;
    const h = holder.clientHeight;
    dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      draw();
    });
  }

  function squarify(items, x, y, w, h) {
    const out = [];
    if (!items.length || w <= 1 || h <= 1) return out;
    const total = items.reduce((s, i) => s + Math.max(0, i.size), 0);
    if (total <= 0) return out;
    const scale = (w * h) / total;
    const remaining = items.map((i) => Object.assign({}, i, { _area: Math.max(0, i.size) * scale }));
    let rect = { x, y, w, h };
    let row = [];

    const worst = (r, side) => {
      if (!r.length) return Infinity;
      let sum = 0, max = 0, min = Infinity;
      for (const it of r) {
        sum += it._area;
        if (it._area > max) max = it._area;
        if (it._area < min) min = it._area;
      }
      if (sum <= 0 || min === Infinity) return Infinity;
      const s2 = side * side;
      return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
    };

    const placeRow = (r, rc) => {
      const sum = r.reduce((s, i) => s + i._area, 0);
      const rects = [];
      if (sum <= 0) return { rects, rest: rc };
      if (rc.w >= rc.h) {
        const stripW = Math.min(rc.w, sum / rc.h);
        let yy = rc.y;
        for (const it of r) {
          const hh = stripW > 0 ? it._area / stripW : 0;
          rects.push(Object.assign({}, it, { x: rc.x, y: yy, w: stripW, h: hh }));
          yy += hh;
        }
        return { rects, rest: { x: rc.x + stripW, y: rc.y, w: Math.max(0, rc.w - stripW), h: rc.h } };
      }
      const stripH = Math.min(rc.h, sum / rc.w);
      let xx = rc.x;
      for (const it of r) {
        const ww = stripH > 0 ? it._area / stripH : 0;
        rects.push(Object.assign({}, it, { x: xx, y: rc.y, w: ww, h: stripH }));
        xx += ww;
      }
      return { rects, rest: { x: rc.x, y: rc.y + stripH, w: rc.w, h: Math.max(0, rc.h - stripH) } };
    };

    while (remaining.length) {
      if (rect.w <= 0.05 || rect.h <= 0.05) break;
      const side = Math.min(rect.w, rect.h);
      const next = remaining[0];
      if (!row.length || worst(row.concat([next]), side) <= worst(row, side)) {
        row.push(remaining.shift());
      } else {
        const laid = placeRow(row, rect);
        out.push(...laid.rects);
        rect = laid.rest;
        row = [];
      }
    }
    if (row.length && rect.w > 0.05 && rect.h > 0.05) out.push(...placeRow(row, rect).rects);
    return out;
  }

  function makeHatch(dark, light) {
    const key = dark + '|' + light;
    if (hatchCache.has(key)) return hatchCache.get(key);
    const c = document.createElement('canvas');
    c.width = 9;
    c.height = 9;
    const g = c.getContext('2d');
    g.fillStyle = light;
    g.fillRect(0, 0, 9, 9);
    g.strokeStyle = dark;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-2, 11);
    g.lineTo(11, -2);
    g.moveTo(2, 14);
    g.lineTo(14, 2);
    g.stroke();
    const pat = ctx.createPattern(c, 'repeat');
    hatchCache.set(key, pat);
    return pat;
  }

  function itemColor(item) {
    if (item.color) return item.color;
    if (item.kind === 'dir') return dirColor(item.name);
    if (item.kind === 'file') return item.fileColor || fileStyle(item.ext).color;
    if (item.kind === 'system') return { h: 33, s: 8, l: 56 };
    return { h: 35, s: 9, l: 62 };
  }

  function draw() {
    const w = holder.clientWidth;
    const h = holder.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#ded4c3');
    bg.addColorStop(1, '#d4c8b6');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // 细微颗粒
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#3f3122';
    for (let y = 0; y < h; y += 7) {
      for (let x = (y % 14) * 2; x < w; x += 17) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();

    state.hitRects = [];
    if (!state.data || state.loading) return;
    const items = state.currentItems.filter((i) => i.size > 0);
    if (!items.length) return;

    // 顶部留给"当前目录"与图例浮层，避免遮住第一行方块的名称
    const topInset = 46;
    const rects = squarify(items, 5, topInset, Math.max(0, w - 10), Math.max(0, h - topInset - 5));
    for (const r of rects) {
      const pad = 1.4;
      const rr = {
        x: r.x + pad,
        y: r.y + pad,
        w: Math.max(0, r.w - pad * 2),
        h: Math.max(0, r.h - pad * 2),
      };
      if (rr.w < 1.5 || rr.h < 1.5) continue;
      drawItem(rr, r);
      state.hitRects.push({ x: rr.x, y: rr.y, w: rr.w, h: rr.h, item: r });
    }

    if (state.hovered) {
      const hr = state.hitRects.find((r) => r.item.key === state.hovered.key);
      if (hr) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,250,240,.95)';
        ctx.lineWidth = 2.2;
        ctx.strokeRect(hr.x + 1, hr.y + 1, hr.w - 2, hr.h - 2);
        ctx.restore();
      }
    }
    if (state.selected) {
      const sr = state.hitRects.find((r) => r.item.key === state.selected.key);
      if (sr) {
        ctx.save();
        ctx.strokeStyle = 'rgba(50,33,18,.75)';
        ctx.lineWidth = 3.5;
        ctx.strokeRect(sr.x + 1.5, sr.y + 1.5, sr.w - 3, sr.h - 3);
        ctx.strokeStyle = '#fff8ec';
        ctx.lineWidth = 2;
        ctx.strokeRect(sr.x + 2.5, sr.y + 2.5, sr.w - 5, sr.h - 5);
        ctx.restore();
      }
    }
  }

  function fitText(text, maxWidth) {
    if (maxWidth <= 4) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '';
  }

  function drawItem(rr, r) {
    const item = r;
    const base = itemColor(item);
    const isSystem = item.kind === 'system';
    const isBucket = item.kind === 'bucket';
    const color = base;
    const headerH = (item.kind === 'dir' || isSystem) && rr.w > 118 && rr.h > 74 ? 20 : 0;

    ctx.save();
    ctx.fillStyle = hsl(color);
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);

    if (isSystem || isBucket) {
      ctx.fillStyle = isSystem
        ? makeHatch('rgba(85,73,60,.28)', 'rgba(150,140,126,.55)')
        : makeHatch('rgba(100,80,56,.18)', 'rgba(183,169,147,.55)');
      ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
    }

    // 嵌套子目录预览
    if (
      state.nesting &&
      item.kind === 'dir' &&
      item.preview &&
      item.preview.length &&
      rr.w >= 130 &&
      rr.h >= 84
    ) {
      const content = {
        x: rr.x + 2,
        y: rr.y + (headerH ? headerH + 1 : 2),
        w: rr.w - 4,
        h: rr.h - (headerH ? headerH + 3 : 4),
      };
      drawPreview(item, base, content, headerH);
    }

    if (headerH) {
      ctx.fillStyle = 'rgba(255,249,240,.62)';
      ctx.fillRect(rr.x, rr.y, rr.w, headerH);
      ctx.strokeStyle = 'rgba(80,58,36,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rr.x, rr.y + headerH + 0.5);
      ctx.lineTo(rr.x + rr.w, rr.y + headerH + 0.5);
      ctx.stroke();
    }

    // 边框
    ctx.strokeStyle = isSystem ? 'rgba(70,58,46,.45)' : 'rgba(62,45,28,.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rr.x + 0.5, rr.y + 0.5, Math.max(0, rr.w - 1), Math.max(0, rr.h - 1));

    // 文本
    ctx.save();
    ctx.beginPath();
    ctx.rect(rr.x + 1, rr.y + 1, Math.max(0, rr.w - 2), Math.max(0, rr.h - 2));
    ctx.clip();
    const ink = textColorFor(color);
    const name = item.name;
    const size = fmtBytes(item.size);

    if (headerH) {
      ctx.fillStyle = ink;
      ctx.font = '600 11px "Microsoft YaHei UI", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const sizeW = Math.min(ctx.measureText(size).width + 10, rr.w * 0.38);
      ctx.font = '600 10px "Microsoft YaHei UI", "Segoe UI", sans-serif';
      const nm = fitText(name, Math.max(10, rr.w - sizeW - 14));
      ctx.fillText(nm, rr.x + 6, rr.y + headerH / 2 + 0.5);
      ctx.font = '500 9px "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(55,40,24,.72)';
      ctx.fillText(size, rr.x + rr.w - 6, rr.y + headerH / 2 + 0.5);
    } else if (item.kind === 'file' || isBucket || isSystem) {
      if (rr.w > 46 && rr.h > 16) {
        const grad = ctx.createLinearGradient(0, rr.y, 0, rr.y + Math.min(34, rr.h));
        grad.addColorStop(0, 'rgba(255,250,242,.42)');
        grad.addColorStop(1, 'rgba(255,250,242,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(rr.x, rr.y, rr.w, Math.min(34, rr.h));
        ctx.fillStyle = ink;
        ctx.font = '600 9.5px "Microsoft YaHei UI", "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(fitText(name, rr.w - 8), rr.x + 4, rr.y + 4);
        if (rr.h > 30 && rr.w > 72) {
          ctx.font = '400 8.5px "Segoe UI", sans-serif';
          ctx.fillStyle = 'rgba(55,40,24,.62)';
          ctx.fillText(size, rr.x + 4, rr.y + 17);
        }
      }
    } else {
      // 目录无 header：小/中块
      if (rr.w > 40 && rr.h > 14) {
        const grad = ctx.createLinearGradient(0, rr.y, 0, rr.y + Math.min(38, rr.h));
        grad.addColorStop(0, 'rgba(255,250,242,.34)');
        grad.addColorStop(1, 'rgba(255,250,242,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(rr.x, rr.y, rr.w, Math.min(38, rr.h));
        ctx.fillStyle = ink;
        ctx.font = '600 9.5px "Microsoft YaHei UI", "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(fitText(name, rr.w - 8), rr.x + 4, rr.y + 4);
        if (rr.h > 26 && rr.w > 66) {
          ctx.font = '400 8px "Segoe UI", sans-serif';
          ctx.fillStyle = 'rgba(55,40,24,.62)';
          ctx.fillText(size, rr.x + 4, rr.y + 16);
        }
      }
    }
    ctx.restore();
    ctx.restore();
  }

  function drawPreview(item, base, content, headerH) {
    const previews = [];
    let sum = 0;
    for (const p of item.preview) {
      const s = Number(p[1]) || 0;
      if (s <= 0) continue;
      previews.push({ name: String(p[0]), size: s, rest: false });
      sum += s;
    }
    const restSize = Math.max(0, item.size - sum);
    if (restSize > 0) previews.push({ name: '', size: restSize, rest: true });
    if (!previews.length) return;
    const rects = squarify(previews, content.x, content.y, content.w, content.h);
    let idx = 0;
    for (const pr of rects) {
      const x = pr.x + 0.6;
      const y = pr.y + 0.6;
      const w = Math.max(0, pr.w - 1.2);
      const h = Math.max(0, pr.h - 1.2);
      if (w < 1 || h < 1) continue;
      if (pr.rest) {
        ctx.fillStyle = hsl(base, -2, 0.9);
        ctx.fillRect(x, y, w, h);
        continue;
      }
      idx++;
      ctx.fillStyle = hsl(base, -4 - (idx % 3) * 3);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(60,43,26,.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      if (w > 92 && h > 26) {
        const ink = textColorFor({ h: base.h, s: base.s, l: Math.max(30, base.l - 4 - (idx % 3) * 3) });
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, w - 2, h - 2);
        ctx.clip();
        ctx.fillStyle = ink;
        ctx.font = '500 8.5px "Microsoft YaHei UI", "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(fitText(pr.name, w - 8), x + 4, y + 4);
        if (w > 126 && h > 38) {
          ctx.font = '400 7.5px "Segoe UI", sans-serif';
          ctx.fillStyle = 'rgba(45,32,20,.6)';
          ctx.fillText(fmtBytes(pr.size), x + 4, y + 16);
        }
        ctx.restore();
      }
    }
  }

  // ---------- 画布交互 ----------
  function hitTest(x, y) {
    for (let i = state.hitRects.length - 1; i >= 0; i--) {
      const r = state.hitRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.item;
    }
    return null;
  }

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function showTooltip(item, e) {
    const holderRect = holder.getBoundingClientRect();
    const x = e.clientX - holderRect.left;
    const y = e.clientY - holderRect.top;
    const pct = state.data ? fmtPct(item.size, state.data.size) : '';
    const hint = item.kind === 'dir' ? '双击进入此目录' : '单击选中';
    tooltip.innerHTML =
      '<div class="tt-name">' +
      escapeHtml(item.name) +
      '</div>' +
      (item.path
        ? '<div class="tt-path">' + escapeHtml(item.path) + '</div>'
        : item.note
        ? '<div class="tt-path">' + escapeHtml(item.note) + '</div>'
        : '') +
      '<div class="tt-meta">' +
      fmtBytes(item.size) +
      ' · 占当前目录 ' +
      pct +
      (item.protected ? ' · 受保护' : '') +
      '</div>' +
      '<div class="tt-hint">' +
      hint +
      '</div>';
    tooltip.classList.remove('hidden');
    const ttRect = tooltip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 16;
    if (left + ttRect.width > holderRect.width - 8) left = x - ttRect.width - 12;
    if (top + ttRect.height > holderRect.height - 8) top = y - ttRect.height - 12;
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = Math.max(8, top) + 'px';
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!state.data || state.loading) return;
    const { x, y } = canvasPoint(e);
    const item = hitTest(x, y);
    if (!item) {
      if (state.hovered) {
        state.hovered = null;
        hideTooltip();
        scheduleDraw();
      }
      canvas.style.cursor = 'default';
      return;
    }
    if (!state.hovered || state.hovered.key !== item.key) {
      state.hovered = item;
      scheduleDraw();
    }
    canvas.style.cursor = 'pointer';
    showTooltip(item, e);
  });

  canvas.addEventListener('pointerleave', () => {
    state.hovered = null;
    hideTooltip();
    scheduleDraw();
  });

  canvas.addEventListener('click', (e) => {
    if (!state.data) return;
    const { x, y } = canvasPoint(e);
    const item = hitTest(x, y);
    if (!item) {
      state.selected = null;
      renderInspector();
      updateListSelection();
      scheduleDraw();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (item.deletable && item.path) toggleChecked(item, true);
      selectItem(item, false);
      return;
    }
    selectItem(item);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!state.data) return;
    const { x, y } = canvasPoint(e);
    const item = hitTest(x, y);
    if (item && item.kind === 'dir' && item.path) {
      loadPath(item.path, { push: true });
    }
  });

  // ---------- 选中与列表 ----------
  function selectItem(item, scrollList = true) {
    state.selected = item;
    renderInspector();
    updateListSelection();
    scheduleDraw();
    if (scrollList) {
      const row = $('#itemList .item-row[data-key="' + cssEscape(item.key) + '"]');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function toggleChecked(item, forceOn) {
    if (!item || !item.deletable || !item.path || state.scanning) return;
    const key = item.key;
    const on = forceOn === true ? true : !state.checked.has(key);
    if (on) state.checked.set(key, item);
    else state.checked.delete(key);
    const row = $('#itemList .item-row[data-key="' + cssEscape(key) + '"]');
    if (row) {
      row.classList.toggle('checked', on);
      const chk = row.querySelector('input[type="checkbox"]');
      if (chk) chk.checked = on;
    }
    updateTray();
  }

  function updateTray() {
    const n = state.checked.size;
    const total = Array.from(state.checked.values()).reduce((s, i) => s + (i.size || 0), 0);
    $('#trayCount').textContent = n;
    $('#traySize').textContent = fmtBytes(total);
    $('#selectionTray').classList.toggle('hidden', n === 0);
    const deleteBtn = $('#trayDeleteBtn');
    if (deleteBtn) {
      deleteBtn.disabled = state.scanning || n === 0;
      deleteBtn.title = state.scanning ? '扫描完成后可删除' : '';
    }
  }

  function renderInspector() {
    const head = $('#inspectorHead');
    const d = state.data;
    if (!d) {
      head.innerHTML = '<div class="summary-note">正在读取目录…</div>';
      return;
    }
    const item = state.selected;
    if (!item) {
      const isRoot = keyFor(d.path) === 'c:\\';
      head.innerHTML =
        '<div class="eyebrow"><svg><use href="#i-folder"/></svg> 当前目录</div>' +
        '<div class="sel-title"><svg><use href="#i-folder"/></svg>' +
        escapeHtml(basename(d.path)) +
        '</div>' +
        '<div class="sel-size-row"><span class="sel-size">' +
        fmtBytes(d.size) +
        '</span><span class="sel-pct">' +
        (isRoot ? '已用空间' : '包含子目录与文件') +
        '</span></div>' +
        '<div class="sel-path">' +
        escapeHtml(d.path) +
        '</div>' +
        '<div class="head-stats">' +
        '<span><b>' +
        fmtCount(d.dirCount) +
        '</b> 个子目录</span>' +
        '<span><b>' +
        fmtCount(d.directFileCount) +
        '</b> 个直属文件</span>' +
        (d.driveFree ? '<span><b>' + fmtBytes(d.driveFree) + '</b> C 盘可用</span>' : '') +
        '</div>' +
        '<div class="sel-actions">' +
        '<button class="btn btn-accent" data-act="open-current"><svg><use href="#i-external"/></svg> 打开位置</button>' +
        '<button class="btn btn-ghost" data-act="suggest"' + (state.scanning ? ' disabled title="扫描完成后可使用"' : '') + '><svg><use href="#i-sparkles"/></svg> 清理建议</button>' +
        '</div>' +
        '<div class="summary-note">' +
        (state.scanning ? '扫描进行中，方块图会实时更新；完成后可勾选并删除项目。' : '点击方块或下方列表选中项目；勾选多项可批量删除。右侧数字均为文件逻辑大小。') +
        '</div>';
      head.querySelector('[data-act="open-current"]').addEventListener('click', () => openPath(d.path));
      head.querySelector('[data-act="suggest"]').addEventListener('click', openSuggestions);
      return;
    }

    const style = item.kind === 'file' ? fileStyle(item.ext) : null;
    const icon = item.kind === 'dir' ? 'i-folder' : item.kind === 'system' ? 'i-lock' : item.kind === 'bucket' ? 'i-layers' : style.icon;
    const pct = fmtPct(item.size, d.size);
    const isBlocked = !!item.protected || !item.deletable || state.scanning;
    const blockTitle = state.scanning ? '扫描完成后可删除' : '';
    let actions = '';
    if (item.kind === 'dir') {
      actions +=
        '<button class="btn btn-accent" data-act="enter"' + (item.path ? '' : ' disabled') + '><svg><use href="#i-chevron"/></svg> 进入目录</button>' +
        '<button class="btn btn-ghost" data-act="open"><svg><use href="#i-external"/></svg> 打开位置</button>' +
        '<button class="btn btn-danger" data-act="recycle"' + (isBlocked || !item.path ? ' disabled' : '') + (blockTitle ? ' title="' + escapeHtml(blockTitle) + '"' : '') + '><svg><use href="#i-recycle"/></svg> 移到回收站</button>' +
        '<button class="btn btn-danger-ghost" data-act="permanent"' + (isBlocked || !item.path ? ' disabled' : '') + (blockTitle ? ' title="' + escapeHtml(blockTitle) + '"' : '') + '><svg><use href="#i-trash"/></svg> 永久删除</button>';
    } else if (item.kind === 'file') {
      actions +=
        '<button class="btn btn-accent" data-act="open"><svg><use href="#i-external"/></svg> 打开位置</button>' +
        '<button class="btn btn-ghost" data-act="copy"><svg><use href="#i-file"/></svg> 复制路径</button>' +
        '<button class="btn btn-danger" data-act="recycle"' + (isBlocked ? ' disabled' : '') + (blockTitle ? ' title="' + escapeHtml(blockTitle) + '"' : '') + '><svg><use href="#i-recycle"/></svg> 移到回收站</button>' +
        '<button class="btn btn-danger-ghost" data-act="permanent"' + (isBlocked ? ' disabled' : '') + (blockTitle ? ' title="' + escapeHtml(blockTitle) + '"' : '') + '><svg><use href="#i-trash"/></svg> 永久删除</button>';
    } else {
      actions =
        '<button class="btn btn-ghost span2" data-act="clear"><svg><use href="#i-back"/></svg> 返回目录概览</button>';
    }

    let note = '';
    if (state.scanning && !item.protected) {
      note = '<div class="sel-note"><svg><use href="#i-clock"/></svg><span>扫描进行中，当前大小会持续变化。请等待扫描完成后再删除。</span></div>';
    } else if (item.kind === 'system') {
      note = '<div class="sel-note"><svg><use href="#i-lock"/></svg><span>' + escapeHtml(item.note || '系统保留区域，工具不会直接删除。') + '</span></div>';
    } else if (item.kind === 'bucket') {
      note = '<div class="sel-note"><svg><use href="#i-info"/></svg><span>' + escapeHtml(item.note || '聚合项目，无法整体删除。') + '</span></div>';
    } else if (item.protected) {
      note = '<div class="sel-note"><svg><use href="#i-lock"/></svg><span>这是系统或重要目录，工具已禁止删除。请通过卸载程序或系统工具处理。</span></div>';
    } else if (item.kind === 'dir') {
      note = '<div class="summary-note">目录大小包含所有子项。删除前建议先进入确认内容；勾选下方多项可批量处理。</div>';
    }

    head.innerHTML =
      '<div class="eyebrow"><svg><use href="#i-' +
      (item.kind === 'system' ? 'lock' : 'info') +
      '"/></svg> 已选择 · ' +
      (item.kind === 'dir' ? '目录' : item.kind === 'file' ? '文件' : item.kind === 'system' ? '系统区域' : '聚合项') +
      '</div>' +
      '<div class="sel-title"><svg><use href="#' +
      icon +
      '"/></svg>' +
      escapeHtml(item.name) +
      '</div>' +
      '<div class="sel-size-row"><span class="sel-size">' +
      fmtBytes(item.size) +
      '</span><span class="sel-pct">占当前目录 ' +
      pct +
      '</span></div>' +
      (item.path ? '<div class="sel-path">' + escapeHtml(item.path) + '</div>' : '') +
      '<div class="sel-actions">' +
      actions +
      '</div>' +
      note;

    const act = (name, fn) => {
      const b = head.querySelector('[data-act="' + name + '"]');
      if (b) b.addEventListener('click', fn);
    };
    act('enter', () => item.path && loadPath(item.path, { push: true }));
    act('open', () => item.path && openPath(item.path, item.kind === 'file'));
    act('copy', () => copyText(item.path || ''));
    act('recycle', () => !isBlocked && item.path && openDeleteModal('recycle', [item]));
    act('permanent', () => !isBlocked && item.path && openDeleteModal('permanent', [item]));
    act('clear', () => {
      state.selected = null;
      renderInspector();
      updateListSelection();
      scheduleDraw();
    });
  }

  function renderList() {
    const list = $('#itemList');
    const d = state.data;
    if (!d) {
      list.innerHTML = '';
      $('#listCount').textContent = '';
      return;
    }
    const items = state.currentItems;
    $('#listCount').textContent = '· ' + items.length + ' 项 · 按大小排序';
    if (!items.length) {
      list.innerHTML = '<div class="summary-note" style="padding:16px 10px">这个目录没有可显示的内容。</div>';
      return;
    }
    const total = d.size || items.reduce((s, i) => s + i.size, 0) || 1;
    const frag = document.createDocumentFragment();
    // 目录优先不明显，完全按照大小排序；聚合项放在最后
    for (const item of items) {
      const style = item.kind === 'file' ? fileStyle(item.ext) : null;
      const icon =
        item.kind === 'dir'
          ? 'i-folder'
          : item.kind === 'system'
          ? 'i-lock'
          : item.kind === 'bucket'
          ? 'i-layers'
          : style.icon;
      const iconCls =
        item.kind === 'dir' ? '' : item.kind === 'system' ? 'ft-system' : item.kind === 'bucket' ? 'ft-system' : style.cls;
      const pct = fmtPct(item.size, total);
      const barPct = Math.max(0.6, Math.min(100, (item.size / total) * 100));
      const row = document.createElement('div');
      row.className = 'item-row' + (item.isDir ? ' has-enter' : '') + (item.kind === 'bucket' || item.kind === 'system' ? ' bucket' : '');
      row.setAttribute('data-key', item.key);
      const canCheck = item.deletable && item.path && !state.scanning;
      const checkTitle = state.scanning ? '扫描完成后可删除' : '不可直接勾选删除';
      row.innerHTML =
        '<input class="chk" type="checkbox" ' +
        (canCheck ? '' : 'disabled title="' + escapeHtml(checkTitle) + '"') +
        ' aria-label="选择 ' +
        escapeHtml(item.name) +
        '">' +
        '<span class="row-icon ' +
        iconCls +
        '"><svg><use href="#' +
        icon +
        '"/></svg></span>' +
        '<span class="name">' +
        escapeHtml(item.name) +
        (item.protected && item.kind !== 'bucket' ? '<span class="lock" title="受保护"><svg><use href="#i-lock"/></svg></span>' : '') +
        '</span>' +
        '<span class="size">' +
        fmtBytes(item.size) +
        '</span>' +
        '<span class="bar"><i style="width:' +
        barPct.toFixed(2) +
        '%"></i></span>' +
        '<span class="pct">' +
        pct +
        '</span>' +
        (item.isDir
          ? '<button class="row-enter" title="进入目录" data-enter="1"><svg><use href="#i-chevron"/></svg></button>'
          : '');
      frag.appendChild(row);
    }
    list.innerHTML = '';
    list.appendChild(frag);
  }

  function updateListSelection() {
    const selKey = state.selected ? state.selected.key : null;
    $$('#itemList .item-row').forEach((row) => {
      const key = row.getAttribute('data-key');
      row.classList.toggle('selected', key === selKey);
      const checked = state.checked.has(key);
      row.classList.toggle('checked', checked);
      const chk = row.querySelector('input[type="checkbox"]');
      if (chk && !chk.disabled) chk.checked = checked;
    });
  }

  function onListClick(e) {
    const row = e.target.closest('.item-row');
    if (!row) return;
    const key = row.getAttribute('data-key');
    const item = state.itemsByKey.get(key);
    if (!item) return;
    if (e.target.matches('input[type="checkbox"]')) {
      toggleChecked(item, e.target.checked);
      if (e.target.checked) {
        state.selected = item;
        renderInspector();
        scheduleDraw();
      }
      return;
    }
    if (e.target.closest('[data-enter]')) {
      e.stopPropagation();
      if (item.kind === 'dir' && item.path) loadPath(item.path, { push: true });
      return;
    }
    selectItem(item, false);
  }

  function onListDblClick(e) {
    if (e.target.matches('input[type="checkbox"]') || e.target.closest('[data-enter]')) return;
    const row = e.target.closest('.item-row');
    if (!row) return;
    const item = state.itemsByKey.get(row.getAttribute('data-key'));
    if (item && item.kind === 'dir' && item.path) loadPath(item.path, { push: true });
  }

  // ---------- 删除 ----------
  function openDeleteModal(mode, items) {
    if (state.scanning) {
      toast('扫描正在进行', '请等待扫描完成后再删除，以免统计结果发生变化。', 'info');
      return;
    }
    const valid = items.filter((i) => i && (i.paths && i.paths.length ? true : i.path) && !i.protected);
    if (!valid.length) {
      toast('没有可删除的项目', '受保护的系统项目不会被处理。', 'error');
      return;
    }
    state.deleteMode = mode;
    state.deleteItems = valid;
    state.deleteBusy = false;
    const total = valid.reduce((s, i) => s + (i.size || 0), 0);
    const allPaths = valid.reduce((s, i) => s + (i.paths ? i.paths.length : 1), 0);
    const permanent = mode === 'permanent';
    $('#deleteTitle').textContent = permanent ? '永久删除' : '移到回收站';
    $('#deleteSub').textContent = permanent
      ? '将从磁盘上直接删除，无法恢复。'
      : '将从原位置移入回收站，可恢复，但不会立即释放磁盘空间。';
    const icon = $('#deleteIcon');
    icon.className = 'modal-icon' + (permanent ? ' danger' : '');
    icon.innerHTML = '<svg><use href="#' + (permanent ? 'i-trash' : 'i-recycle') + '"/></svg>';
    $('#deleteTotal').textContent = fmtBytes(total);
    $('#deleteCount').textContent = valid.length + ' 项' + (allPaths > valid.length ? ' · 共 ' + allPaths + ' 个位置' : '');
    const list = valid.slice(0, 12).map((i) => {
      const p = i.path || (i.paths && i.paths[0]) || '';
      return (
        '<div class="delete-item"><span class="dp" title="' +
        escapeHtml(p) +
        '">' +
        escapeHtml(p) +
        '</span><span class="ds">' +
        fmtBytes(i.size) +
        '</span></div>'
      );
    });
    if (valid.length > 12) list.push('<div class="delete-item"><span class="dp">还有 ' + (valid.length - 12) + ' 项…</span><span></span></div>');
    $('#deleteList').innerHTML = list.join('');
    $('#deleteNotice').innerHTML = permanent
      ? '<svg><use href="#i-alert"/></svg><span>永久删除会立即释放 C 盘空间，但文件无法恢复。请确认已不再需要。</span>'
      : '<svg><use href="#i-info"/></svg><span>移到回收站后，文件仍占用 C 盘空间；清空回收站后才会真正释放。工具会优先使用系统回收站，可在资源管理器中还原。</span>';
    $('#permanentConfirmLine').classList.toggle('hidden', !permanent);
    $('#permanentConfirm').checked = false;
    const btn = $('#confirmDeleteBtn');
    btn.textContent = permanent ? '永久删除' : '移到回收站';
    btn.classList.toggle('btn-danger', true);
    btn.disabled = permanent;
    $('#confirmDeleteBtn').innerHTML = permanent
      ? '<svg><use href="#i-trash"/></svg> 永久删除'
      : '<svg><use href="#i-recycle"/></svg> 移到回收站';
    $('#deleteModal').classList.remove('hidden');
  }

  function closeDeleteModal() {
    if (state.deleteBusy) return;
    $('#deleteModal').classList.add('hidden');
    state.deleteItems = [];
  }

  async function confirmDelete() {
    if (state.deleteBusy) return;
    const permanent = state.deleteMode === 'permanent';
    if (permanent && !$('#permanentConfirm').checked) return;
    const paths = [];
    for (const item of state.deleteItems) {
      if (item.paths && item.paths.length) paths.push(...item.paths);
      else if (item.path) paths.push(item.path);
    }
    const unique = Array.from(new Set(paths));
    if (!unique.length) return;
    state.deleteBusy = true;
    const btn = $('#confirmDeleteBtn');
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="loader" style="width:14px;height:14px;border-width:2px"></span> 正在处理…';
    try {
      const res = await api(permanent ? '/api/delete' : '/api/recycle', {
        method: 'POST',
        body: permanent ? { paths: unique, confirm: 'DELETE' } : { paths: unique },
      });
      state.deleteBusy = false;
      $('#deleteModal').classList.add('hidden');
      state.deleteItems = [];
      state.checked.clear();
      state.selected = null;
      if (res.failCount) {
        showResultModal(res, permanent);
      }
      if (res.okCount) {
        const freed = permanent ? res.freedBytes || 0 : res.recycledBytes || 0;
        toast(
          permanent ? '已永久删除' : '已移到回收站',
          permanent
            ? '成功 ' + res.okCount + ' 项，释放 ' + fmtBytes(freed) + '。'
            : '成功 ' + res.okCount + ' 项，共 ' + fmtBytes(freed) + '。清空回收站后释放空间。',
          'success',
          permanent ? '' : '打开回收站',
          permanent ? null : openRecycleBin
        );
      } else if (!res.failCount) {
        toast('没有发生更改', '', 'info');
      }
      await refreshAfterDelete(unique);
    } catch (e) {
      state.deleteBusy = false;
      btn.disabled = permanent;
      btn.innerHTML = old;
      toast('删除失败', e.message, 'error');
    }
  }

  async function refreshAfterDelete(deletedPaths) {
    try {
      const o = await api('/api/overview');
      state.overview = o;
      renderCapacity(o);
      renderStatus();
    } catch (_) {}
    const currentKey = keyFor(state.path);
    const hit = deletedPaths.find((p) => {
      const k = keyFor(p);
      return k === currentKey || currentKey.startsWith(k + '\\');
    });
    if (hit) {
      const target = keyFor(hit) === currentKey ? parentPath(state.path) : parentPath(hit);
      await loadPath(target || 'C:\\', { push: true });
    } else {
      await loadPath(state.path, { push: false });
    }
  }

  function showResultModal(res, permanent) {
    const results = res.results || [];
    const fails = results.filter((r) => !r.ok);
    $('#resultIcon').className = 'modal-icon ' + (fails.length ? 'danger' : 'success');
    $('#resultIcon').innerHTML = '<svg><use href="#' + (fails.length ? 'i-alert' : 'i-check') + '"/></svg>';
    $('#resultTitle').textContent = fails.length ? '部分项目未能删除' : '操作完成';
    $('#resultSub').textContent = '成功 ' + (res.okCount || 0) + ' 项，失败 ' + (res.failCount || fails.length) + ' 项。';
    $('#resultList').innerHTML = fails
      .map(
        (r) =>
          '<div class="result-row"><span class="ri fail"><svg><use href="#i-alert"/></svg></span><div><div class="rp">' +
          escapeHtml(r.path || '') +
          '</div><div class="re">' +
          escapeHtml(r.error || '未知错误') +
          '</div></div></div>'
      )
      .join('');
    $('#resultModal').classList.remove('hidden');
  }

  // ---------- 清理建议 ----------
  async function openSuggestions() {
    if (state.scanning) {
      toast('扫描正在进行', '请等待扫描完成后再生成清理建议。', 'info');
      return;
    }
    $('#scrim').classList.remove('hidden');
    $('#suggestDrawer').classList.remove('hidden');
    $('#suggestBody').innerHTML = '<div class="drawer-loading"><div class="loader"></div><span>正在统计可清理项目…</span></div>';
    $('#suggestDeleteBtn').disabled = true;
    state.suggestChecked.clear();
    state.suggestItems = [];
    $('#selectSafeChk').checked = false;
    try {
      const [data, recycle] = await Promise.all([
        api('/api/suggestions'),
        api('/api/recycle-info').catch(() => ({ count: 0, size: 0, unavailable: true })),
      ]);
      state.suggestItems = data.items || [];
      state.suggestBigDirs = data.bigDirs || [];
      state.suggestSystem = data.system || [];
      renderSuggestions(recycle);
    } catch (e) {
      $('#suggestBody').innerHTML =
        '<div class="canvas-empty" style="position:static;background:none;padding:40px 10px"><h3>无法生成清理建议</h3><p>' +
        escapeHtml(e.message) +
        '</p></div>';
    }
  }

  function closeSuggestions() {
    $('#suggestDrawer').classList.add('hidden');
    $('#scrim').classList.add('hidden');
  }

  function renderSuggestions(recycle) {
    const body = $('#suggestBody');
    const groups = [
      { id: 'safe', title: '推荐清理', desc: '缓存和临时文件，通常可安全重建', items: [] },
      { id: 'caution', title: '谨慎清理', desc: '开发缓存或系统缓存，删除后可能需重新下载 / 首次变慢', items: [] },
      { id: 'apps', title: '应用数据', desc: '可能包含登录状态、配置或本地项目，删除前务必确认', items: [] },
      { id: 'system', title: '系统清理建议', desc: '不要直接删除，建议使用系统自带的清理工具', items: [] },
    ];
    for (const item of state.suggestItems) {
      const g = groups.find((x) => x.id === item.group);
      if (g) g.items.push(item);
    }
    let html = '';
    for (const g of groups) {
      if (!g.items.length) continue;
      const total = g.items.reduce((s, i) => s + (i.size || 0), 0);
      html +=
        '<section class="sg-section" data-group="' +
        g.id +
        '"><div class="sg-section-head"><h3>' +
        escapeHtml(g.title) +
        '</h3><span>' +
        g.items.length +
        ' 项 · ' +
        fmtBytes(total) +
        '</span></div><div class="sg-desc summary-note" style="margin:-2px 0 8px;font-size:9px">' +
        escapeHtml(g.desc) +
        '</div>';
      for (const item of g.items) {
        html += suggestionCard(item);
      }
      html += '</section>';
    }

    // 系统与回收站
    html +=
      '<section class="sg-section"><div class="sg-section-head"><h3>系统与回收站</h3><span>建议使用系统工具处理</span></div>' +
      '<div class="sg-card no-check" id="recycleCard"><div class="sg-main"><div class="sg-title-line"><span class="sg-title">回收站</span><span class="sg-badge badge-system">系统</span></div>' +
      '<div class="sg-note">已移到回收站的文件仍占用磁盘空间，清空后才会释放。' +
      (recycle && recycle.size ? ' 当前回收站约 ' + fmtBytes(recycle.size) + '。' : '') +
      '</div><div class="sg-actions"><button class="btn btn-ghost" data-recycle-open="1"><svg><use href="#i-recycle"/></svg> 打开回收站</button></div></div>' +
      '<div class="sg-size">' +
      (recycle && recycle.size ? fmtBytes(recycle.size) : '—') +
      '<small>' +
      (recycle && recycle.count ? recycle.count + ' 项' : '') +
      '</small></div></div>';
    for (const s of state.suggestSystem) {
      html +=
        '<div class="sg-card no-check"><div class="sg-main"><div class="sg-title-line"><span class="sg-title">' +
        escapeHtml(s.label) +
        '</span><span class="sg-badge badge-system">系统</span></div><div class="sg-note">' +
        escapeHtml(s.note) +
        '</div><div class="sg-path">' +
        escapeHtml(s.path) +
        '</div></div><div class="sg-size">' +
        fmtBytes(s.size) +
        '</div></div>';
    }
    html += '</section>';

    if (state.suggestBigDirs.length) {
      html +=
        '<section class="sg-section"><div class="sg-section-head"><h3>空间大户 · 快速前往</h3><span>点击在树图中查看</span></div><div class="bigdir-chips">' +
        state.suggestBigDirs
          .map(
            (d) =>
              '<button class="bigdir-chip" data-bigdir="' +
              escapeHtml(d.path) +
              '"><span>' +
              escapeHtml(d.path) +
              '</span><b>' +
              fmtBytes(d.size) +
              '</b></button>'
          )
          .join('') +
        '</div></section>';
    }
    body.innerHTML = html;

    // 绑定卡片
    body.querySelectorAll('.sg-card[data-id]').forEach((card) => {
      const chk = card.querySelector('input[type="checkbox"]');
      if (!chk) return;
      card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target === chk) return;
        chk.checked = !chk.checked;
        chk.dispatchEvent(new Event('change'));
      });
      chk.addEventListener('change', () => {
        const id = card.getAttribute('data-id');
        if (chk.checked) state.suggestChecked.add(id);
        else state.suggestChecked.delete(id);
        card.classList.toggle('checked', chk.checked);
        updateSuggestTotal();
      });
    });
    const recycleOpen = body.querySelector('[data-recycle-open]');
    if (recycleOpen) recycleOpen.addEventListener('click', openRecycleBin);
    body.querySelectorAll('[data-bigdir]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = b.getAttribute('data-bigdir');
        closeSuggestions();
        loadPath(p, { push: true });
      });
    });
    updateSuggestTotal();
  }

  function suggestionCard(item) {
    const checked = state.suggestChecked.has(item.id);
    const badge =
      item.risk === 'safe'
        ? '<span class="sg-badge badge-safe">安全</span>'
        : item.risk === 'caution'
        ? '<span class="sg-badge badge-caution">谨慎</span>'
        : '';
    const pathText =
      item.paths.length > 1 ? item.paths.length + ' 个位置 · ' + item.paths[0] : item.paths[0] || '';
    return (
      '<div class="sg-card' +
      (checked ? ' checked' : '') +
      (item.noDelete ? ' no-check' : '') +
      '" data-id="' +
      escapeHtml(item.id) +
      '">' +
      (item.noDelete ? '' : '<input type="checkbox" ' + (checked ? 'checked' : '') + ' aria-label="选择 ' + escapeHtml(item.label) + '">') +
      '<div class="sg-main"><div class="sg-title-line"><span class="sg-title">' +
      escapeHtml(item.label) +
      '</span>' +
      badge +
      '</div><div class="sg-note">' +
      escapeHtml(item.note) +
      '</div><div class="sg-path" title="' +
      escapeHtml(item.paths.join('\n')) +
      '">' +
      escapeHtml(pathText) +
      '</div></div>' +
      '<div class="sg-size">' +
      fmtBytes(item.size) +
      (item.partial ? '<small>估算</small>' : '<small>' + (item.paths.length > 1 ? item.paths.length + ' 个位置' : '') + '</small>') +
      '</div></div>'
    );
  }

  function updateSuggestTotal() {
    let total = 0;
    for (const id of state.suggestChecked) {
      const item = state.suggestItems.find((x) => x.id === id);
      if (item) total += item.size || 0;
    }
    $('#suggestTotal').textContent = fmtBytes(total);
    $('#suggestDeleteBtn').disabled = state.suggestChecked.size === 0;
    const safeItems = state.suggestItems.filter((i) => i.group === 'safe' && !i.noDelete);
    const allSafe = safeItems.length > 0 && safeItems.every((i) => state.suggestChecked.has(i.id));
    $('#selectSafeChk').checked = allSafe;
  }

  function onSuggestDelete() {
    const selected = state.suggestItems.filter((i) => state.suggestChecked.has(i.id) && !i.noDelete);
    if (!selected.length) return;
    const items = selected.map((s) => ({
      name: s.label,
      path: s.paths[0],
      paths: s.paths,
      size: s.size,
      isDir: true,
      deletable: true,
      protected: false,
    }));
    closeSuggestions();
    openDeleteModal('recycle', items);
  }

  // ---------- 其他操作 ----------
  async function openPath(p, select = false) {
    try {
      await api('/api/open', { method: 'POST', body: { path: p, select } });
    } catch (e) {
      toast('无法打开位置', e.message, 'error');
    }
  }

  async function openRecycleBin() {
    try {
      await api('/api/open', { method: 'POST', body: { special: 'recycle' } });
    } catch (e) {
      toast('无法打开回收站', e.message, 'error');
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制路径', text, 'success');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制路径', text, 'success');
    }
  }

  function showCanvasLoading(on) {
    $('#canvasLoading').classList.toggle('hidden', !on);
  }

  function showCanvasEmpty(kind, message = '') {
    const el = $('#canvasEmpty');
    el.classList.remove('hidden');
    if (kind === 'no-scan') {
      el.innerHTML =
        '<h3>还没有扫描数据</h3><p>需要先扫描 C 盘，生成空间占用快照。扫描在本机运行，不会上传任何文件信息。</p><button class="btn btn-accent" id="startScanEmpty">开始扫描 C 盘</button>';
      const b = $('#startScanEmpty');
      if (b) b.addEventListener('click', triggerRescan);
    } else if (kind === 'error') {
      el.innerHTML =
        '<h3>无法读取此目录</h3><p>' +
        escapeHtml(message) +
        '</p><button class="btn btn-ghost" id="backOnError">返回上一级</button>';
      const b = $('#backOnError');
      if (b) b.addEventListener('click', () => loadPath(parentPath(state.path), { push: true }));
    } else if (kind === 'no-items') {
      el.innerHTML =
        '<h3>这个目录没有可显示的内容</h3><p>可能是空文件夹，或其中的项目全部无法访问。</p>';
    }
  }

  function hideCanvasEmpty() {
    $('#canvasEmpty').classList.add('hidden');
  }

  // ---------- 扫描轮询 ----------
  function schedulePoll(delay = 1400) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollStatus, delay);
  }

  async function pollStatus() {
    try {
      const res = await api('/api/status');
      const p = res.progress;
      const prev = state.wasScanning;
      renderScanUI(p);
      const scanning = !!(p && p.phase === 'scanning' && p.ageMs < 16000);
      state.wasScanning = scanning;
      if (scanning) {
        state.pendingScanReload = true;
        renderCapacityLive(p);
        if (res.liveMtime && res.liveMtime !== state.liveVersion) {
          state.liveVersion = res.liveMtime;
          await refreshLiveView();
        }
        schedulePoll(1400);
        return;
      }
      state.liveVersion = 0;
      if (prev || state.pendingScanReload) {
        state.pendingScanReload = false;
        await finishScan();
      }
    } catch (e) {
      schedulePoll(3000);
    }
  }

  async function finishScan() {
    try {
      const o = await api('/api/overview');
      state.overview = o;
      renderCapacity(o);
      renderScanUI(o.progress);
      renderStatus();
      const target = state.path || 'C:\\';
      await loadPath(target, { push: false });
      toast('扫描完成', '空间数据已更新，可以开始按大小清理。', 'success');
    } catch (e) {
      toast('刷新扫描数据失败', e.message, 'error');
    }
  }

  async function triggerRescan() {
    if (state.scanning) return;
    try {
      const r = await api('/api/scan', { method: 'POST', body: {} });
      if (!r.started) {
        toast('扫描正在进行', r.reason || '', 'info');
        schedulePoll(1000);
        return;
      }
      state.pendingScanReload = true;
      state.wasScanning = true;
      toast('已开始重新扫描', '方块图会随扫描进度实时更新；完成后可删除。', 'info');
      schedulePoll(900);
    } catch (e) {
      toast('无法开始扫描', e.message, 'error');
    }
  }

  // ---------- 搜索 ----------
  const searchInput = $('#searchInput');
  const searchDropdown = $('#searchDropdown');

  async function performSearch(q) {
    if (!q || q.length < 2) {
      hideSearchDropdown();
      return;
    }
    searchDropdown.classList.remove('hidden');
    searchDropdown.innerHTML = '<div class="search-head">全盘搜索目录</div><div class="search-empty">正在搜索…</div>';
    try {
      const res = await api('/api/search?q=' + encodeURIComponent(q));
      state.searchResults = res.results || [];
      state.searchIndex = res.results.length ? 0 : -1;
      renderSearchResults();
    } catch (e) {
      searchDropdown.innerHTML = '<div class="search-empty">搜索失败：' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderSearchResults() {
    if (!state.searchResults.length) {
      searchDropdown.innerHTML = '<div class="search-empty">没有找到匹配的目录。试试以“cache”“Temp”“node_modules”搜索。</div>';
      return;
    }
    searchDropdown.innerHTML =
      '<div class="search-head">找到 ' +
      state.searchResults.length +
      ' 个目录 · 按大小排序</div>' +
      state.searchResults
        .map(
          (r, i) =>
            '<div class="search-item' +
            (i === state.searchIndex ? ' active' : '') +
            '" data-i="' +
            i +
            '"><span class="si-icon"><svg><use href="#i-folder"/></svg></span><div><div class="si-name">' +
            escapeHtml(basename(r.path)) +
            '</div><div class="si-path">' +
            escapeHtml(r.path) +
            '</div></div><span class="si-size">' +
            fmtBytes(r.size) +
            '</span></div>'
        )
        .join('');
    searchDropdown.querySelectorAll('.search-item').forEach((el) => {
      el.addEventListener('click', () => {
        const r = state.searchResults[Number(el.getAttribute('data-i'))];
        if (r) {
          hideSearchDropdown();
          searchInput.value = '';
          loadPath(r.path, { push: true });
        }
      });
    });
  }

  function hideSearchDropdown() {
    searchDropdown.classList.add('hidden');
    state.searchResults = [];
    state.searchIndex = -1;
  }

  const debouncedSearch = debounce((q) => performSearch(q), 280);
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      hideSearchDropdown();
      return;
    }
    debouncedSearch(q);
  });
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2 && state.searchResults.length) searchDropdown.classList.remove('hidden');
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSearchDropdown();
      searchInput.blur();
      return;
    }
    if (!state.searchResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.searchIndex = Math.min(state.searchResults.length - 1, state.searchIndex + 1);
      renderSearchResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.searchIndex = Math.max(0, state.searchIndex - 1);
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = state.searchResults[state.searchIndex] || state.searchResults[0];
      if (r) {
        hideSearchDropdown();
        searchInput.value = '';
        loadPath(r.path, { push: true });
      }
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchWrap')) hideSearchDropdown();
  });

  // ---------- 事件绑定 ----------
  $('#backBtn').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else if (keyFor(state.path) !== 'c:\\') loadPath(parentPath(state.path), { push: true });
  });
  $('#upBtn').addEventListener('click', () => {
    if (keyFor(state.path) !== 'c:\\') loadPath(parentPath(state.path), { push: true });
  });
  $('#rescanBtn').addEventListener('click', triggerRescan);
  $('#suggestBtn').addEventListener('click', openSuggestions);
  $('#recycleBtn').addEventListener('click', openRecycleBin);
  $('#suggestCloseBtn') && $('#suggestCloseBtn').addEventListener('click', closeSuggestions);
  $('#closeDrawerBtn').addEventListener('click', closeSuggestions);
  $('#scrim').addEventListener('click', closeSuggestions);
  $('#suggestDeleteBtn').addEventListener('click', onSuggestDelete);
  $('#selectSafeChk').addEventListener('change', (e) => {
    const on = e.target.checked;
    for (const item of state.suggestItems) {
      if (item.group !== 'safe' || item.noDelete) continue;
      if (on) state.suggestChecked.add(item.id);
      else state.suggestChecked.delete(item.id);
    }
    $$('#suggestBody .sg-card[data-id]').forEach((card) => {
      const id = card.getAttribute('data-id');
      const chk = card.querySelector('input[type="checkbox"]');
      if (!chk) return;
      const item = state.suggestItems.find((x) => x.id === id);
      if (!item || item.group !== 'safe') return;
      chk.checked = state.suggestChecked.has(id);
      card.classList.toggle('checked', chk.checked);
    });
    updateSuggestTotal();
  });

  $('#nestToggle').addEventListener('click', () => {
    state.nesting = !state.nesting;
    $('#nestToggle .switch').classList.toggle('on', state.nesting);
    try {
      localStorage.setItem('cdrive.nesting', state.nesting ? '1' : '0');
    } catch (_) {}
    scheduleDraw();
  });

  $('#selectAllBtn').addEventListener('click', () => {
    if (state.scanning) {
      toast('扫描正在进行', '请等待扫描完成后再选择删除项目。', 'info');
      return;
    }
    for (const i of state.currentItems) {
      if (i.deletable && i.path && i.kind !== 'bucket' && i.kind !== 'system') state.checked.set(i.key, i);
    }
    updateListSelection();
    updateTray();
  });
  $('#clearSelBtn').addEventListener('click', () => {
    state.checked.clear();
    updateListSelection();
    updateTray();
  });
  $('#trayDeleteBtn').addEventListener('click', () => {
    const items = Array.from(state.checked.values());
    if (items.length) openDeleteModal('recycle', items);
  });

  $('#itemList').addEventListener('click', onListClick);
  $('#itemList').addEventListener('dblclick', onListDblClick);

  $('#closeDeleteBtn').addEventListener('click', closeDeleteModal);
  $('#cancelDeleteBtn').addEventListener('click', closeDeleteModal);
  $('#permanentConfirm').addEventListener('change', (e) => {
    if (state.deleteMode === 'permanent') $('#confirmDeleteBtn').disabled = !e.target.checked;
  });
  $('#confirmDeleteBtn').addEventListener('click', confirmDelete);
  $('#deleteModal').addEventListener('click', (e) => {
    if (e.target === $('#deleteModal')) closeDeleteModal();
  });
  $('#closeResultBtn').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
  $('#resultOkBtn').addEventListener('click', () => $('#resultModal').classList.add('hidden'));
  $('#resultModal').addEventListener('click', (e) => {
    if (e.target === $('#resultModal')) $('#resultModal').classList.add('hidden');
  });

  $('#helpBtn').addEventListener('click', () => $('#helpModal').classList.remove('hidden'));
  $('#closeHelpBtn').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
  $('#helpOkBtn').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
  $('#helpModal').addEventListener('click', (e) => {
    if (e.target === $('#helpModal')) $('#helpModal').classList.add('hidden');
  });

  window.addEventListener('popstate', () => {
    const p = pathFromHash();
    if (p && keyFor(p) !== keyFor(state.path)) loadPath(p, { push: false });
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === 'Escape') {
      if (!$('#helpModal').classList.contains('hidden')) {
        $('#helpModal').classList.add('hidden');
        return;
      }
      if (!$('#resultModal').classList.contains('hidden')) {
        $('#resultModal').classList.add('hidden');
        return;
      }
      if (!$('#deleteModal').classList.contains('hidden')) {
        closeDeleteModal();
        return;
      }
      if (!$('#suggestDrawer').classList.contains('hidden')) {
        closeSuggestions();
        return;
      }
      if (!typing) {
        state.selected = null;
        renderInspector();
        updateListSelection();
        scheduleDraw();
      }
    }
    if (typing) return;
    if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
      e.preventDefault();
      if (keyFor(state.path) !== 'c:\\') loadPath(parentPath(state.path), { push: true });
    }
    if (e.key === 'Delete') {
      const items = state.checked.size
        ? Array.from(state.checked.values())
        : state.selected && state.selected.deletable !== false
        ? [state.selected]
        : [];
      if (items.length) {
        e.preventDefault();
        openDeleteModal('recycle', items.filter((i) => i && i.deletable && i.path));
      }
    }
    if (e.key === 'Enter' && state.selected && state.selected.kind === 'dir' && state.selected.path) {
      if (!$('#deleteModal').classList.contains('hidden') || !$('#suggestDrawer').classList.contains('hidden')) return;
      loadPath(state.selected.path, { push: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.liveVersion = 0;
      schedulePoll(200);
    }
  });

  // 外部点击关闭搜索
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#searchWrap')) hideSearchDropdown();
  });

  // ---------- 初始化 ----------
  function applyNestingPref() {
    try {
      const v = localStorage.getItem('cdrive.nesting');
      if (v === '0') state.nesting = false;
    } catch (_) {}
    $('#nestToggle .switch').classList.toggle('on', state.nesting);
  }

  async function init() {
    applyNestingPref();
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(holder);
    resizeCanvas();
    await loadOverview();
    if (!state.data) {
      const prog = state.overview && state.overview.progress;
      const waitingScan = !!(prog && prog.phase === 'scanning' && !(state.overview && state.overview.scan));
      if (!waitingScan) {
        const p = pathFromHash() || 'C:\\';
        await loadPath(p, { push: false });
      } else {
        state.wasScanning = true;
        schedulePoll(900);
      }
    }
    const prog = state.overview && state.overview.progress;
    if (prog && prog.phase === 'scanning') {
      state.wasScanning = true;
      schedulePoll(800);
    }
  }

  init();
})();
