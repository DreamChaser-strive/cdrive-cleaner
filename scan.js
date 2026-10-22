#!/usr/bin/env node
/*
 * C 盘空间扫描器
 * 输出 data/scan.json + data/progress.json
 * 仅统计文件逻辑大小，跳过符号链接/junction，避免重复计算与死循环。
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = 'C:\\';
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'scan.json');
const PROGRESS_FILE = path.join(OUT_DIR, 'progress.json');
const TMP_FILE = path.join(OUT_DIR, 'scan.json.tmp');
const WORKERS = 32;
const FILE_CHUNK = 64;
const STORE_MIN_SIZE = 256 * 1024; // 仅缓存 >= 256KB 的目录
const MAX_CHILDREN = 300;
const SKIP_NAMES = new Set(['system volume information']);
const SKIP_ROOT_PATHS = new Set(['c:\\documents and settings']);

const startedAtMs = Date.now();
const state = {
  startedAt: new Date().toISOString(),
  phase: 'scanning',
  scannedDirs: 0,
  scannedFiles: 0,
  bytes: 0,
  errors: 0,
  queueLength: 0,
  currentPath: '',
  elapsedMs: 0,
  done: false,
};

fs.mkdirSync(OUT_DIR, { recursive: true });

const records = new Map();
const queue = [];
let queueIndex = 0;
let activeWorkers = 0;

function depthOf(p) {
  let d = 0;
  for (let i = 0; i < p.length; i++) if (p[i] === '\\') d++;
  return d;
}

function makeRecord(displayPath, parentKey) {
  const key = displayPath.toLowerCase();
  const rec = {
    key,
    path: displayPath,
    parent: parentKey || null,
    direct: 0,
    files: 0,
    dirs: 0,
    size: 0,
    depth: depthOf(displayPath),
    error: 0,
  };
  records.set(key, rec);
  return rec;
}

const rootRec = makeRecord(ROOT, null);
queue.push(ROOT);

function normalize(p) {
  return path.win32.normalize(p);
}

let progressWriting = false;
function writeProgress() {
  if (progressWriting) return;
  progressWriting = true;
  state.elapsedMs = Date.now() - startedAtMs;
  state.queueLength = Math.max(0, queue.length - queueIndex);
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state));
  } catch (_) {}
  progressWriting = false;
}
const progressTimer = setInterval(writeProgress, 400);
writeProgress();

async function statFiles(dirRec, fileEntries) {
  for (let i = 0; i < fileEntries.length; i += FILE_CHUNK) {
    const chunk = fileEntries.slice(i, i + FILE_CHUNK);
    await Promise.all(
      chunk.map(async (entry) => {
        try {
          const st = await fsp.stat(path.join(dirRec.path, entry.name));
          if (st.isFile()) {
            dirRec.direct += st.size;
            dirRec.files += 1;
            state.bytes += st.size;
            state.scannedFiles += 1;
          }
        } catch (_) {
          state.errors += 1;
        }
      })
    );
  }
}

function enqueueDir(displayPath, parentKey) {
  displayPath = normalize(displayPath);
  if (SKIP_ROOT_PATHS.has(displayPath.toLowerCase())) return;
  const key = displayPath.toLowerCase();
  let rec = records.get(key);
  if (!rec) rec = makeRecord(displayPath, parentKey);
  else if (!rec.parent && parentKey) rec.parent = parentKey;
  queue.push(displayPath);
}

async function scanOneDir(dirPath) {
  const dirRec = records.get(dirPath.toLowerCase());
  if (!dirRec) return;
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (_) {
    dirRec.error += 1;
    state.errors += 1;
    return;
  }

  const fileEntries = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // junction / symlink：跳过，防止重复与死循环
    if (entry.isDirectory()) {
      if (SKIP_NAMES.has(entry.name.toLowerCase())) continue;
      enqueueDir(path.join(dirPath, entry.name), dirRec.key);
      dirRec.dirs += 1;
    } else if (entry.isFile()) {
      fileEntries.push(entry);
    }
  }
  await statFiles(dirRec, fileEntries);
  state.scannedDirs += 1;
  state.currentPath = dirPath;
}

async function worker() {
  while (true) {
    if (queueIndex >= queue.length) {
      if (activeWorkers === 0) break;
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    const dirPath = queue[queueIndex++];
    activeWorkers++;
    try {
      await scanOneDir(dirPath);
    } catch (_) {
      state.errors += 1;
    } finally {
      activeWorkers--;
    }
  }
}

async function main() {
  console.log(`Scanning ${ROOT} ...`);
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  state.phase = 'aggregating';
  writeProgress();

  const all = Array.from(records.values());
  all.sort((a, b) => b.depth - a.depth);

  // 初始化并建立 parent -> children 索引（只遍历一次）
  const childrenByParent = new Map();
  for (const rec of all) {
    rec.size = rec.direct;
    if (rec.parent) {
      if (!childrenByParent.has(rec.parent)) childrenByParent.set(rec.parent, []);
      childrenByParent.get(rec.parent).push(rec);
    }
  }

  // 深度倒序累加，保证子目录先于父目录完成
  for (const rec of all) {
    if (rec.parent) {
      const parent = records.get(rec.parent);
      if (parent) parent.size += rec.size;
    }
  }

  // 仅保留有意义的大目录
  const kept = all.filter((r) => r.size >= STORE_MIN_SIZE || r.key === ROOT.toLowerCase());
  const outDirs = {};
  for (const rec of kept) {
    const children = (childrenByParent.get(rec.key) || []).map((child) => ({
      n: child.path.slice(rec.path.length).replace(/^\\/, ''),
      s: child.size,
    }));
    children.sort((a, b) => b.s - a.s);
    const keptChildren = children.slice(0, MAX_CHILDREN);
    let other = 0;
    for (let i = MAX_CHILDREN; i < children.length; i++) other += children[i].s;

    outDirs[rec.key] = {
      p: rec.path,
      s: rec.size,
      d: rec.direct,
      fc: rec.files,
      dc: rec.dirs,
      c: keptChildren.map((x) => [x.n, x.s]),
      o: other,
      e: rec.error || 0,
    };
  }

  const data = {
    version: 2,
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    root: ROOT,
    dirs: outDirs,
    stats: {
      dirs: records.size,
      files: state.scannedFiles,
      bytes: rootRec.size,
      errors: state.errors,
      keptDirs: kept.length,
    },
  };

  fs.writeFileSync(TMP_FILE, JSON.stringify(data));
  fs.renameSync(TMP_FILE, OUT_FILE);

  state.phase = 'done';
  state.done = true;
  state.finishedAt = new Date().toISOString();
  writeProgress();
  clearInterval(progressTimer);

  console.log(
    `Done. ${records.size} dirs, ${state.scannedFiles} files, ${(rootRec.size / 1024 / 1024 / 1024).toFixed(
      1
    )} GB, ${state.errors} errors, ${(data.elapsedMs / 1000).toFixed(1)}s`
  );
}

main().catch((e) => {
  state.phase = 'error';
  state.error = String((e && e.stack) || e);
  writeProgress();
  clearInterval(progressTimer);
  console.error(e);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  state.phase = 'cancelled';
  writeProgress();
  process.exit(130);
});
