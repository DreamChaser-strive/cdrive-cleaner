#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = process.env.CDRIVE_DATA_DIR
  ? path.resolve(process.env.CDRIVE_DATA_DIR)
  : path.join(APP_DIR, 'data');
const RECYCLE_PS1 = path.join(APP_DIR, 'recycle.ps1');
const PORT = Number(process.env.PORT || 17878);
const TOKEN = crypto.randomBytes(24).toString('hex');
const IS_WIN = process.platform === 'win32';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 路径与安全 ----------
const HOME = process.env.USERPROFILE || os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const SYSTEM_DRIVE = String(process.env.SystemDrive || 'C:')
  .replace(/:/g, '')
  .toUpperCase() || 'C';

function driveFiles(letter) {
  const suffix = letter === SYSTEM_DRIVE ? '' : '.' + letter;
  return {
    scan: path.join(DATA_DIR, `scan${suffix}.json`),
    progress: path.join(DATA_DIR, `progress${suffix}.json`),
    live: path.join(DATA_DIR, `scan.live${suffix}.json`),
    tmp: path.join(DATA_DIR, `scan${suffix}.json.tmp`),
    liveTmp: path.join(DATA_DIR, `scan.live${suffix}.json.tmp`),
  };
}

const USER_PROTECTED = [
  path.join(HOME).toLowerCase(),
  path.join(HOME, 'Desktop').toLowerCase(),
  path.join(HOME, 'Documents').toLowerCase(),
  path.join(HOME, 'Downloads').toLowerCase(),
  path.join(HOME, 'Pictures').toLowerCase(),
  path.join(HOME, 'Videos').toLowerCase(),
  path.join(HOME, 'Music').toLowerCase(),
  path.join(HOME, 'OneDrive').toLowerCase(),
  path.join(HOME, 'AppData').toLowerCase(),
  path.join(HOME, 'AppData', 'Local').toLowerCase(),
  path.join(HOME, 'AppData', 'LocalLow').toLowerCase(),
  path.join(HOME, 'AppData', 'Roaming').toLowerCase(),
  path.join(HOME, '.ssh').toLowerCase(),
  path.join(HOME, '.gnupg').toLowerCase(),
  path.join(HOME, '..', 'Public').toLowerCase(),
].map((x) => x.replace(/\\+$/, '').toLowerCase());

const ALWAYS_BLOCKED_ROOT_NAMES = [
  '$recycle.bin',
  'system volume information',
  'recovery',
  'boot',
  'efi',
  'krecycle',
];
const SYSTEM_BLOCKED_ROOT_NAMES = ['windows', 'program files', 'program files (x86)', 'programdata', 'users'];

function normPath(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let p = path.win32.normalize(input.trim());
  if (!/^[a-zA-Z]:\\/.test(p)) return null;
  p = p[0].toUpperCase() + p.slice(1);
  if (p.length > 3) p = p.replace(/\\+$/, '');
  return p;
}
function keyOf(p) {
  return p.toLowerCase();
}
function driveOf(p) {
  return String(p || '').charAt(0).toUpperCase();
}
function driveRoot(letter) {
  return letter.toUpperCase() + ':\\';
}
function checkDeletable(p) {
  const key = keyOf(p);
  const letter = driveOf(key);
  if (!/^[a-z]:\\/.test(key)) return '路径无效，仅支持本地磁盘';
  const root = letter.toLowerCase() + ':\\';
  if (key === root) return `不能删除整个 ${letter} 盘`;
  if (USER_PROTECTED.includes(key)) return '这是用户重要目录，已禁止删除';
  if (key === APP_DIR.toLowerCase() || key === DATA_DIR.toLowerCase()) return '清理工具自身目录不可删除';

  for (const name of ALWAYS_BLOCKED_ROOT_NAMES) {
    const prefix = root + name;
    if (key === prefix || key.startsWith(prefix + '\\')) return '回收站、启动分区或系统保留区域不可直接删除';
  }
  if (letter === SYSTEM_DRIVE) {
    for (const name of SYSTEM_BLOCKED_ROOT_NAMES) {
      const prefix = root + name;
      if (key === prefix || key.startsWith(prefix + '\\')) {
        return '系统盘的系统 / 程序目录受保护，请通过卸载或系统工具清理';
      }
    }
  }

  const base = path.win32.basename(key);
  if (letter === SYSTEM_DRIVE && ['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr'].includes(base)) {
    return '系统关键文件不可删除';
  }
  if (key.startsWith(APP_DIR.toLowerCase() + '\\') || key === APP_DIR.toLowerCase()) {
    return '清理工具自身目录不可删除';
  }
  if (key.startsWith(DATA_DIR.toLowerCase() + '\\') || key === DATA_DIR.toLowerCase()) {
    return '清理工具数据目录不可删除';
  }
  return null;
}

// ---------- 扫描数据（按盘符隔离） ----------
const driveStates = new Map();

function stateFor(letter) {
  const L = String(letter || SYSTEM_DRIVE).toUpperCase();
  let st = driveStates.get(L);
  if (!st) {
    const files = driveFiles(L);
    st = {
      letter: L,
      root: driveRoot(L),
      files,
      scan: null,
      scanMtime: 0,
      dirsMap: new Map(),
      live: null,
      liveMtime: 0,
      liveMap: new Map(),
      progressCache: { at: 0, value: null },
      driveCache: { at: 0, value: null },
      lockedCache: { at: 0, value: [] },
      process: null,
      saveTimer: null,
    };
    driveStates.set(L, st);
  }
  return st;
}

function loadScan(st, force = false) {
  try {
    const fileStat = fs.statSync(st.files.scan);
    if (!force && st.scan && fileStat.mtimeMs === st.scanMtime) return true;
    const raw = fs.readFileSync(st.files.scan, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !data.dirs) return false;
    st.scan = data;
    st.scanMtime = fileStat.mtimeMs;
    st.dirsMap = new Map(Object.entries(st.scan.dirs));
    return true;
  } catch (_) {
    return false;
  }
}

function loadLive(st, force = false) {
  try {
    const fileStat = fs.statSync(st.files.live);
    if (!force && st.live && fileStat.mtimeMs === st.liveMtime) return true;
    const data = JSON.parse(fs.readFileSync(st.files.live, 'utf8'));
    if (!data || !data.dirs) return false;
    const map = new Map(Object.entries(data.dirs));
    const children = new Map();
    for (const [key, rec] of map) {
      if (!rec.parent) continue;
      if (!children.has(rec.parent)) children.set(rec.parent, []);
      const parentRec = map.get(rec.parent);
      const name = parentRec
        ? String(rec.p).slice(String(parentRec.p).length).replace(/^\\/, '')
        : path.win32.basename(rec.p);
      children.get(rec.parent).push([name, rec.s, key]);
    }
    for (const [parentKey, list] of children) {
      list.sort((a, b) => b[1] - a[1]);
      const parentRec = map.get(parentKey);
      if (!parentRec) continue;
      const listed = list.slice(0, 300);
      let omitted = 0;
      for (let i = 300; i < list.length; i++) omitted += list[i][1];
      parentRec.c = listed.map((x) => [x[0], x[1]]);
      parentRec.childKeys = listed.map((x) => x[2]);
      parentRec.listedChildSize = listed.reduce((s, x) => s + x[1], 0);
      parentRec.omittedChildSize = omitted;
    }
    st.live = data;
    st.liveMap = map;
    st.liveMtime = fileStat.mtimeMs;
    return true;
  } catch (_) {
    st.live = null;
    st.liveMap = new Map();
    st.liveMtime = 0;
    return false;
  }
}

function readProgress(st) {
  try {
    const fileStat = fs.statSync(st.files.progress);
    const p = JSON.parse(fs.readFileSync(st.files.progress, 'utf8'));
    return { ...p, ageMs: Date.now() - fileStat.mtimeMs };
  } catch (_) {
    return null;
  }
}

function cachedProgress(st) {
  if (Date.now() - st.progressCache.at > 500) {
    st.progressCache = { at: Date.now(), value: readProgress(st) };
  }
  return st.progressCache.value;
}

function isScanning(st, progress = cachedProgress(st)) {
  return !!(progress && progress.phase === 'scanning' && progress.ageMs < 12000);
}

function liveRecord(st, key) {
  const rec = st.liveMap.get(key);
  if (!rec) return null;
  const listed = rec.listedChildSize || 0;
  return {
    p: rec.p,
    s: rec.s,
    d: rec.d || 0,
    fc: 0,
    dc: rec.dc || (rec.c ? rec.c.length : 0),
    c: rec.c || [],
    o: rec.omittedChildSize || Math.max(0, rec.s - (rec.d || 0) - listed),
    e: 0,
    live: true,
  };
}

function cachedRec(st, p) {
  const key = keyOf(p);
  if (isScanning(st)) {
    const lr = liveRecord(st, key);
    if (lr) return lr;
  }
  if (!st.scan) loadScan(st);
  if (!st.scan) return null;
  return st.dirsMap.get(key) || null;
}

function saveScanSoon(st) {
  if (!st.scan) return;
  clearTimeout(st.saveTimer);
  st.saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(st.files.tmp, JSON.stringify(st.scan));
      fs.renameSync(st.files.tmp, st.files.scan);
      try {
        st.scanMtime = fs.statSync(st.files.scan).mtimeMs;
      } catch (_) {}
    } catch (_) {}
  }, 800);
}

// ---------- 磁盘容量与盘符（完全按本机实际挂载情况识别，不预设盘符） ----------
let driveListCache = { at: 0, value: null };

function makeDrive(letter, info) {
  const i = info || {};
  const total = Number(i.total || 0);
  const free = Number(i.free || 0);
  return {
    letter,
    root: driveRoot(letter),
    label: String(i.label || '').trim(),
    total,
    used: Math.max(0, total - free),
    free,
    removable: i.removable === true,
    system: letter === SYSTEM_DRIVE,
  };
}

function sortDrives(drives) {
  return drives.sort((a, b) => (a.system === b.system ? a.letter.localeCompare(b.letter) : a.system ? -1 : 1));
}

// 逐个盘符探测本机实际挂载的磁盘：WMI / PowerShell 不可用时的兜底通道
function probeMountedDrives() {
  const found = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = driveRoot(letter);
    try {
      fs.accessSync(root, fs.constants.R_OK);
    } catch (_) {
      continue;
    }
    let total = 0;
    let free = 0;
    try {
      if (typeof fs.statfsSync === 'function') {
        const s = fs.statfsSync(root);
        total = Number(s.blocks || 0) * Number(s.bsize || 0);
        free = Number(s.bavail || 0) * Number(s.bsize || 0);
      }
    } catch (_) {}
    if (!(total > 0)) continue;
    found.push(makeDrive(letter, { total, free }));
  }
  return found;
}

// Win32_LogicalDisk 的 DriveType：2=可移动 3=本地固定 4=网络 5=光驱 6=内存盘
function normalizeDriveList(rows) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const known = new Set();
  const drives = [];
  for (const x of list) {
    const letter = String((x && (x.DeviceID || x.letter)) || '').charAt(0).toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    known.add(letter);
    const type = Number(x && x.DriveType);
    if (type !== 2 && type !== 3) continue; // 网络盘 / 光驱 / 内存盘不参与本地清理
    const total = Number((x && x.Size) || 0);
    if (!(total > 0)) continue; // 读卡器等没有媒体的盘符
    drives.push(
      makeDrive(letter, {
        total,
        free: Number((x && x.FreeSpace) || 0),
        label: x && x.VolumeName,
        removable: type === 2,
      })
    );
  }
  // WMI 没报告、但系统里确实挂载着的盘符，用文件系统探测补齐
  for (const d of probeMountedDrives()) {
    if (known.has(d.letter)) continue;
    if (drives.some((x) => x.letter === d.letter)) continue;
    drives.push(d);
  }
  if (!drives.some((d) => d.letter === SYSTEM_DRIVE)) drives.push(makeDrive(SYSTEM_DRIVE));
  return sortDrives(drives);
}

function listDrives(force = false) {
  const now = Date.now();
  if (!force && driveListCache.value && now - driveListCache.at < 30000) {
    return Promise.resolve(driveListCache.value);
  }
  return new Promise((resolve) => {
    const finish = (rows) => {
      let value;
      try {
        value = normalizeDriveList(rows);
      } catch (_) {
        value = [];
      }
      if (!value.length) value = driveListCache.value || [];
      driveListCache = { at: Date.now(), value };
      resolve(value);
    };
    if (!IS_WIN) {
      finish([]);
      return;
    }
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | ConvertTo-Json -Compress',
      ],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          finish([]); // PowerShell / WMI 不可用 → 走盘符探测
          return;
        }
        try {
          finish(JSON.parse(String(stdout).trim() || '[]'));
        } catch (_) {
          finish([]);
        }
      }
    );
  });
}

function getDriveInfo(st) {
  const now = Date.now();
  if (st.driveCache.value && now - st.driveCache.at < 20000) return Promise.resolve(st.driveCache.value);
  return listDrives().then((drives) => {
    const found = drives.find((d) => d.letter === st.letter);
    if (!found) return st.driveCache.value;
    const v = { total: found.total, used: found.used, free: found.free, label: found.label, letter: found.letter };
    st.driveCache = { at: Date.now(), value: v };
    return v;
  });
}

// 受系统锁定、Node 无法 stat 的根目录大文件（休眠/分页文件等）
function getRootLockedFiles(st) {
  if (Date.now() - st.lockedCache.at < 5 * 60 * 1000) return Promise.resolve(st.lockedCache.value);
  return new Promise((resolve) => {
    if (!IS_WIN || st.letter !== SYSTEM_DRIVE) return resolve([]);
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-ChildItem -LiteralPath '${st.root.replace(/'/g, "''")}' -Force -File -ErrorAction SilentlyContinue | Where-Object { @('hiberfil.sys','pagefile.sys','swapfile.sys') -contains $_.Name } | Select-Object Name,Length | ConvertTo-Json -Compress`,
      ],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(st.lockedCache.value);
        try {
          let j = JSON.parse(String(stdout).trim() || '[]');
          if (!Array.isArray(j)) j = j && (j.Name || j.name) ? [j] : [];
          const value = j
            .map((x) => ({
              name: x.Name || x.name,
              size: Number(x.Length != null ? x.Length : x.size),
            }))
            .filter((x) => x.name && x.size > 0);
          st.lockedCache = { at: Date.now(), value };
          resolve(value);
        } catch (_) {
          resolve(st.lockedCache.value);
        }
      }
    );
  });
}

// ---------- 目录内容 ----------
const liveSizeCache = new Map(); // path -> {at, size}

async function measureLimited(target, budgetMs = 2200) {
  const deadline = Date.now() + budgetMs;
  let size = 0;
  let partial = false;
  const stack = [target];
  let entries = 0;
  while (stack.length) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const dir = stack.pop();
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of list) {
      entries++;
      if (entries > 120000) {
        partial = true;
        break;
      }
      const full = path.win32.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          size += st.size;
        } catch (_) {}
      }
    }
  }
  return { size, partial };
}

async function getPathSize(st, p) {
  const rec = cachedRec(st, p);
  if (rec) return { size: rec.s, partial: false, cached: true };
  try {
    const st2 = await fsp.lstat(p);
    if (st2.isFile()) return { size: st2.size, partial: false, cached: false };
    if (!st2.isDirectory()) return { size: 0, partial: false, cached: false };
  } catch (_) {
    return { size: 0, partial: false, cached: false };
  }
  const cached = liveSizeCache.get(keyOf(p));
  if (cached && Date.now() - cached.at < 60000) return cached;
  const m = await measureLimited(p, 1800);
  const value = { size: m.size, partial: m.partial, cached: false };
  liveSizeCache.set(keyOf(p), { at: Date.now(), ...value });
  return value;
}

async function listDirectory(st, p, opts = {}) {
  const liveMode = !!opts.live;
  const rec = cachedRec(st, p);
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch (e) {
    const err = new Error('无法读取该目录：' + (e.code || e.message));
    err.statusCode = 403;
    throw err;
  }

  const dirEntries = [];
  const fileEntries = [];
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) dirEntries.push(ent);
    else if (ent.isFile()) fileEntries.push(ent);
  }

  // 目录大小：优先取扫描缓存
  const dirs = [];
  for (const ent of dirEntries) {
    const childPath = path.win32.join(p, ent.name);
    const childRec = cachedRec(st, childPath);
    let size = childRec ? childRec.s : null;
    if (size == null && rec) {
      const found = (rec.c || []).find((x) => x[0].toLowerCase() === ent.name.toLowerCase());
      if (found) size = found[1];
    }
    if (size == null) {
      if (liveMode) {
        size = 0;
      } else {
        const m = await getPathSize(st, childPath);
        size = m.size;
      }
    }
    const childPreview = childRec && childRec.c ? childRec.c.slice(0, 14).map((x) => [x[0], x[1]]) : [];
    dirs.push({
      name: ent.name,
      path: childPath,
      size,
      cached: !!childRec,
      preview: childPreview,
      protected: !!checkDeletable(childPath),
    });
  }
  dirs.sort((a, b) => b.size - a.size);
  const dirsTop = dirs.slice(0, 400);
  const omittedDirSize = dirs.slice(400).reduce((s, d) => s + d.size, 0);

  // 文件清单：读取大文件名字，超出预算则用扫描快照的总量补足
  const files = [];
  if (!liveMode) {
    const deadline = Date.now() + 3000;
    for (let i = 0; i < fileEntries.length; i += 48) {
      if (Date.now() > deadline && files.length > 50) break;
      const chunk = fileEntries.slice(i, i + 48);
      await Promise.all(
        chunk.map(async (ent) => {
          try {
            const full = path.win32.join(p, ent.name);
            const st = await fsp.stat(full);
            files.push({
              name: ent.name,
              path: full,
              size: st.size,
              ext: path.win32.extname(ent.name).toLowerCase(),
              protected: false,
            });
          } catch (_) {}
        })
      );
    }
  }
  files.sort((a, b) => b.size - a.size);

  const directFilesSize = rec ? rec.d : files.reduce((s, f) => s + f.size, 0);
  const directFileCount = rec ? rec.fc : fileEntries.length;
  const total = rec ? rec.s : dirs.reduce((s, d) => s + d.size, 0) + directFilesSize;
  const otherDirsSize = rec ? rec.o || 0 : 0;
  const listedDirsSize = dirs.reduce((s, d) => s + d.size, 0);
  const filesFoundSize = files.reduce((s, f) => s + f.size, 0);
  // 用快照文件总量修正：返回前 300 个文件，剩余归入“其他文件”
  const topFiles = files.slice(0, 300);
  const topFilesSize = topFiles.reduce((s, f) => s + f.size, 0);
  const filesOmitted = Math.max(0, directFilesSize - topFilesSize);
  const unaccounted = Math.max(
    0,
    total - listedDirsSize - otherDirsSize - directFilesSize
  );

  return {
    path: p,
    name: path.win32.basename(p) || p,
    size: total,
    directFilesSize,
    directFileCount,
    dirCount: rec ? rec.dc : dirEntries.length,
    dirs: dirsTop,
    files: topFiles,
    fileBucket: {
      size: filesOmitted,
      count: Math.max(0, directFileCount - topFiles.length),
    },
    otherBucket: {
      size: otherDirsSize + unaccounted + omittedDirSize,
      count: Math.max(0, dirs.length - dirsTop.length),
      note: '更多小目录 / 快照中未展开的项目',
    },
    cached: !!rec,
    live: liveMode,
    liveMtime: liveMode ? st.liveMtime : 0,
    drive: st.letter,
    scannedAt: st.scan ? st.scan.scannedAt : null,
  };
}

// ---------- 删除与回收站 ----------
function dedupePaths(paths) {
  const valid = [];
  const errs = [];
  const seen = new Set();
  for (const raw of paths) {
    const p = normPath(raw);
    if (!p) {
      errs.push({ path: String(raw), ok: false, error: '无效路径' });
      continue;
    }
    const key = keyOf(p);
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(p);
  }
  valid.sort((a, b) => a.length - b.length);
  const filtered = [];
  const keptKeys = [];
  for (const p of valid) {
    const key = keyOf(p);
    if (keptKeys.some((k) => key.startsWith(k + '\\'))) continue; // 父项已包含
    filtered.push(p);
    keptKeys.push(key);
  }
  return { paths: filtered, errors: errs };
}

async function validateDeletable(paths) {
  const results = [];
  for (const p of paths) {
    const block = checkDeletable(p);
    if (block) {
      results.push({ path: p, ok: false, error: block });
      continue;
    }
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) {
        results.push({ path: p, ok: false, error: '符号链接 / junction 不允许删除' });
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) {
        results.push({ path: p, ok: false, error: '不是常规文件或目录' });
        continue;
      }
      results.push({ path: p, ok: true, isDir: st.isDirectory() });
    } catch (e) {
      results.push({ path: p, ok: false, error: '路径不存在或无法访问' });
    }
  }
  return results;
}

async function getRemovalSize(st, p) {
  const rec = cachedRec(st, p);
  if (rec) return rec.s;
  try {
    const stat = await fsp.lstat(p);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) {
      const m = await measureLimited(p, 1500);
      return m.size;
    }
  } catch (_) {}
  return 0;
}

function wasCachedAtScan(st, p, isDir) {
  if (!st.scan) return false;
  const key = keyOf(p);
  if (st.dirsMap.has(key)) return true;
  let parent = path.win32.dirname(p);
  if (parent.length === 2) parent += '\\';
  const parentRec = st.dirsMap.get(keyOf(parent));
  if (!parentRec) return false;
  const name = path.win32.basename(p).toLowerCase();
  if (isDir && Array.isArray(parentRec.c)) {
    return parentRec.c.some((x) => String(x[0]).toLowerCase() === name);
  }
  try {
    const stat = fs.lstatSync(p);
    const scanStart = Date.parse(st.scan.scannedAt || 0) - (Number(st.scan.elapsedMs) || 0);
    return stat.ctimeMs <= scanStart + 2000;
  } catch (_) {
    return false;
  }
}

function applyRemoval(st, p, size, isDir, existedAtScan) {
  if (!st.scan) return;
  const key = keyOf(p);
  const name = path.win32.basename(p);
  // 删除自身及所有缓存后代
  for (const k of Array.from(st.dirsMap.keys())) {
    if (k === key || k.startsWith(key + '\\')) st.dirsMap.delete(k);
  }
  if (!existedAtScan) {
    // 扫描之后新建的文件/目录不在快照中，祖先缓存无需扣减
    suggestionSizeCache.clear();
    return;
  }
  // 从父级列表中移除
  let parent = path.win32.dirname(p);
  if (parent.length === 2) parent += '\\';
  const parentKey = keyOf(parent);
  const parentRec = st.dirsMap.get(parentKey);
  if (parentRec) {
    let removedFromC = false;
    if (Array.isArray(parentRec.c)) {
      const before = parentRec.c.length;
      parentRec.c = parentRec.c.filter((x) => x[0].toLowerCase() !== name.toLowerCase());
      removedFromC = parentRec.c.length !== before;
    }
    if (!removedFromC && isDir && parentRec.o) {
      parentRec.o = Math.max(0, parentRec.o - size);
    }
    if (isDir) parentRec.dc = Math.max(0, (parentRec.dc || 0) - 1);
    if (!isDir) {
      parentRec.d = Math.max(0, (parentRec.d || 0) - size);
      parentRec.fc = Math.max(0, (parentRec.fc || 0) - 1);
    }
  }
  // 所有祖先（含直接父级与根）各减掉一次大小
  let ancestor = path.win32.dirname(p);
  if (ancestor.length === 2) ancestor += '\\';
  for (let guard = 0; guard < 200; guard++) {
    const rec = st.dirsMap.get(keyOf(ancestor));
    if (rec) rec.s = Math.max(0, rec.s - size);
    if (keyOf(ancestor) === st.root.toLowerCase()) break;
    const next = path.win32.dirname(ancestor);
    if (!next || next === ancestor) break;
    ancestor = next;
    if (ancestor.length === 2) ancestor += '\\';
  }
  if (st.scan && st.scan.stats) st.scan.stats.bytes = Math.max(0, (st.scan.stats.bytes || 0) - size);
  suggestionSizeCache.clear();
  st.scan.modifiedAt = new Date().toISOString();
  saveScanSoon(st);
}

function runRecycle(paths) {
  return new Promise((resolve) => {
    const inputFile = path.join(DATA_DIR, 'recycle-input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ paths }), 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RECYCLE_PS1, inputFile],
      { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(inputFile);
        } catch (_) {}
        const results = [];
        const lines = String(stdout || '').split(/\r?\n/);
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const j = JSON.parse(t);
            if (j && j.path) results.push(j);
          } catch (_) {}
        }
        if (!results.length) {
          for (const p of paths) {
            results.push({
              path: p,
              ok: false,
              error: (err && err.message) || String(stderr || '回收站操作失败').slice(0, 300),
            });
          }
        }
        resolve(results);
      }
    );
  });
}

async function permanentDelete(p, isDir) {
  try {
    if (isDir) {
      await fsp.rm(p, { recursive: true, force: false, maxRetries: 2 });
    } else {
      await fsp.unlink(p);
    }
    return { path: p, ok: true };
  } catch (e) {
    return { path: p, ok: false, error: e.code === 'EBUSY' ? '文件正在被占用' : e.message };
  }
}

// ---------- 清理建议 ----------
const suggestionSizeCache = new Map();

async function sizeForSuggestion(st, paths) {
  let size = 0;
  let partial = false;
  let existing = 0;
  for (const p of paths) {
    const key = keyOf(p);
    const c = suggestionSizeCache.get(key);
    if (c && Date.now() - c.at < 60000) {
      size += c.size;
      partial = partial || c.partial;
      existing++;
      continue;
    }
    try {
      await fsp.access(p);
    } catch (_) {
      suggestionSizeCache.set(key, { at: Date.now(), size: 0, partial: false });
      continue;
    }
    const m = await getPathSize(st, p);
    suggestionSizeCache.set(key, { at: Date.now(), size: m.size, partial: m.partial });
    size += m.size;
    partial = partial || m.partial;
    existing++;
  }
  return { size, partial, existing };
}

function joinPath(base, ...parts) {
  return path.win32.join(base, ...parts);
}

async function buildSuggestions(st) {
  const root = st.root;
  const raw = [];
  const add = (def) => raw.push(def);

  if (st.letter === SYSTEM_DRIVE) {
    add({
      id: 'user-temp',
      label: '用户临时文件',
      group: 'safe',
      risk: 'safe',
      paths: [joinPath(LOCAL, 'Temp')],
      note: '各类程序产生的临时文件。正在使用的文件可能跳过，建议关闭浏览器和大型软件后清理。',
    });
    add({
      id: 'win-temp',
      label: 'Windows 临时文件',
      group: 'safe',
      risk: 'safe',
      paths: [joinPath(root, 'Windows', 'Temp')],
      note: '系统临时文件，可安全删除；被占用的文件会自动跳过。',
    });
    add({
      id: 'crash-dumps',
      label: '崩溃转储',
      group: 'safe',
      risk: 'safe',
      paths: [joinPath(LOCAL, 'CrashDumps'), joinPath(LOCAL, 'Microsoft', 'Windows', 'WER')],
      note: '程序崩溃时生成的转储文件，通常可以安全清理。',
    });
    add({
      id: 'chrome-cache',
      label: 'Chrome 浏览器缓存',
      group: 'safe',
      risk: 'safe',
      paths: [
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'),
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'GPUCache'),
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'ShaderCache'),
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'GrShaderCache'),
        joinPath(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Service Worker', 'CacheStorage'),
      ],
      note: '只清理网页缓存，不会删除书签、密码和登录状态。建议先关闭 Chrome。',
    });
    add({
      id: 'edge-cache',
      label: 'Edge 浏览器缓存',
      group: 'safe',
      risk: 'safe',
      paths: [
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'),
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'GPUCache'),
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'ShaderCache'),
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'GrShaderCache'),
        joinPath(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Service Worker', 'CacheStorage'),
      ],
      note: '只清理网页缓存，不影响收藏夹、密码和登录状态。建议先关闭 Edge。',
    });
    add({
      id: 'npm-cache',
      label: 'npm 缓存',
      group: 'safe',
      risk: 'safe',
      paths: [joinPath(LOCAL, 'npm-cache'), joinPath(ROAMING, 'npm-cache')],
      note: 'npm 包缓存，删除后首次安装依赖会重新下载。',
    });
    add({
      id: 'pip-cache',
      label: 'pip 缓存',
      group: 'safe',
      risk: 'safe',
      paths: [joinPath(LOCAL, 'pip', 'cache')],
      note: 'Python 包缓存，可安全删除；后续安装会重新下载。',
    });
    add({
      id: 'win-update',
      label: 'Windows 更新下载缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(root, 'Windows', 'SoftwareDistribution', 'Download')],
      note: '已下载的更新安装包。删除不会影响系统，但更新可能需要重新下载。建议优先使用系统“磁盘清理”。',
    });
    add({
      id: 'prefetch',
      label: 'Windows 预读取缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(root, 'Windows', 'Prefetch')],
      note: '删除后部分程序首次启动会略慢，系统会自动重建。通常体积不大。',
    });
    add({
      id: 'gradle',
      label: 'Gradle 缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(HOME, '.gradle', 'caches')],
      note: 'Android / Java 构建缓存。删除后下次构建会重新下载依赖，耗时较长。',
    });
    add({
      id: 'm2',
      label: 'Maven 本地仓库',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(HOME, '.m2', 'repository')],
      note: 'Java 依赖仓库。删除后项目构建需要重新下载，建议仅在空间紧张时清理。',
    });
    add({
      id: 'nuget',
      label: 'NuGet 包缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(HOME, '.nuget', 'packages')],
      note: '.NET 依赖缓存，删除后还原项目时会重新下载。',
    });
    add({
      id: 'pnpm',
      label: 'pnpm 全局缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(LOCAL, 'pnpm', 'store')],
      note: 'pnpm 内容寻址存储，删除后所有项目下次安装都会重新下载。',
    });
    add({
      id: 'yarn',
      label: 'Yarn 缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(LOCAL, 'Yarn', 'Cache'), joinPath(LOCAL, 'Yarn', 'Berry', 'cache')],
      note: 'Yarn 包缓存，删除后安装依赖会重新下载。',
    });
    add({
      id: 'dotcache',
      label: '.cache 缓存',
      group: 'caution',
      risk: 'caution',
      paths: [joinPath(HOME, '.cache')],
      note: '各类开发工具的通用缓存目录，通常可重建；删除前请确认其中没有你要保留的工具数据。',
    });
    add({
      id: 'old-windows',
      label: '旧版 Windows 安装 (Windows.old)',
      group: 'system',
      risk: 'caution',
      paths: [joinPath(root, 'Windows.old')],
      note: '升级前的旧系统文件。不要直接删除，建议用“磁盘清理 → 清理系统文件 → 以前的 Windows 安装”删除。',
      noDelete: true,
      action: 'openDiskCleanup',
    });

    const appDataBases = [LOCAL, ROAMING];
    const appCandidates = [];
    for (const base of appDataBases) {
      const rec = cachedRec(st, base);
      if (!rec || !rec.c) continue;
      for (const [name, size] of rec.c) {
        if (size < 800 * 1024 * 1024) continue;
        const full = path.win32.join(base, name);
        if (checkDeletable(full)) continue;
        if (/temp|cache|crash|wer|packages|microsoft|google|programs|pip|npm|yarn|pnpm|m2|gradle|nuget/i.test(name)) continue;
        appCandidates.push({
          id: 'app-' + full.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          label: name + '（应用数据）',
          group: 'apps',
          risk: 'caution',
          paths: [full],
          note: '应用自身的数据目录，可能包含登录状态、配置或本地项目。删除前请确认应用已关闭，并了解可能丢失数据。',
        });
      }
    }
    appCandidates.sort((a, b) => {
      const sa = (cachedRec(st, a.paths[0]) || {}).s || 0;
      const sb = (cachedRec(st, b.paths[0]) || {}).s || 0;
      return sb - sa;
    });
    raw.push(...appCandidates.slice(0, 5));
  }

  const items = [];
  for (const def of raw) {
    const { size, partial, existing } = await sizeForSuggestion(st, def.paths);
    if (!existing) continue;
    if (size < 1 * 1024 * 1024 && def.group !== 'system') continue;
    items.push({
      id: def.id,
      label: def.label,
      group: def.group,
      risk: def.risk,
      note: def.note,
      paths: def.paths.filter((p) => fs.existsSync(p)),
      size,
      partial,
      noDelete: !!def.noDelete,
      action: def.action || null,
    });
  }
  items.sort((a, b) => b.size - a.size);

  const bigDirs = [];
  const bases =
    st.letter === SYSTEM_DRIVE
      ? [LOCAL, ROAMING, joinPath(root, 'Users', path.win32.basename(HOME))]
      : [root];
  for (const base of bases) {
    const rec = cachedRec(st, base);
    if (!rec || !rec.c) continue;
    for (const [name, size] of rec.c.slice(0, 12)) {
      if (size < 500 * 1024 * 1024) continue;
      const full = path.win32.join(base, name);
      bigDirs.push({ name, path: full, size, protected: !!checkDeletable(full) });
    }
  }
  bigDirs.sort((a, b) => b.size - a.size);

  const sys = [];
  if (st.letter === SYSTEM_DRIVE) {
    const hiber = joinPath(root, 'hiberfil.sys');
    const pagefile = joinPath(root, 'pagefile.sys');
    const locked = await getRootLockedFiles(st);
    const lockedMap = new Map(locked.map((f) => [f.name.toLowerCase(), Number(f.size)]));
    const winSxS = joinPath(root, 'Windows', 'WinSxS');
    for (const [id, name, p, size, note] of [
      [
        'hiber',
        '休眠文件 hiberfil.sys',
        hiber,
        lockedMap.get('hiberfil.sys') || 0,
        '如不使用休眠，可在管理员终端执行 powercfg /h off 关闭并释放空间。',
      ],
      [
        'pagefile',
        '虚拟内存 pagefile.sys / swapfile.sys',
        pagefile,
        (lockedMap.get('pagefile.sys') || 0) + (lockedMap.get('swapfile.sys') || 0),
        '系统托管的分页文件，不建议直接删除；可在系统属性中调整大小。',
      ],
      [
        'winsxs',
        'WinSxS 组件存储',
        winSxS,
        (cachedRec(st, winSxS) || {}).s || 0,
        '不要直接删除。可在管理员终端执行 DISM /Online /Cleanup-Image /StartComponentCleanup 清理旧组件。',
      ],
    ]) {
      if (size > 0) sys.push({ id, label: name, path: p, size, note });
    }
  }

  return { items, bigDirs: bigDirs.slice(0, 12), system: sys, drive: st.letter };
}

// ---------- HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function checkCsrf(req) {
  const token = req.headers['x-cleaner-token'];
  if (token !== TOKEN) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function startScan(letter = SYSTEM_DRIVE) {
  const st = stateFor(letter);
  const prog = readProgress(st);
  if (st.process && !st.process.killed) return { started: false, reason: '正在扫描', drive: st.letter };
  if (prog && prog.phase === 'scanning' && prog.ageMs < 8000) return { started: false, reason: '正在扫描', drive: st.letter };
  st.live = null;
  st.liveMap = new Map();
  st.liveMtime = 0;
  st.progressCache = { at: 0, value: null };
  st.driveCache = { at: 0, value: null };
  try {
    fs.rmSync(st.files.live, { force: true });
    fs.rmSync(st.files.liveTmp, { force: true });
  } catch (_) {}
  st.process = spawn(process.execPath, [path.join(APP_DIR, 'scan.js')], {
    cwd: APP_DIR,
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, CDRIVE_ROOT: st.root },
  });
  st.process.on('exit', () => {
    st.process = null;
  });
  return { started: true, drive: st.letter };
}

function driveFromParam(value, fallback = SYSTEM_DRIVE) {
  const letter = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : fallback;
}

async function handleApi(req, res, urlObj) {
  const route = urlObj.pathname;

  if (route === '/api/drives') {
    const drives = await listDrives(true);
    const current = driveFromParam(urlObj.searchParams.get('drive'));
    json(res, 200, {
      drives,
      count: drives.length,
      systemDrive: SYSTEM_DRIVE,
      current: drives.some((d) => d.letter === current) ? current : drives[0].letter,
      detectedAt: new Date().toISOString(),
    });
    return;
  }

  if (route === '/api/overview') {
    const st = stateFor(driveFromParam(urlObj.searchParams.get('drive')));
    if (st.scan && fs.existsSync(st.files.scan)) {
      try {
        const fileStat = fs.statSync(st.files.scan);
        if (fileStat.mtimeMs !== st.scanMtime) loadScan(st, true);
      } catch (_) {}
    } else {
      loadScan(st, true);
    }
    const drive = await getDriveInfo(st);
    const progress = readProgress(st);
    const scanning = isScanning(st, progress);
    if (scanning) loadLive(st);
    let root = null;
    const rootRec = cachedRec(st, st.root);
    if (rootRec) {
      root = {
        path: rootRec.p,
        size: rootRec.s,
        directFilesSize: rootRec.d,
        dirs: (rootRec.c || []).map(([name, size]) => {
          const childPath = path.win32.join(rootRec.p, name);
          return {
            name,
            path: childPath,
            size,
            cached: !!cachedRec(st, childPath),
          };
        }),
        otherSize: rootRec.o || 0,
      };
    }
    const liveStats =
      scanning && st.live
        ? {
            dirs: (st.live.stats && st.live.stats.dirs) || 0,
            files: (st.live.stats && st.live.stats.files) || 0,
            bytes: (rootRec && rootRec.s) || (st.live.stats && st.live.stats.bytes) || 0,
          }
        : null;
    json(res, 200, {
      drive,
      driveLetter: st.letter,
      scan:
        st.scan || liveStats
          ? {
              scannedAt: (st.live && scanning ? st.live.generatedAt : st.scan && st.scan.scannedAt) || null,
              elapsedMs: (st.live && scanning ? st.live.elapsedMs : st.scan && st.scan.elapsedMs) || null,
              stats: liveStats || (st.scan && st.scan.stats),
              modifiedAt: st.scan ? st.scan.modifiedAt || null : null,
              live: !!liveStats,
            }
          : null,
      root,
      progress,
      app: { port: PORT, node: process.version },
    });
    return;
  }

  if (route === '/api/status') {
    const st = stateFor(driveFromParam(urlObj.searchParams.get('drive')));
    const progress = readProgress(st);
    const scanning = isScanning(st, progress);
    if (scanning) loadLive(st);
    json(res, 200, {
      drive: st.letter,
      progress,
      scanMtime: st.scanMtime,
      liveMtime: scanning ? st.liveMtime : 0,
      liveBytes: scanning && st.live ? Number((st.live.stats && st.live.stats.bytes) || 0) : 0,
    });
    return;
  }

  if (route === '/api/list') {
    const requestedDrive = driveFromParam(urlObj.searchParams.get('drive'));
    const p = normPath(urlObj.searchParams.get('path') || driveRoot(requestedDrive));
    if (!p) {
      json(res, 400, { error: '无效路径' });
      return;
    }
    const st = stateFor(driveOf(p));
    try {
      const progress = readProgress(st);
      const scanning = isScanning(st, progress);
      if (scanning) loadLive(st);
      const liveMode = urlObj.searchParams.get('live') === '1' && scanning;
      const data = await listDirectory(st, p, { live: liveMode });
      if (keyOf(p) === st.root.toLowerCase()) {
        const [drive, locked] = await Promise.all([getDriveInfo(st), getRootLockedFiles(st)]);
        if (drive && drive.used > data.size) {
          const lockedTotal = locked.reduce((s, f) => s + Number(f.size || 0), 0);
          const lockedItems = locked.map((f) => ({
            name: f.name,
            path: path.win32.join(st.root, f.name),
            size: Number(f.size),
            protected: true,
            kind: 'system',
            note:
              f.name === 'hiberfil.sys'
                ? '休眠文件。若不使用休眠，可在管理员终端执行 powercfg /h off 释放空间。'
                : '系统关键文件，不能直接删除，可在系统属性中调整。',
          }));
          const remainder = Math.max(0, drive.used - data.size - lockedTotal);
          data.systemItems = lockedItems;
          if (remainder > 0) {
            data.systemItems.push({
              name: st.letter === SYSTEM_DRIVE ? '系统还原 / 回收站 / 受保护区域' : '回收站 / 系统保留区域',
              path: null,
              size: remainder,
              protected: true,
              kind: 'system',
              note:
                st.letter === SYSTEM_DRIVE
                  ? '这部分空间来自系统还原点、回收站、System Volume Information、无法访问的受保护目录等。可在“磁盘清理”中清理系统文件，或以管理员身份管理还原点。'
                  : '这部分空间来自回收站、卷影副本、系统保留目录或无权限访问的内容。可清空该盘回收站，或在资源管理器中检查权限。',
            });
          }
          data.size = drive.used;
          data.driveUsed = drive.used;
          data.driveFree = drive.free;
        }
      }
      data.canDelete = !checkDeletable(p);
      data.blockReason = checkDeletable(p);
      json(res, 200, data);
    } catch (e) {
      json(res, e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (route === '/api/search') {
    const st = stateFor(driveFromParam(urlObj.searchParams.get('drive')));
    const q = String(urlObj.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) {
      json(res, 200, { results: [] });
      return;
    }
    const progress = readProgress(st);
    const scanning = isScanning(st, progress);
    if (scanning) loadLive(st);
    if (!scanning && !st.scan) loadScan(st, true);
    const source = scanning && st.liveMap.size ? Array.from(st.liveMap.values()) : st.scan ? Array.from(st.dirsMap.values()) : [];
    const results = [];
    for (const rec of source) {
      if (!rec || !rec.p) continue;
      if (rec.p.toLowerCase().includes(q)) {
        results.push({ name: rec.p.split('\\').filter(Boolean).pop() || rec.p, path: rec.p, size: rec.s });
      }
    }
    results.sort((a, b) => b.size - a.size);
    json(res, 200, { results: results.slice(0, 60), live: scanning, drive: st.letter });
    return;
  }

  if (route === '/api/suggestions') {
    const st = stateFor(driveFromParam(urlObj.searchParams.get('drive')));
    if (!st.scan) loadScan(st, true);
    try {
      const data = await buildSuggestions(st);
      json(res, 200, data);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (route === '/api/open') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!checkCsrf(req)) return json(res, 403, { error: '校验失败，请刷新页面' });
    const body = await readBody(req);
    if (body.special === 'recycle') {
      spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    const p = normPath(body.path);
    if (!p) return json(res, 400, { error: '无效路径' });
    const select = !!body.select;
    try {
      const st = await fsp.lstat(p);
      const arg = st.isDirectory() ? p : `/select,${p}`;
      spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      json(res, 200, { ok: true });
    } catch (_) {
      json(res, 404, { error: '路径不存在' });
    }
    return;
  }

  if (route === '/api/scan') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!checkCsrf(req)) return json(res, 403, { error: '校验失败，请刷新页面' });
    const body = await readBody(req);
    const letter = driveFromParam(body.drive);
    const drives = await listDrives();
    if (!drives.some((d) => d.letter === letter)) {
      return json(res, 400, { error: '找不到该磁盘分区' });
    }
    json(res, 200, startScan(letter));
    return;
  }

  if (route === '/api/recycle' || route === '/api/delete') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!checkCsrf(req)) return json(res, 403, { error: '校验失败，请刷新页面' });
    if (!IS_WIN) return json(res, 400, { error: '仅支持 Windows' });
    const body = await readBody(req);
    if (!Array.isArray(body.paths) || !body.paths.length) {
      return json(res, 400, { error: '未选择任何项目' });
    }
    const first = normPath(body.paths[0]);
    const st = stateFor(driveOf(first || SYSTEM_DRIVE));
    if (isScanning(st)) {
      return json(res, 409, { error: '扫描进行中，请等待扫描完成后再删除', scanning: true });
    }
    if (body.paths.length > 200) return json(res, 400, { error: '一次最多处理 200 项' });
    const { paths, errors: preErrors } = dedupePaths(body.paths);
    const checks = await validateDeletable(paths);
    const valid = [];
    const results = [...preErrors];
    for (const c of checks) {
      if (!c.ok) results.push(c);
      else valid.push(c);
    }
    if (!valid.length) return json(res, 400, { results, error: '没有可删除的项目' });

    if (route === '/api/delete') {
      if (body.confirm !== 'DELETE') return json(res, 400, { error: '缺少永久删除确认' });
    }

    const before = [];
    for (const item of valid) {
      before.push({
        path: item.path,
        isDir: !!item.isDir,
        size: await getRemovalSize(st, item.path),
        existedAtScan: wasCachedAtScan(st, item.path, !!item.isDir),
      });
    }

    let outcomes = [];
    if (route === '/api/recycle') {
      outcomes = await runRecycle(valid.map((x) => x.path));
    } else {
      for (const item of valid) {
        outcomes.push(await permanentDelete(item.path, !!item.isDir));
      }
    }
    for (const r of outcomes) {
      if (!r.ok) continue;
      const b = before.find((x) => keyOf(x.path) === keyOf(r.path));
      if (b) applyRemoval(st, b.path, b.size, b.isDir, b.existedAtScan);
      try {
        const stat = fs.existsSync(b.path) ? fs.statSync(b.path) : null;
        if (stat && stat.isDirectory()) {
          for (const k of Array.from(liveSizeCache.keys())) {
            if (k === keyOf(b.path) || k.startsWith(keyOf(b.path) + '\\')) liveSizeCache.delete(k);
          }
        }
        liveSizeCache.delete(keyOf(b.path));
      } catch (_) {}
    }
    // 让容量统计尽快刷新
    st.driveCache = { at: 0, value: null };
    driveListCache = { at: 0, value: null };
    const okCount = outcomes.filter((r) => r.ok).length;
    const failCount = outcomes.filter((r) => !r.ok).length + results.length;
    json(res, 200, {
      results: [...results, ...outcomes],
      okCount,
      failCount,
      drive: st.letter,
      recycledBytes: route === '/api/recycle' ? before.filter((b) => outcomes.some((o) => o.ok && keyOf(o.path) === keyOf(b.path))).reduce((s, b) => s + b.size, 0) : 0,
      freedBytes: route === '/api/delete' ? before.filter((b) => outcomes.some((o) => o.ok && keyOf(o.path) === keyOf(b.path))).reduce((s, b) => s + b.size, 0) : 0,
    });
    return;
  }

  if (route === '/api/recycle-info') {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "$s=New-Object -ComObject Shell.Application; $items=@($s.Namespace(10).Items()); $size=0; foreach($i in $items){$size+=[double]$i.Size}; [pscustomobject]@{count=$items.Count;size=$size}|ConvertTo-Json -Compress",
      ],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) return json(res, 200, { count: 0, size: 0, unavailable: true });
        try {
          const j = JSON.parse(String(stdout).trim());
          json(res, 200, { count: j.count || 0, size: j.size || 0 });
        } catch (_) {
          json(res, 200, { count: 0, size: 0, unavailable: true });
        }
      }
    );
    return;
  }

  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  let urlObj;
  try {
    urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: e.message || '服务器错误' });
    });
    return;
  }

  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    try {
      let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      html = html.replace(/__CLEANER_TOKEN_VALUE__/g, TOKEN);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('无法加载界面');
    }
    return;
  }

  const filePath = path.join(PUBLIC_DIR, path.win32.normalize(urlObj.pathname).replace(/^[\\/]+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

function openBrowser() {
  if (process.env.NO_OPEN) return;
  try {
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch (_) {}
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Drive cleaner running at http://127.0.0.1:${PORT}`);
  const systemState = stateFor(SYSTEM_DRIVE);
  loadScan(systemState, true);
  if (!fs.existsSync(systemState.files.scan)) {
    startScan(SYSTEM_DRIVE);
  }
  setTimeout(openBrowser, 400);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('检测到已有清理工具在运行，正在打开现有页面…');
    openBrowser();
    setTimeout(() => process.exit(0), 900);
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
