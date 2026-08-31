// Minimal browser-native DICOM viewer. No build step, no backend.
// Parses pixel data with dicom-parser and renders directly to canvas.

const PRESETS = {
  soft: { center: 40, width: 400 },
  lung: { center: -600, width: 1500 },
  bone: { center: 400, width: 1800 },
  brain: { center: 40, width: 80 },
};

const state = {
  entries: [],       // [{ name, dataSet, image, wc, ww }]
  currentIndex: -1,
  scale: 1,
  panX: 0,
  panY: 0,
  invert: false,
  layout: 'stack',   // 'stack' | 'mpr'
  volume: null,      // built lazily when a consistent slice stack is loaded
  cursor: null,       // { x, y, z } in volume voxel coords, shared by all MPR panes
  mprTilt: { rx: 0, ry: 0, rz: 0 }, // tilt-correction angles (deg), Alt-drag to adjust
  mprWc: 0,
  mprWw: 1,
  panes: {},          // per-pane view state: { plane, scale, panX, panY }
  activePatientKey: null, // which stored patient is currently loaded in the viewer
};

const el = {
  fileInput: document.getElementById('fileInput'),
  dirInput: document.getElementById('dirInput'),
  wrap: document.getElementById('viewportWrap'),
  stackView: document.getElementById('stackView'),
  mprGrid: document.getElementById('mprGrid'),
  canvas: document.getElementById('viewport'),
  dropHint: document.getElementById('dropHint'),
  fileList: document.getElementById('fileList'),
  fileCount: document.getElementById('fileCount'),
  patientList: document.getElementById('patientList'),
  patientCount: document.getElementById('patientCount'),
  patientEmpty: document.getElementById('patientEmpty'),
  metaTable: document.getElementById('metaTable'),
  status: document.getElementById('status'),
  presetSelect: document.getElementById('presetSelect'),
  btnReset: document.getElementById('btnReset'),
  btnInvert: document.getElementById('btnInvert'),
  btnLayoutStack: document.getElementById('btnLayoutStack'),
  btnLayoutGrid: document.getElementById('btnLayoutGrid'),
  gridSizeSelect: document.getElementById('gridSizeSelect'),
  overlayTL: document.getElementById('overlayTL'),
  overlayTR: document.getElementById('overlayTR'),
  overlayBL: document.getElementById('overlayBL'),
  overlayBR: document.getElementById('overlayBR'),
  stackHu: document.getElementById('stackHu'),
  scrubber: document.getElementById('scrubber'),
  scrubSlider: document.getElementById('scrubSlider'),
  scrubPrev: document.getElementById('scrubPrev'),
  scrubNext: document.getElementById('scrubNext'),
  scrubLabel: document.getElementById('scrubLabel'),
  cinePlay: document.getElementById('cinePlay'),
  cineSpeed: document.getElementById('cineSpeed'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingLabel: document.getElementById('loadingLabel'),
  loadingBarFill: document.getElementById('loadingBarFill'),
  loadingPct: document.getElementById('loadingPct'),
  loadingWhy: document.getElementById('loadingWhy'),
  panes: {},
};

const ctx = el.canvas.getContext('2d');

function setStatus(msg, type) {
  el.status.textContent = msg;
  el.status.classList.remove('status-ok', 'status-warn', 'status-err');
  if (type) el.status.classList.add(`status-${type}`);
}

// Long synchronous loops (parsing/decoding hundreds of instances) block the tab
// with no visible feedback otherwise. Call periodically, not every iteration —
// a real paint costs ~16ms, too much to pay on every single image.
function yieldToUI() { return new Promise(requestAnimationFrame); }

// A single visible progress bar for every phase of opening a study — download,
// parse, decode — instead of text tucked in a modal or the footer that's easy
// to miss entirely. Pass total=0 for an indeterminate (unknown-length) phase.
// `why`, when given, is a plain-language reason this particular phase takes a
// moment — only worth showing for the genuinely slow phases (a fresh archive
// pull), not for the instant ones, so it's optional and sticky (a blank why
// leaves the last one showing rather than flashing empty between updates).
function showLoadingProgress(label, current, total, why) {
  el.loadingOverlay.classList.remove('hidden');
  el.loadingLabel.textContent = label;
  if (why !== undefined) el.loadingWhy.textContent = why;
  if (total > 0) {
    const pct = Math.min(100, Math.round((current / total) * 100));
    el.loadingBarFill.classList.remove('indeterminate');
    el.loadingBarFill.style.width = `${pct}%`;
    el.loadingPct.textContent = `${pct}%`;
  } else {
    el.loadingBarFill.classList.add('indeterminate');
    el.loadingPct.textContent = '';
  }
}
function hideLoadingProgress() {
  el.loadingOverlay.classList.add('hidden');
  el.loadingBarFill.classList.remove('indeterminate');
  el.loadingBarFill.style.width = '0%';
  el.loadingWhy.textContent = '';
}

// Some libraries (dicom-parser's validation checks in particular) throw bare
// strings instead of Error objects — e.message on a string is undefined, which is
// how error text goes missing. Always route thrown values through this first.
function errMsg(e) {
  if (e && typeof e === 'object' && e.message) return e.message;
  return String(e);
}

// Patient names / IDs come from the scanner, not the app — escape before putting
// them into innerHTML.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fitCanvas() {
  el.canvas.width = el.wrap.clientWidth;
  el.canvas.height = el.wrap.clientHeight;
}

function fitPaneCanvases() {
  Object.keys(el.panes).forEach(k => {
    const { wrap, canvas } = el.panes[k];
    // Panes hidden behind a maximized pane report zero size — leave their canvas
    // alone rather than collapsing it to 0x0.
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  });
}

window.addEventListener('resize', () => {
  if (state.layout === 'stack') {
    fitCanvas();
    render();
  } else {
    fitPaneCanvases();
    Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
    renderAllPanes();
  }
});

// ---------- Patient library (IndexedDB persistence) ----------
// Every loaded DICOM file is stored per-patient in IndexedDB so scans survive a
// refresh and accumulate across sessions. The `files` store holds raw bytes keyed
// by `<patientKey>::<sopUID-or-filename>` (so re-loading the same instance overwrites
// rather than duplicates); the `patients` store holds a lightweight summary per
// patient (name, id, series/modality sets) so the sidebar list renders without
// reading any pixel bytes.

const DB_NAME = 'dicomViewerLibrary';
// v2 added a per-patient 'videos' store; v3 turned it into a shared, procedure-tagged
// library (surgery template videos are patient-education material, not tied to a
// specific patient's own scan); v4 renamed the tag to 'folder' (proper folder
// browsing instead of a flat list) and added a stored 'thumbnail' data URL.
const DB_VERSION = 4;
let _dbPromise = null;

function openLibraryDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) {
        const fs = db.createObjectStore('files', { keyPath: 'id' });
        fs.createIndex('patientKey', 'patientKey', { unique: false });
      }
      if (!db.objectStoreNames.contains('patients')) {
        db.createObjectStore('patients', { keyPath: 'key' });
      }
      if (db.objectStoreNames.contains('videos')) db.deleteObjectStore('videos');
      const vs = db.createObjectStore('videos', { keyPath: 'id' });
      vs.createIndex('folder', 'folder', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function dsStr(ds, tag) { return (ds.string(tag) || '').trim(); }

function patientKeyFromDataSet(ds) {
  const id = dsStr(ds, 'x00100020');
  const name = dsStr(ds, 'x00100010');
  if (id) return 'id:' + id;
  if (name) return 'nm:' + name;
  return 'unknown';
}

function patientMetaFromDataSet(ds) {
  return {
    key: patientKeyFromDataSet(ds),
    name: dsStr(ds, 'x00100010').replace(/\^/g, ' ').trim() || 'Unknown',
    id: dsStr(ds, 'x00100020'),
    studyDate: dsStr(ds, 'x00080020'),
    seriesUid: dsStr(ds, 'x0020000e'),
    modality: dsStr(ds, 'x00080060'),
    sopUid: dsStr(ds, 'x00080018'),
  };
}

async function persistParsedFiles(parsed) {
  const db = await openLibraryDB();

  // 1) Store the raw file bytes.
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    for (const p of parsed) {
      const meta = patientMetaFromDataSet(p.dataSet);
      store.put({
        id: `${meta.key}::${meta.sopUid || p.filename}`,
        patientKey: meta.key,
        seriesUid: meta.seriesUid,
        filename: p.filename,
        bytes: p.bytes,
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted (quota?)'));
  });

  // 2) Merge per-patient summaries (get-then-put, chained via callbacks so the
  //    transaction stays alive without relying on await-in-transaction behavior).
  const summaries = new Map();
  for (const p of parsed) {
    const meta = patientMetaFromDataSet(p.dataSet);
    let s = summaries.get(meta.key);
    if (!s) { s = { meta, series: new Set(), mods: new Set() }; summaries.set(meta.key, s); }
    if (meta.seriesUid) s.series.add(meta.seriesUid);
    if (meta.modality) s.mods.add(meta.modality);
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction('patients', 'readwrite');
    const store = tx.objectStore('patients');
    for (const [key, s] of summaries) {
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const prev = getReq.result;
        const series = new Set([...(prev?.seriesUids || []), ...s.series]);
        const mods = new Set([...(prev?.modalities || []), ...s.mods]);
        store.put({
          key,
          name: s.meta.name || prev?.name || 'Unknown',
          id: s.meta.id || prev?.id || '',
          studyDate: s.meta.studyDate || prev?.studyDate || '',
          seriesUids: [...series],
          modalities: [...mods],
          addedAt: prev?.addedAt || Date.now(),
          updatedAt: Date.now(),
        });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted (quota?)'));
  });
}

async function listPatients() {
  const db = await openLibraryDB();
  const patients = await new Promise((res, rej) => {
    const tx = db.transaction('patients', 'readonly');
    const r = tx.objectStore('patients').getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (!patients.length) return [];
  // File counts via the index count() — never reads pixel bytes.
  const counts = await new Promise((res, rej) => {
    const tx = db.transaction('files', 'readonly');
    const idx = tx.objectStore('files').index('patientKey');
    const out = {};
    let pending = patients.length, failed = false;
    patients.forEach(p => {
      const cr = idx.count(p.key);
      cr.onsuccess = () => { out[p.key] = cr.result; if (--pending === 0 && !failed) res(out); };
      cr.onerror = () => { if (!failed) { failed = true; rej(cr.error); } };
    });
  });
  return patients
    .map(p => ({ ...p, fileCount: counts[p.key] || 0 }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function loadPatientRecords(key) {
  const db = await openLibraryDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction('files', 'readonly');
    const r = tx.objectStore('files').index('patientKey').getAll(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function deletePatientFromLibrary(key) {
  const db = await openLibraryDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(['files', 'patients'], 'readwrite');
    tx.objectStore('patients').delete(key);
    const cur = tx.objectStore('files').index('patientKey').openKeyCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { tx.objectStore('files').delete(c.primaryKey); c.continue(); }
    };
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

// ---------- Surgery video library (shared, procedure-tagged, IndexedDB Blob storage) ----------
// A patient-education library of procedure template videos the doctor shows patients
// before a surgery — not footage of any specific patient, so it is not keyed to a
// patient at all. Videos are stored as native Blobs (not base64) so large files stay
// off the JS heap — the browser streams them to/from disk-backed storage.

async function saveVideo(file, folder, thumbnail) {
  const db = await openLibraryDB();
  const id = `${Date.now()}::${file.name}`;
  await new Promise((res, rej) => {
    const tx = db.transaction('videos', 'readwrite');
    tx.objectStore('videos').put({
      id,
      folder,
      thumbnail: thumbnail || null,
      filename: file.name,
      size: file.size,
      type: file.type || 'video/mp4',
      blob: file,
      addedAt: Date.now(),
    });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('storage transaction aborted (quota?)'));
  });
  return id;
}

// Draws a frame ~10% into the clip to a small JPEG data URL for the library thumbnail.
// Best-effort: codecs/browsers that can't seek quietly resolve to null (icon fallback).
function generateVideoThumbnail(file) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
    const videoEl = document.createElement('video');
    videoEl.preload = 'metadata';
    videoEl.muted = true;
    videoEl.playsInline = true;
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    function cleanup() { URL.revokeObjectURL(url); }
    videoEl.addEventListener('loadedmetadata', () => {
      videoEl.currentTime = Math.min(1, (videoEl.duration || 1) * 0.1);
    });
    videoEl.addEventListener('seeked', () => {
      try {
        const w = 320;
        const h = Math.round(w * ((videoEl.videoHeight / videoEl.videoWidth) || 9 / 16));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch (e) { finish(null); }
    });
    videoEl.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 4000);
  });
}

async function listVideos() {
  const db = await openLibraryDB();
  const records = await new Promise((res, rej) => {
    const tx = db.transaction('videos', 'readonly');
    const r = tx.objectStore('videos').getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return records.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

async function deleteVideoById(id) {
  const db = await openLibraryDB();
  await new Promise((res, rej) => {
    const tx = db.transaction('videos', 'readwrite');
    tx.objectStore('videos').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- Patient list UI ----------

const PERSON_ICON = '<svg class="patientRowIcon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="6.5" r="3"/><path d="M4 17a6 6 0 0 1 12 0"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';

async function renderPatientList() {
  let patients;
  try { patients = await listPatients(); }
  catch (e) { console.warn('listPatients failed:', e); patients = []; }
  state.patientListCache = patients;

  el.patientCount.textContent = patients.length;
  el.patientEmpty.style.display = patients.length ? 'none' : 'block';
  el.patientList.innerHTML = '';

  patients.forEach(p => {
    const li = document.createElement('li');
    li.className = 'patientRow';
    li.dataset.key = p.key;
    if (p.key === state.activePatientKey) li.classList.add('active');
    li.title = p.name + (p.id ? ` (ID: ${p.id})` : '');
    const seriesN = (p.seriesUids || []).length;
    const mods = (p.modalities || []).join(' ');
    li.innerHTML = `
      ${PERSON_ICON}
      <div class="patientRowBody">
        <div class="patientRowTitle">${escapeHtml(p.name)}</div>
        <div class="patientRowMeta">
          ${mods ? `<span class="modBadge">${escapeHtml(mods)}</span>` : ''}
          <span>${seriesN} series</span>
          <span>${p.fileCount} img</span>
        </div>
      </div>
      <button class="patientDelete" title="Remove from library">${TRASH_ICON}</button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.patientDelete')) return;
      activatePatientByKey(p.key);
    });
    li.querySelector('.patientDelete').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeletePatient(p);
    });
    el.patientList.appendChild(li);
  });
}

function updatePatientHighlight() {
  [...el.patientList.children].forEach(li => {
    li.classList.toggle('active', li.dataset.key === state.activePatientKey);
  });
}

async function confirmDeletePatient(p) {
  const ok = window.confirm(
    `Remove "${p.name}" and all ${p.fileCount} stored image(s) from this computer's library?\n\nThis permanently deletes them from browser storage and cannot be undone.`
  );
  if (!ok) return;
  try { await deletePatientFromLibrary(p.key); }
  catch (e) { setStatus(`Delete failed: ${errMsg(e)}`, 'err'); return; }
  if (state.activePatientKey === p.key) clearActivePatient();
  await renderPatientList();
  setStatus(`Removed ${p.name} from library.`, 'ok');
}

function clearActivePatient() {
  state.activePatientKey = null;
  state.entries = [];
  state.currentIndex = -1;
  state.volume = null;
  state.volumeSeriesUid = null;
  state.lastSeriesGroups = [];
  el.fileList.innerHTML = '';
  el.fileCount.textContent = '0';
  el.metaTable.innerHTML = '';
  el.btnLayoutGrid.disabled = true;
  el.gridSizeSelect.disabled = true;
  if (state.layout === 'mpr') setLayout('stack');
  el.dropHint.classList.remove('hidden');
  updateScrubber();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
  el.overlayTL.textContent = el.overlayTR.textContent =
    el.overlayBL.textContent = el.overlayBR.textContent = '';
  resetAiAnalysisState();
}

// ---------- File loading ----------

// Build expanded viewer entries (one per frame for multi-frame files) from a set of
// already-parsed {filename, dataSet} items.
function entriesFromParsed(items) {
  const out = [];
  for (const it of items) pushEntriesForDataSet(out, it.filename, it.dataSet);
  return out;
}

async function activateWithEntries(key, entries, label) {
  if (key !== state.activePatientKey) resetAiAnalysisState();
  state.activePatientKey = key;
  updatePatientHighlight();
  await finishLoadingEntries(entries, label);
}

// Load a stored patient's files back out of IndexedDB and display them.
async function activatePatientByKey(key) {
  if (key === state.activePatientKey && state.entries.length) return; // already showing
  setStatus('Loading patient from library...');
  let records;
  try { records = await loadPatientRecords(key); }
  catch (e) { setStatus(`Could not load patient: ${errMsg(e)}`, 'err'); return; }
  if (!records.length) { setStatus('No files stored for this patient.', 'warn'); return; }

  const items = [];
  for (const rec of records) {
    try {
      const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
      const dataSet = dicomParser.parseDicom(bytes);
      items.push({ filename: rec.filename, dataSet });
    } catch (e) {
      console.warn('Skipping unreadable stored file:', rec.filename, e);
    }
  }
  if (!items.length) { setStatus('Stored files for this patient could not be read.', 'err'); return; }

  const cached = (state.patientListCache || []).find(p => p.key === key);
  const label = cached ? cached.name : 'patient';
  await activateWithEntries(key, entriesFromParsed(items), label);
}

// Persist a freshly-loaded batch, refresh the patient list, and show the patient
// that got the most files in this batch.
async function ingestParsed(parsed) {
  let persistError = null;
  try { await persistParsedFiles(parsed); }
  catch (e) { persistError = e; console.warn('Persist to library failed:', e); }

  await renderPatientList();

  const byKey = new Map();
  for (const p of parsed) {
    const key = patientKeyFromDataSet(p.dataSet);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  let bestKey = null, bestItems = null;
  for (const [key, items] of byKey) {
    if (!bestItems || items.length > bestItems.length) { bestKey = key; bestItems = items; }
  }

  const name = patientMetaFromDataSet(bestItems[0].dataSet).name;
  const extra = byKey.size > 1 ? ` (+${byKey.size - 1} more patient${byKey.size - 1 === 1 ? '' : 's'} added)` : '';
  await activateWithEntries(bestKey, entriesFromParsed(bestItems), `${name}${extra}`);

  if (persistError) {
    setStatus(`Loaded, but could not save to the library (${errMsg(persistError)}). Showing this session only.`, 'warn');
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => !f.name.startsWith('.'));
  if (!files.length) return;
  setStatus(`Loading ${files.length} file(s)...`);

  const parsed = [];
  const skipped = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const buf = await file.arrayBuffer();
      const byteArray = new Uint8Array(buf);
      const dataSet = dicomParser.parseDicom(byteArray);
      parsed.push({ filename: file.name, dataSet, bytes: byteArray });
    } catch (e) {
      skipped.push(`${file.name}: ${errMsg(e)}`);
      console.warn('Skipping non-DICOM or unparsable file:', file.name, e);
    }
    if (files.length > 20 && (i % 25 === 0 || i === files.length - 1)) {
      setStatus(`Loading ${i + 1} / ${files.length} file(s)...`);
      await yieldToUI();
    }
  }

  if (!parsed.length) {
    setStatus(
      skipped.length
        ? `No loadable DICOM data. First failure — ${skipped[0]}`
        : 'No valid DICOM data found.',
      'err'
    );
    return;
  }

  await ingestParsed(parsed);
  if (skipped.length) console.warn(`${skipped.length} file(s) skipped while loading.`);
}

// Multi-frame files (enhanced CT/MR, "3D" DICOMs — NumberOfFrames > 1) are expanded
// into one viewer entry per frame so a single file behaves like a full slice stack.
function pushEntriesForDataSet(out, name, dataSet) {
  const frames = parseInt(dataSet.string('x00280008'), 10) || 1;
  if (frames > 1) {
    for (let f = 0; f < frames; f++) out.push({ name: `${name} [${f + 1}]`, dataSet, frame: f });
  } else {
    out.push({ name, dataSet });
  }
}

async function finishLoadingEntries(newEntries, sourceLabel) {
  if (!newEntries.length) {
    setStatus('No valid DICOM data found.', 'err');
    return;
  }

  // Sort by series first (so multiple loaded series stay contiguous rather than
  // interleaving by instance number), then by Instance Number within each series.
  newEntries.sort((a, b) => {
    const suidA = a.dataSet.string('x0020000e') || '';
    const suidB = b.dataSet.string('x0020000e') || '';
    if (suidA !== suidB) return suidA.localeCompare(suidB);
    const ai = parseInt(a.dataSet.string('x00200013'), 10);
    const bi = parseInt(b.dataSet.string('x00200013'), 10);
    if (!isNaN(ai) && !isNaN(bi) && ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  state.entries = newEntries;
  state.currentIndex = 0;
  el.dropHint.classList.add('hidden');
  showView('viewer'); // leave the worklist and reveal the viewer for the opened study

  buildFileList();

  // Start on the largest series (the primary stack) rather than whatever file sorts
  // first — in real studies that's often a single-slice scout, which can't build a
  // volume and would leave the Grid/MPR view disabled until the user notices.
  const largest = state.lastSeriesGroups.reduce(
    (best, g) => (g.indices.length > best.indices.length ? g : best),
    state.lastSeriesGroups[0]
  );
  state.currentIndex = largest.indices[0];
  // Force a volume rebuild for the newly loaded data — loadCurrent's series check
  // would otherwise skip it if the new data reuses the previous series UID slot.
  state.volume = null;
  state.volumeSeriesUid = null;
  await loadCurrent(true); // may itself report a decode failure via setStatus(..., 'err')

  // Don't clobber a decode-failure status loadCurrent just set — only report success
  // if the selected entry actually decoded.
  const current = state.entries[state.currentIndex];
  if (current && current.image) {
    setStatus(
      state.volume ? `Loaded ${sourceLabel}. MPR ready.` : `Loaded ${sourceLabel}.`,
      'ok'
    );
  }

  // The working view is the MPR grid — open straight into it whenever the study
  // supports it (Stack view remains available under Tools for single images).
  if (state.volume) setLayout('mpr');
  else if (state.layout === 'mpr') setLayout('stack');
}

// Groups entries by SeriesInstanceUID so the sidebar shows one row per series
// instead of one row per individual slice (which is unusable past a handful of images).
function computeSeriesGroups() {
  const groups = [];
  const byUid = new Map();
  state.entries.forEach((entry, i) => {
    const uid = entry.dataSet.string('x0020000e') || `__no_series_uid_${entry.name}`;
    let group = byUid.get(uid);
    if (!group) {
      group = {
        uid,
        description: entry.dataSet.string('x0008103e') || entry.dataSet.string('x00081030') || 'Series',
        modality: entry.dataSet.string('x00080060') || '',
        indices: [],
      };
      byUid.set(uid, group);
      groups.push(group);
    }
    group.indices.push(i);
  });
  return groups;
}

function findGroupForIndex(groups, index) {
  return groups.find(g => g.indices.includes(index));
}

function buildFileList() {
  el.fileCount.textContent = state.entries.length;
  el.fileList.innerHTML = '';
  state.lastSeriesGroups = computeSeriesGroups();

  state.lastSeriesGroups.forEach(group => {
    const li = document.createElement('li');
    li.className = 'seriesRow';
    li.title = group.description;
    li.innerHTML = `
      <svg class="seriesRowIcon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 2 6l8 4 8-4z"/><path d="M2 10l8 4 8-4"/><path d="M2 14l8 4 8-4"/></svg>
      <div class="seriesRowBody">
        <div class="seriesRowTitle">${group.description}</div>
        <div class="seriesRowMeta">
          ${group.modality ? `<span class="modBadge">${group.modality}</span>` : ''}
          <span>${group.indices.length} slice${group.indices.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
    if (group.indices.includes(state.currentIndex)) li.classList.add('active');
    li.addEventListener('click', () => { state.currentIndex = group.indices[0]; loadCurrent(true); });
    el.fileList.appendChild(li);
  });
}

function setActiveListItem() {
  const groups = state.lastSeriesGroups || computeSeriesGroups();
  const activeGroup = findGroupForIndex(groups, state.currentIndex);
  [...el.fileList.children].forEach((li, i) => {
    li.classList.toggle('active', groups[i] === activeGroup);
  });
}

// What the scrub bar / cine controls right now: the stack in Stack view, or the
// active MPR pane's through-plane slices in Grid view (the maximized pane if one is
// blown up, otherwise the axial pane). Returns null when there's nothing to scroll.
function scrubTarget() {
  if (state.layout === 'stack') {
    const n = state.entries.length;
    if (n <= 1) return null;
    return {
      count: n,
      get: () => state.currentIndex,
      set: (i) => {
        i = clampInt(i, 0, n - 1);
        if (i !== state.currentIndex) { state.currentIndex = i; loadCurrent(false); }
      },
    };
  }
  if (!state.volume) return null;
  const keys = Object.keys(state.panes);
  const usable = (k) => k && state.panes[k] && state.panes[k].plane !== 'off';
  // Follow whichever pane the doctor actually clicked into (state.activePane),
  // not a hardcoded axial-first guess — a maximized pane still wins outright.
  const key = (state.maximizedPane && usable(state.maximizedPane)) ? state.maximizedPane
    : usable(state.activePane) ? state.activePane
    : keys.find(k => state.panes[k].plane === 'axial')
    || keys.find(k => state.panes[k].plane !== 'off');
  if (!key) return null;
  const plane = state.panes[key].plane;
  if (plane === 'off') return null;
  const def = PLANE_DEFS[plane];
  const vol = state.volume;
  const axis = { axial: 'z', sagittal: 'x', coronal: 'y' }[plane];
  return {
    count: def.count(vol),
    get: () => planeSliceIndex(plane, state.cursor, vol),
    set: (i) => {
      state.cursor[axis] = clampInt(i, 0, def.count(vol) - 1);
      renderAllPanes();
    },
  };
}

// Refreshes the scrub bar's slider/label and visibility from the current target.
// (Named updateScrubber for the existing call sites.)
function updateScrubber() {
  const t = scrubTarget();
  if (!t || t.count <= 1) { el.scrubber.classList.add('hidden'); stopCine(); return; }
  el.scrubber.classList.remove('hidden');
  el.scrubSlider.max = String(t.count - 1);
  el.scrubSlider.value = String(t.get());
  el.scrubLabel.textContent = `${t.get() + 1} / ${t.count}`;
}

// ---------- Cine (auto-scroll) ----------
let cineTimer = null;
function updateCineBtn() {
  const playing = cineTimer !== null;
  el.cinePlay.textContent = playing ? '❚❚' : '▶';
  el.cinePlay.classList.toggle('playing', playing);
}
function stopCine() {
  if (cineTimer !== null) { clearInterval(cineTimer); cineTimer = null; updateCineBtn(); }
}
function startCine() {
  stopCine();
  const t = scrubTarget();
  if (!t || t.count <= 1) return;
  const fps = parseInt(el.cineSpeed.value, 10) || 12;
  cineTimer = setInterval(() => {
    const cur = scrubTarget();
    if (!cur || cur.count <= 1) { stopCine(); return; }
    let i = cur.get() + 1;
    if (i >= cur.count) i = 0; // loop back to the top
    cur.set(i);
    // set() repaints; sync the slider/label without re-triggering input events
    el.scrubSlider.value = String(cur.get());
    el.scrubLabel.textContent = `${cur.get() + 1} / ${cur.count}`;
  }, 1000 / fps);
  updateCineBtn();
}
function toggleCine() { cineTimer !== null ? stopCine() : startCine(); }

// ---------- DICOM decoding ----------

// Lazy-loaded only when a JPEG-Lossless-compressed file is actually encountered —
// verified against the library's own real test DICOM (jpeg_lossless_sel1.dcm):
// decoded dimensions and pixel values matched exactly, image rendered correctly.
let jpegLosslessModulePromise = null;
function loadJpegLosslessDecoder() {
  if (!jpegLosslessModulePromise) {
    jpegLosslessModulePromise = import('https://cdn.jsdelivr.net/npm/jpeg-lossless-decoder-js@2.1.2/release/lossless.js');
  }
  return jpegLosslessModulePromise;
}

// DICOM RLE Lossless (PS3.5 Annex G): a 64-byte header (segment count + up to 15
// little-endian offsets) followed by one PackBits-encoded segment per byte-plane.
function unpackBits(src, expectedLength) {
  const out = new Uint8Array(expectedLength);
  let si = 0, di = 0;
  while (di < expectedLength && si < src.length) {
    const n = src[si++];
    if (n <= 127) {
      for (let i = 0; i <= n && di < expectedLength && si < src.length; i++) out[di++] = src[si++];
    } else if (n > 128) {
      const count = 257 - n;
      const val = src[si++];
      for (let i = 0; i < count && di < expectedLength; i++) out[di++] = val;
    }
    // n === 128 is a documented no-op.
  }
  return out;
}

function decodeRle(fragmentBytes, rows, cols, samplesPerPixel, bitsAllocated) {
  const view = new DataView(fragmentBytes.buffer, fragmentBytes.byteOffset, fragmentBytes.length);
  const numSegments = view.getUint32(0, true);
  const offsets = [];
  for (let i = 0; i < 15; i++) offsets.push(view.getUint32(4 + i * 4, true));

  const pixelsPerSegment = rows * cols;
  const bytesPerSample = bitsAllocated > 8 ? 2 : 1;
  const expectedSegments = samplesPerPixel * bytesPerSample;
  if (numSegments !== expectedSegments) {
    throw new Error(`RLE segment count ${numSegments} does not match expected ${expectedSegments} for ${samplesPerPixel} sample(s) x ${bytesPerSample} byte(s)`);
  }

  const segments = [];
  for (let s = 0; s < numSegments; s++) {
    const start = offsets[s];
    const end = s < numSegments - 1 ? offsets[s + 1] : fragmentBytes.length;
    segments.push(unpackBits(fragmentBytes.subarray(start, end), pixelsPerSegment));
  }

  if (bytesPerSample === 1) {
    if (samplesPerPixel === 1) return segments[0];
    const out = new Uint8Array(pixelsPerSegment * samplesPerPixel);
    for (let i = 0; i < pixelsPerSegment; i++) {
      for (let c = 0; c < samplesPerPixel; c++) out[i * samplesPerPixel + c] = segments[c][i];
    }
    return out;
  }
  // 16-bit: two segments per sample, most-significant byte first (DICOM RLE spec).
  const out = new Uint16Array(pixelsPerSegment * samplesPerPixel);
  for (let c = 0; c < samplesPerPixel; c++) {
    const hi = segments[c * 2], lo = segments[c * 2 + 1];
    for (let i = 0; i < pixelsPerSegment; i++) out[i * samplesPerPixel + c] = (hi[i] << 8) | lo[i];
  }
  return out;
}

// JPEG Baseline (8-bit lossy) is standard JPEG — decode with the browser's own
// built-in decoder rather than a bundled one.
async function decodeBaselineJpeg(jpegBytes, rows, cols, samplesPerPixel) {
  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width !== cols || bitmap.height !== rows) {
    bitmap.close();
    throw new Error(`decoded JPEG size ${bitmap.width}x${bitmap.height} does not match declared ${cols}x${rows}`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const cctx = canvas.getContext('2d');
  cctx.drawImage(bitmap, 0, 0);
  const imgData = cctx.getImageData(0, 0, cols, rows);
  bitmap.close();

  if (samplesPerPixel === 1) {
    const pixels = new Uint8Array(rows * cols);
    for (let i = 0; i < pixels.length; i++) pixels[i] = imgData.data[i * 4];
    return pixels;
  }
  const pixels = new Uint8Array(rows * cols * 3);
  for (let i = 0; i < rows * cols; i++) {
    pixels[i * 3] = imgData.data[i * 4];
    pixels[i * 3 + 1] = imgData.data[i * 4 + 1];
    pixels[i * 3 + 2] = imgData.data[i * 4 + 2];
  }
  return pixels;
}

// Returns { pixels, rows, cols, samplesPerPixel, bitsAllocated, pixelRepresentation }
// for one frame, transparently decoding compressed transfer syntaxes on demand.
//
// The DICOM Basic Offset Table (frame -> fragment mapping) is OPTIONAL — plenty of
// real encoders write it empty and expect the reader to infer frame boundaries.
// dicom-parser's readEncapsulatedImageFrame requires a populated table and throws
// (a bare string, not an Error) when it's empty, so: use it when a real table is
// present, otherwise fall back to the standard convention ourselves.
function readFrameFragment(dataSet, pdElement, frame, numberOfFrames) {
  const nFrames = numberOfFrames || 1;
  const bot = pdElement.basicOffsetTable || [];

  if (bot.length === nFrames) {
    try {
      return dicomParser.readEncapsulatedImageFrame(dataSet, pdElement, frame);
    } catch (e) {
      throw new Error(`could not read compressed frame ${frame + 1}: ${errMsg(e)}`);
    }
  }

  const fragments = pdElement.fragments || [];
  let startFragmentIndex, numFragments;
  if (fragments.length === nFrames) {
    // Most common convention when the offset table is omitted: one fragment per frame.
    startFragmentIndex = frame;
    numFragments = 1;
  } else if (nFrames === 1) {
    // A single frame split across multiple size-limited fragments.
    startFragmentIndex = 0;
    numFragments = fragments.length;
  } else {
    throw new Error(
      `cannot determine frame boundaries: ${fragments.length} fragment(s) for ${nFrames} frame(s) and no offset table`
    );
  }

  try {
    return dicomParser.readEncapsulatedPixelDataFromFragments(dataSet, pdElement, startFragmentIndex, numFragments);
  } catch (e) {
    throw new Error(`could not read compressed frame ${frame + 1}: ${errMsg(e)}`);
  }
}

async function decodeFramePixels(dataSet, frame) {
  const rows = dataSet.uint16('x00280010');
  const cols = dataSet.uint16('x00280011');
  const bitsAllocated = dataSet.uint16('x00280100') || 16;
  const pixelRepresentation = dataSet.uint16('x00280103') || 0;
  const samplesPerPixel = dataSet.uint16('x00280002') || 1;

  const pdElement = dataSet.elements.x7fe00010;
  if (!pdElement || !rows || !cols) {
    throw new Error('No pixel data / dimensions found');
  }
  const numberOfFrames = parseInt(dataSet.string('x00280008'), 10) || 1;

  const ts = (dataSet.string('x00020010') || '').trim();

  if (ts === '1.2.840.10008.1.2.2') {
    throw new Error('big-endian transfer syntax not supported — re-export as little-endian');
  }
  if (ts === '1.2.840.10008.1.2.1.99') {
    throw new Error('deflated transfer syntax not supported — re-export as uncompressed');
  }

  if (ts === '1.2.840.10008.1.2.4.57' || ts === '1.2.840.10008.1.2.4.70') {
    // JPEG Lossless, Process 14 (.57 = any selection value, .70 = SV1 specifically) —
    // the decoder reads the actual selection value from the JPEG stream itself.
    const { Decoder } = await loadJpegLosslessDecoder();
    const jpegBytes = readFrameFragment(dataSet, pdElement, frame, numberOfFrames);
    const decoder = new Decoder();
    let pixels;
    try {
      pixels = decoder.decode(jpegBytes.buffer, jpegBytes.byteOffset, jpegBytes.length);
    } catch (e) {
      throw new Error(`JPEG Lossless decode failed: ${errMsg(e)}`);
    }
    if (decoder.xDim !== cols || decoder.yDim !== rows) {
      throw new Error(`decoded frame size ${decoder.xDim}x${decoder.yDim} does not match declared ${cols}x${rows}`);
    }
    return { pixels, rows, cols, samplesPerPixel: decoder.numComp || samplesPerPixel, bitsAllocated, pixelRepresentation };
  }

  if (ts === '1.2.840.10008.1.2.5') {
    const fragBytes = readFrameFragment(dataSet, pdElement, frame, numberOfFrames);
    const pixels = decodeRle(fragBytes, rows, cols, samplesPerPixel, bitsAllocated);
    return { pixels, rows, cols, samplesPerPixel, bitsAllocated, pixelRepresentation };
  }

  if (ts === '1.2.840.10008.1.2.4.50' || ts === '1.2.840.10008.1.2.4.51') {
    if (bitsAllocated > 8) {
      throw new Error(`JPEG Extended (12-bit, transfer syntax ${ts}) not supported — re-export as uncompressed`);
    }
    const jpegBytes = readFrameFragment(dataSet, pdElement, frame, numberOfFrames);
    const pixels = await decodeBaselineJpeg(jpegBytes, rows, cols, samplesPerPixel);
    return { pixels, rows, cols, samplesPerPixel, bitsAllocated: 8, pixelRepresentation: 0 };
  }

  if (ts.startsWith('1.2.840.10008.1.2.4')) {
    // JPEG 2000 / JPEG-LS — not implemented.
    throw new Error(`compressed pixel data (transfer syntax ${ts}) not supported — re-export the study as uncompressed DICOM`);
  }

  // Raw / uncompressed — read directly from the dataset's backing buffer.
  const bytesPerSample = bitsAllocated > 8 ? 2 : 1;
  const frameBytes = rows * cols * samplesPerPixel * bytesPerSample;
  const frameOffset = pdElement.dataOffset + frame * frameBytes;
  if (frameOffset + frameBytes > pdElement.dataOffset + pdElement.length) {
    throw new Error(`pixel data too short for frame ${frame + 1} (file may be truncated)`);
  }
  let pixels;
  if (samplesPerPixel === 1) {
    if (bitsAllocated === 16) {
      pixels = pixelRepresentation === 1
        ? new Int16Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + frameOffset, rows * cols)
        : new Uint16Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + frameOffset, rows * cols);
    } else {
      pixels = new Uint8Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + frameOffset, rows * cols);
    }
  } else {
    pixels = new Uint8Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + frameOffset, rows * cols * samplesPerPixel);
  }
  return { pixels, rows, cols, samplesPerPixel, bitsAllocated, pixelRepresentation };
}

async function decodePixels(dataSet, frame = 0) {
  const photometric = (dataSet.string('x00280004') || 'MONOCHROME2').trim();
  const slope = parseFloat(dataSet.string('x00281053')) || 1;
  const intercept = parseFloat(dataSet.string('x00281052')) || 0;

  let windowCenter = parseFloat((dataSet.string('x00281050') || '').split('\\')[0]);
  let windowWidth = parseFloat((dataSet.string('x00281051') || '').split('\\')[0]);

  const { pixels, rows, cols, samplesPerPixel } = await decodeFramePixels(dataSet, frame);

  if (isNaN(windowCenter) || isNaN(windowWidth)) {
    // Derive a sensible default from the actual data range.
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i] * slope + intercept;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    windowCenter = (min + max) / 2;
    windowWidth = Math.max(1, max - min);
  }

  return {
    rows, cols, samplesPerPixel, photometric,
    slope, intercept, pixels,
    windowCenter, windowWidth,
  };
}

// Compressed-frame decoding is genuinely async now, so fast navigation (wheel/scrubber)
// can fire several loadCurrent calls before earlier ones finish. A token guard makes
// sure a slower, now-stale decode never overwrites a newer one's result.
let loadCurrentToken = 0;

async function loadCurrent(resetView) {
  const entry = state.entries[state.currentIndex];
  if (!entry) return;
  const myToken = ++loadCurrentToken;
  const myIndex = state.currentIndex;

  if (!entry.image) {
    try {
      entry.image = await decodePixels(entry.dataSet, entry.frame || 0);
      entry.wc = entry.image.windowCenter;
      entry.ww = entry.image.windowWidth;
    } catch (e) {
      if (myToken === loadCurrentToken) setStatus(`Failed to decode ${entry.name}: ${errMsg(e)}`, 'err');
      return;
    }
  }

  if (myToken !== loadCurrentToken || state.currentIndex !== myIndex) return; // superseded

  if (resetView) resetViewport();
  setActiveListItem();
  await ensureVolumeForCurrentSeries();
  updateMetaTable(entry);
  updateScrubber();
  render();
}

// ---------- Stack view rendering ----------

function resetViewport() {
  state.scale = 1;
  state.panX = 0;
  state.panY = 0;
  fitToWindow();
}

function fitToWindow() {
  const entry = state.entries[state.currentIndex];
  if (!entry || !entry.image) return;
  const { rows, cols } = entry.image;
  const scaleX = el.canvas.width / cols;
  const scaleY = el.canvas.height / rows;
  state.scale = Math.min(scaleX, scaleY) * 0.95;
  state.panX = 0;
  state.panY = 0;
}

function render() {
  const entry = state.entries[state.currentIndex];
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
  if (!entry || !entry.image) return;

  const img = entry.image;
  const off = renderToOffscreen(img, entry.wc, entry.ww);

  const drawW = img.cols * state.scale;
  const drawH = img.rows * state.scale;
  const dx = (el.canvas.width - drawW) / 2 + state.panX;
  const dy = (el.canvas.height - drawH) / 2 + state.panY;

  ctx.imageSmoothingEnabled = state.scale < 1;
  ctx.drawImage(off, dx, dy, drawW, drawH);

  updateOverlays(entry);
}

function renderToOffscreen(img, wc, ww) {
  const { rows, cols, samplesPerPixel, photometric, slope, intercept, pixels } = img;
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const octx = off.getContext('2d');
  const imageData = octx.createImageData(cols, rows);
  const out = imageData.data;

  const lo = wc - ww / 2;
  const hi = wc + ww / 2;
  const range = Math.max(1, hi - lo);
  const invertMono = photometric === 'MONOCHROME1';

  if (samplesPerPixel === 1) {
    for (let i = 0; i < rows * cols; i++) {
      const raw = pixels[i] * slope + intercept;
      let v = ((raw - lo) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (invertMono) v = 255 - v;
      if (state.invert) v = 255 - v;
      const o = i * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  } else {
    for (let i = 0; i < rows * cols; i++) {
      const s = i * samplesPerPixel;
      const o = i * 4;
      let r = pixels[s], g = pixels[s + 1], b = pixels[s + 2];
      if (state.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }

  octx.putImageData(imageData, 0, 0);
  return off;
}

function updateOverlays(entry) {
  const ds = entry.dataSet;
  const img = entry.image;
  const patientName = (ds.string('x00100010') || '').replace(/\^/g, ' ').trim() || 'Unknown';
  const patientId = ds.string('x00100020') || '';
  const studyDate = formatDate(ds.string('x00080020'));
  const modality = ds.string('x00080060') || '';
  const seriesDesc = ds.string('x0008103e') || '';

  el.overlayTL.textContent = `${patientName}\nID: ${patientId}`;
  el.overlayTR.textContent = `${modality}  ${studyDate}\n${seriesDesc}`;
  el.overlayBL.textContent = `${img.cols} x ${img.rows}\nZoom: ${(state.scale * 100).toFixed(0)}%`;
  el.overlayBR.textContent = `WC: ${entry.wc.toFixed(0)}  WW: ${entry.ww.toFixed(0)}\n${state.currentIndex + 1} / ${state.entries.length}`;
}

function formatDate(d) {
  if (!d || d.length !== 8) return d || '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function updateMetaTable(entry) {
  const ds = entry.dataSet;
  // Grouped into labeled clusters instead of one flat 13-row dump — reads as an
  // instrument readout with real structure, not a spreadsheet export.
  const groups = [
    ['Patient', [
      ['Patient Name', (ds.string('x00100010') || '').replace(/\^/g, ' ')],
      ['Patient ID', ds.string('x00100020')],
      ['Sex / Age', `${ds.string('x00100040') || ''} ${ds.string('x00101010') || ''}`],
    ]],
    ['Study', [
      ['Study Date', formatDate(ds.string('x00080020'))],
      ['Modality', ds.string('x00080060')],
      ['Study Desc', ds.string('x00081030')],
      ['Series Desc', ds.string('x0008103e')],
      ['Series #', ds.string('x00200011')],
      ['Instance #', ds.string('x00200013')],
    ]],
    ['Image', [
      ['Manufacturer', ds.string('x00080070')],
      ['Rows x Cols', entry.image ? `${entry.image.rows} x ${entry.image.cols}` : ''],
      ['Pixel Spacing', ds.string('x00280030')],
      ['Slice Thickness', ds.string('x00180050')],
    ]],
  ];
  el.metaTable.innerHTML = groups
    .map(([label, rows]) => {
      const filled = rows.filter(([, v]) => v && v.trim());
      if (!filled.length) return '';
      const heading = `<tr class="metaGroup"><td colspan="2">${label}</td></tr>`;
      const body = filled.map(([k, v]) => `<tr><td>${k}</td><td>${v.trim()}</td></tr>`).join('');
      return heading + body;
    })
    .join('');
}

// ---------- Stack view interaction ----------

let dragMode = null;
let dragStart = { x: 0, y: 0 };
let dragStartWC = 0, dragStartWW = 0;
let dragStartPan = { x: 0, y: 0 };

el.canvas.addEventListener('mousedown', (e) => {
  if (state.currentIndex < 0) return;
  dragStart = { x: e.clientX, y: e.clientY };
  const entry = state.entries[state.currentIndex];
  dragStartWC = entry.wc;
  dragStartWW = entry.ww;
  dragStartPan = { x: state.panX, y: state.panY };
  if (e.button === 0) dragMode = 'wl';
  else if (e.button === 1) dragMode = 'pan';
  else if (e.button === 2) dragMode = 'zoom';
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragMode || state.currentIndex < 0) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  const entry = state.entries[state.currentIndex];

  if (dragMode === 'wl') {
    entry.ww = Math.max(1, dragStartWW + dx * 2);
    entry.wc = dragStartWC + dy * 2;
  } else if (dragMode === 'pan') {
    state.panX = dragStartPan.x + dx;
    state.panY = dragStartPan.y + dy;
  } else if (dragMode === 'zoom') {
    const factor = Math.exp(-dy * 0.01);
    state.scale = Math.max(0.05, Math.min(20, state.scale * factor));
    dragStart = { x: e.clientX, y: e.clientY };
  }
  render();
});

window.addEventListener('mouseup', () => { dragMode = null; });
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

el.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!state.entries.length) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  const next = state.currentIndex + dir;
  if (next >= 0 && next < state.entries.length) {
    state.currentIndex = next;
    loadCurrent(false);
  }
}, { passive: false });

el.canvas.addEventListener('dblclick', () => { fitToWindow(); render(); });

el.canvas.addEventListener('mousemove', (e) => {
  const entry = state.entries[state.currentIndex];
  if (dragMode || !entry || !entry.image) { el.stackHu.classList.add('hidden'); return; }
  const rect = el.canvas.getBoundingClientRect();
  const img = entry.image;
  const drawW = img.cols * state.scale;
  const drawH = img.rows * state.scale;
  const dx = (el.canvas.width - drawW) / 2 + state.panX;
  const dy = (el.canvas.height - drawH) / 2 + state.panY;
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const px = Math.floor((sx - dx) / state.scale);
  const py = Math.floor((sy - dy) / state.scale);
  if (px < 0 || py < 0 || px >= img.cols || py >= img.rows) { el.stackHu.classList.add('hidden'); return; }
  const v = img.pixels[py * img.cols + px] * img.slope + img.intercept;
  el.stackHu.textContent = `${Math.round(v)} HU`;
  el.stackHu.style.left = `${sx + 14}px`;
  el.stackHu.style.top = `${sy + 14}px`;
  el.stackHu.classList.remove('hidden');
});
el.canvas.addEventListener('mouseleave', () => el.stackHu.classList.add('hidden'));

el.scrubSlider.addEventListener('input', () => {
  const t = scrubTarget();
  if (t) t.set(parseInt(el.scrubSlider.value, 10));
});
el.scrubPrev.addEventListener('click', () => {
  const t = scrubTarget();
  if (t) t.set(t.get() - 1);
});
el.scrubNext.addEventListener('click', () => {
  const t = scrubTarget();
  if (t) t.set(t.get() + 1);
});
el.cinePlay.addEventListener('click', toggleCine);
el.cineSpeed.addEventListener('change', () => { if (cineTimer !== null) startCine(); }); // apply new speed live
updateCineBtn();

// ---------- Volume construction (for MPR) ----------

// The volume is built from the currently active SERIES only, never from everything
// loaded — real studies mix an axial stack with scouts/recons of different geometry,
// and combining them produces either no volume at all or scrambled reformats.
let volumeBuildToken = 0;

async function buildVolume() {
  const myToken = ++volumeBuildToken;
  state.volume = null;
  state.cursor = null;
  state.volumeSeriesUid = null;

  const groups = computeSeriesGroups();
  const group = findGroupForIndex(groups, state.currentIndex) || groups[0];
  if (!group) return;
  const entries = group.indices.map(i => state.entries[i]);
  if (entries.length < 3) return; // not enough slices for a meaningful volume

  const toDecode = entries.filter(e => !e.image).length;
  // Only worth the overlay for a real decode job — a handful of already-cached
  // slices finishes instantly and a flashed-then-gone bar is just noise. This
  // makes buildVolume self-sufficient for every caller (PACS, local files,
  // clicking a series row), not just the ones that already manage the overlay.
  const usingOverlay = toDecode > 20;
  let decoded = 0;
  try {
    if (usingOverlay) {
      showLoadingProgress(
        `Reconstructing volume`, 0, toDecode,
        `Building the 3D view from all ${toDecode} slices — happens once per series, then it's instant.`
      );
    }
    for (const e of entries) {
      if (!e.image) {
        try {
          e.image = await decodePixels(e.dataSet, e.frame || 0);
          e.wc = e.image.windowCenter;
          e.ww = e.image.windowWidth;
        } catch (err) {
          return;
        }
        if (myToken !== volumeBuildToken) return; // a newer build superseded this one
        decoded++;
        if (usingOverlay && (decoded % 15 === 0 || decoded === toDecode)) {
          showLoadingProgress(`Reconstructing volume — ${decoded} / ${toDecode}`, decoded, toDecode);
          await yieldToUI();
        }
      }
    }
  } finally {
    if (usingOverlay) hideLoadingProgress();
  }

  const first = entries[0].image;
  const rows = first.rows, cols = first.cols;
  for (const e of entries) {
    if (e.image.rows !== rows || e.image.cols !== cols || e.image.samplesPerPixel !== 1) return;
  }

  const withZ = entries.map(e => {
    const ipp = (e.dataSet.string('x00200032') || '').split('\\').map(Number);
    return ipp.length === 3 && !isNaN(ipp[2]) ? ipp[2] : null;
  });

  let ordered;
  if (withZ.every(z => z !== null)) {
    ordered = entries.slice().sort((a, b) => {
      const az = withZ[entries.indexOf(a)];
      const bz = withZ[entries.indexOf(b)];
      return az - bz;
    });
  } else {
    ordered = entries; // already sorted by instance number during load
  }

  const n = ordered.length;

  const psStr = ordered[0].dataSet.string('x00280030');
  let rowSpacing = 1, colSpacing = 1;
  if (psStr) {
    const parts = psStr.split('\\').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      rowSpacing = parts[0];
      colSpacing = parts[1];
    }
  }

  const zs = ordered.map(e => {
    const ipp = (e.dataSet.string('x00200032') || '').split('\\').map(Number);
    return ipp.length === 3 ? ipp[2] : NaN;
  });
  let sliceSpacing = 0;
  if (zs.every(z => !isNaN(z)) && n > 1) {
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.abs(zs[i] - zs[i - 1]);
    sliceSpacing = total / (n - 1);
  }
  if (!sliceSpacing || !isFinite(sliceSpacing)) {
    // Multi-frame files share one ImagePositionPatient across all frames, so the
    // z-delta above degenerates to 0 — fall back to the explicit spacing tags.
    sliceSpacing = parseFloat(ordered[0].dataSet.string('x00180088'))
      || parseFloat(ordered[0].dataSet.string('x00180050'))
      || 1;
  }

  const data = new Float32Array(n * rows * cols);
  for (let z = 0; z < n; z++) {
    const img = ordered[z].image;
    const { pixels, slope, intercept } = img;
    const base = z * rows * cols;
    for (let i = 0; i < rows * cols; i++) data[base + i] = pixels[i] * slope + intercept;
  }

  const mid = ordered[Math.floor(n / 2)].image;

  state.volume = {
    data, rows, cols, slices: n,
    rowSpacing, colSpacing, sliceSpacing,
    monochrome1: first.photometric === 'MONOCHROME1',
    defaultWc: mid.windowCenter,
    defaultWw: mid.windowWidth,
  };
  state.cursor = { x: Math.floor(cols / 2), y: Math.floor(rows / 2), z: Math.floor(n / 2) };
  state.mprTilt = { rx: 0, ry: 0, rz: 0 }; // tilt correction resets per volume
  state.mprWc = mid.windowCenter;
  state.mprWw = mid.windowWidth;
  state.volumeSeriesUid = group.uid;
  // Map volume z-index back to the entry index so the stack view can follow the cursor if needed.
  state.volumeEntryIndices = ordered.map(e => state.entries.indexOf(e));
}

// Rebuilds the volume when the active series changes (series click, scrub/wheel
// across a series boundary). No-op when the cursor stays within the same series.
async function ensureVolumeForCurrentSeries() {
  const groups = state.lastSeriesGroups || computeSeriesGroups();
  const group = findGroupForIndex(groups, state.currentIndex);
  if (!group || group.uid === state.volumeSeriesUid) return;
  await buildVolume();
  el.btnLayoutGrid.disabled = !state.volume;
  el.gridSizeSelect.disabled = !state.volume;
  if (state.layout === 'mpr') {
    if (!state.volume) setLayout('stack');
    else {
      Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
      renderAllPanes();
    }
  }
}

// ---------- MPR plane definitions ----------
// Each plane fixes one volume axis (via the shared cursor) and displays the other two.

function clampInt(v, lo, hi) { v = Math.round(v); return v < lo ? lo : v > hi ? hi : v; }

const PLANE_DEFS = {
  axial: {
    spacingX: v => v.colSpacing, spacingY: v => v.rowSpacing,
    sliceIndex: c => c.z, count: v => v.slices,
    cursorToPx: c => ({ px: c.x, py: c.y }),
    pxToCursor: (px, py) => ({ x: px, y: py }),
    stepCursor: (c, dir, v) => { c.z = clampInt(c.z + dir, 0, v.slices - 1); },
  },
  // Volume z increases toward the head (ascending ImagePositionPatient Z), so a
  // sagittal/coronal row built straight from z would put feet at the top. Both the
  // slice extraction and the crosshair mapping flip z -> (slices-1-z) so head ends
  // up at the top, matching standard radiological display convention.
  sagittal: {
    spacingX: v => v.rowSpacing, spacingY: v => v.sliceSpacing,
    sliceIndex: c => c.x, count: v => v.cols,
    cursorToPx: (c, v) => ({ px: c.y, py: v.slices - 1 - c.z }),
    pxToCursor: (px, py, v) => ({ y: px, z: v.slices - 1 - py }),
    stepCursor: (c, dir, v) => { c.x = clampInt(c.x + dir, 0, v.cols - 1); },
  },
  coronal: {
    spacingX: v => v.colSpacing, spacingY: v => v.sliceSpacing,
    sliceIndex: c => c.y, count: v => v.rows,
    cursorToPx: (c, v) => ({ px: c.x, py: v.slices - 1 - c.z }),
    pxToCursor: (px, py, v) => ({ x: px, z: v.slices - 1 - py }),
    stepCursor: (c, dir, v) => { c.y = clampInt(c.y + dir, 0, v.rows - 1); },
  },
};

// ---------- Tilt correction (oblique MPR) ----------
// The volume is often perfectly axis-aligned while the PATIENT wasn't (head tilted
// or rotated in the scanner) — so straight planes cut the anatomy crookedly. These
// angles rotate the three cut planes together in patient mm-space; Alt-drag on a
// pane adjusts the angle about that pane's normal. Zero tilt uses the fast
// axis-aligned extraction path unchanged.

const PLANE_BASES = {
  axial: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  sagittal: { u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] },
  coronal: { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
};

function tiltActive() {
  const t = state.mprTilt;
  return !!t && (t.rx !== 0 || t.ry !== 0 || t.rz !== 0);
}

function rotMat(rxDeg, ryDeg, rzDeg) { // R = Rz * Ry * Rx
  const d = Math.PI / 180, ax = rxDeg * d, ay = ryDeg * d, az = rzDeg * d;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

function mulV(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// Everything the oblique sampler and the cursor mapping need for one plane:
// rotated mm-space axes, output pixel spacings, and the centers that anchor the
// rotation to the middle of the volume.
function planeFrame(vol, plane) {
  const b = PLANE_BASES[plane];
  const t = state.mprTilt || { rx: 0, ry: 0, rz: 0 };
  const R = rotMat(t.rx, t.ry, t.rz);
  const def = PLANE_DEFS[plane];
  const dims = {
    axial: { width: vol.cols, height: vol.rows, count: vol.slices, sn: vol.sliceSpacing },
    sagittal: { width: vol.rows, height: vol.slices, count: vol.cols, sn: vol.colSpacing },
    coronal: { width: vol.cols, height: vol.slices, count: vol.rows, sn: vol.rowSpacing },
  }[plane];
  return {
    u: mulV(R, b.u), v: mulV(R, b.v), n: mulV(R, b.n),
    su: def.spacingX(vol), sv: def.spacingY(vol), sn: dims.sn,
    cu: (dims.width - 1) / 2, cv: (dims.height - 1) / 2, cn: (dims.count - 1) / 2,
    width: dims.width, height: dims.height, count: dims.count,
  };
}

function trilinearSample(data, cols, rows, slices, x, y, z) {
  if (x < -0.5 || y < -0.5 || z < -0.5 || x > cols - 0.5 || y > rows - 0.5 || z > slices - 0.5) return -1024;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  if (x0 < 0 || y0 < 0 || z0 < 0 || x0 >= cols - 1 || y0 >= rows - 1 || z0 >= slices - 1) {
    return data[clampInt(z, 0, slices - 1) * rows * cols + clampInt(y, 0, rows - 1) * cols + clampInt(x, 0, cols - 1)];
  }
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const i000 = z0 * rows * cols + y0 * cols + x0;
  const i010 = i000 + cols, i001 = i000 + rows * cols, i011 = i001 + cols;
  const c00 = data[i000] * (1 - fx) + data[i000 + 1] * fx;
  const c10 = data[i010] * (1 - fx) + data[i010 + 1] * fx;
  const c01 = data[i001] * (1 - fx) + data[i001 + 1] * fx;
  const c11 = data[i011] * (1 - fx) + data[i011 + 1] * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

function obliqueSlice(vol, plane, index) {
  const f = planeFrame(vol, plane);
  const { data, rows, cols, slices } = vol;
  const out = new Float32Array(f.width * f.height);
  const wOff = (index - f.cn) * f.sn;
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2, cz = (slices - 1) / 2;
  const sxi = 1 / vol.colSpacing, syi = 1 / vol.rowSpacing, szi = 1 / vol.sliceSpacing;
  for (let py = 0; py < f.height; py++) {
    const dv = (py - f.cv) * f.sv;
    // Per-row constants: base point of the row in mm, stepped along u per pixel.
    let mx = dv * f.v[0] + wOff * f.n[0] + (0 - f.cu) * f.su * f.u[0];
    let my = dv * f.v[1] + wOff * f.n[1] + (0 - f.cu) * f.su * f.u[1];
    let mz = dv * f.v[2] + wOff * f.n[2] + (0 - f.cu) * f.su * f.u[2];
    const stepX = f.su * f.u[0], stepY = f.su * f.u[1], stepZ = f.su * f.u[2];
    const rowBase = py * f.width;
    for (let px = 0; px < f.width; px++) {
      out[rowBase + px] = trilinearSample(data, cols, rows, slices, cx + mx * sxi, cy + my * syi, cz + mz * szi);
      mx += stepX; my += stepY; mz += stepZ;
    }
  }
  return { data: out, width: f.width, height: f.height };
}

// Tilt-aware versions of the cursor/plane mappings. With zero tilt these all
// reduce exactly to the axis-aligned PLANE_DEFS behavior.
function planeSliceIndex(plane, cursor, vol) {
  if (!tiltActive()) return PLANE_DEFS[plane].sliceIndex(cursor);
  const f = planeFrame(vol, plane);
  const dx = (cursor.x - (vol.cols - 1) / 2) * vol.colSpacing;
  const dy = (cursor.y - (vol.rows - 1) / 2) * vol.rowSpacing;
  const dz = (cursor.z - (vol.slices - 1) / 2) * vol.sliceSpacing;
  const w = dx * f.n[0] + dy * f.n[1] + dz * f.n[2];
  return clampInt(w / f.sn + f.cn, 0, f.count - 1);
}

function planeCursorToPx(plane, cursor, vol) {
  if (!tiltActive()) return PLANE_DEFS[plane].cursorToPx(cursor, vol);
  const f = planeFrame(vol, plane);
  const dx = (cursor.x - (vol.cols - 1) / 2) * vol.colSpacing;
  const dy = (cursor.y - (vol.rows - 1) / 2) * vol.rowSpacing;
  const dz = (cursor.z - (vol.slices - 1) / 2) * vol.sliceSpacing;
  return {
    px: (dx * f.u[0] + dy * f.u[1] + dz * f.u[2]) / f.su + f.cu,
    py: (dx * f.v[0] + dy * f.v[1] + dz * f.v[2]) / f.sv + f.cv,
  };
}

function planePxToCursor(plane, px, py, vol) {
  if (!tiltActive()) return PLANE_DEFS[plane].pxToCursor(px, py, vol);
  const f = planeFrame(vol, plane);
  // Preserve the cursor's current depth along this plane's normal.
  const c = state.cursor;
  const dx0 = (c.x - (vol.cols - 1) / 2) * vol.colSpacing;
  const dy0 = (c.y - (vol.rows - 1) / 2) * vol.rowSpacing;
  const dz0 = (c.z - (vol.slices - 1) / 2) * vol.sliceSpacing;
  const w = dx0 * f.n[0] + dy0 * f.n[1] + dz0 * f.n[2];
  const du = (px - f.cu) * f.su, dv = (py - f.cv) * f.sv;
  const mx = du * f.u[0] + dv * f.v[0] + w * f.n[0];
  const my = du * f.u[1] + dv * f.v[1] + w * f.n[1];
  const mz = du * f.u[2] + dv * f.v[2] + w * f.n[2];
  return {
    x: clampInt((vol.cols - 1) / 2 + mx / vol.colSpacing, 0, vol.cols - 1),
    y: clampInt((vol.rows - 1) / 2 + my / vol.rowSpacing, 0, vol.rows - 1),
    z: clampInt((vol.slices - 1) / 2 + mz / vol.sliceSpacing, 0, vol.slices - 1),
  };
}

function planeStepCursor(plane, cursor, dir, vol) {
  if (!tiltActive()) { PLANE_DEFS[plane].stepCursor(cursor, dir, vol); return; }
  const f = planeFrame(vol, plane);
  cursor.x = clampInt(cursor.x + dir * f.sn * f.n[0] / vol.colSpacing, 0, vol.cols - 1);
  cursor.y = clampInt(cursor.y + dir * f.sn * f.n[1] / vol.rowSpacing, 0, vol.rows - 1);
  cursor.z = clampInt(cursor.z + dir * f.sn * f.n[2] / vol.sliceSpacing, 0, vol.slices - 1);
}

function sliceVolume(volume, plane, index) {
  const { rows, cols, slices, data } = volume;
  if (plane === 'axial') {
    const z = clampInt(index, 0, slices - 1);
    const width = cols, height = rows;
    const base = z * rows * cols;
    return { data: data.subarray(base, base + width * height), width, height };
  }
  if (plane === 'sagittal') {
    const x = clampInt(index, 0, cols - 1);
    const width = rows, height = slices;
    const out = new Float32Array(width * height);
    for (let z = 0; z < slices; z++) {
      const rowBase = z * rows * cols;
      const outRow = (slices - 1 - z) * rows;
      for (let y = 0; y < rows; y++) out[outRow + y] = data[rowBase + y * cols + x];
    }
    return { data: out, width, height };
  }
  // coronal
  const y = clampInt(index, 0, rows - 1);
  const width = cols, height = slices;
  const out = new Float32Array(width * height);
  for (let z = 0; z < slices; z++) {
    const rowBase = z * rows * cols + y * cols;
    const outRow = (slices - 1 - z) * cols;
    for (let x = 0; x < cols; x++) out[outRow + x] = data[rowBase + x];
  }
  return { data: out, width, height };
}

// Projections (MIP/MinIP/Average) walk a range of source slices along the plane's
// depth axis directly against the flat volume array — much faster than extracting
// each depth slice individually and combining them, since it touches each voxel once.
function projectAxial(volume, lo, hi, mode) {
  const { rows, cols, data } = volume;
  const width = cols, height = rows;
  const out = new Float32Array(width * height);
  out.fill(mode === 'minip' ? Infinity : mode === 'mip' ? -Infinity : 0);
  for (let z = lo; z <= hi; z++) {
    const base = z * rows * cols;
    if (mode === 'mip') { for (let i = 0; i < out.length; i++) { const v = data[base + i]; if (v > out[i]) out[i] = v; } }
    else if (mode === 'minip') { for (let i = 0; i < out.length; i++) { const v = data[base + i]; if (v < out[i]) out[i] = v; } }
    else { for (let i = 0; i < out.length; i++) out[i] += data[base + i]; }
  }
  if (mode === 'average') { const n = hi - lo + 1; for (let i = 0; i < out.length; i++) out[i] /= n; }
  return { data: out, width, height };
}

function projectSagittal(volume, lo, hi, mode) {
  const { rows, cols, slices, data } = volume;
  const width = rows, height = slices;
  const out = new Float32Array(width * height);
  const n = hi - lo + 1;
  for (let z = 0; z < slices; z++) {
    const rowBase = z * rows * cols;
    const outRow = (slices - 1 - z) * rows; // z increases toward the head — flip so head is at the top
    for (let y = 0; y < rows; y++) {
      const base = rowBase + y * cols;
      let agg = mode === 'minip' ? Infinity : mode === 'mip' ? -Infinity : 0;
      for (let x = lo; x <= hi; x++) {
        const v = data[base + x];
        if (mode === 'mip') { if (v > agg) agg = v; }
        else if (mode === 'minip') { if (v < agg) agg = v; }
        else agg += v;
      }
      out[outRow + y] = mode === 'average' ? agg / n : agg;
    }
  }
  return { data: out, width, height };
}

function projectCoronal(volume, lo, hi, mode) {
  const { rows, cols, slices, data } = volume;
  const width = cols, height = slices;
  const out = new Float32Array(width * height);
  const n = hi - lo + 1;
  for (let z = 0; z < slices; z++) {
    const zBase = z * rows * cols;
    const outRow = (slices - 1 - z) * cols; // z increases toward the head — flip so head is at the top
    for (let x = 0; x < cols; x++) {
      let agg = mode === 'minip' ? Infinity : mode === 'mip' ? -Infinity : 0;
      for (let y = lo; y <= hi; y++) {
        const v = data[zBase + y * cols + x];
        if (mode === 'mip') { if (v > agg) agg = v; }
        else if (mode === 'minip') { if (v < agg) agg = v; }
        else agg += v;
      }
      out[outRow + x] = mode === 'average' ? agg / n : agg;
    }
  }
  return { data: out, width, height };
}

const PROJECTORS = { axial: projectAxial, sagittal: projectSagittal, coronal: projectCoronal };

// projRange is the half-thickness in source slices on each side of the cursor position;
// 0 (or mode 'slice') falls back to the existing single-slice extraction.
function extractPaneData(volume, plane, index, projMode, projRange) {
  const oblique = tiltActive();
  const single = (i) => oblique ? obliqueSlice(volume, plane, i) : sliceVolume(volume, plane, i);
  if (!projMode || projMode === 'slice' || !projRange) return single(index);
  const depthCount = PLANE_DEFS[plane].count(volume);
  const lo = clampInt(index - projRange, 0, depthCount - 1);
  const hi = clampInt(index + projRange, 0, depthCount - 1);
  if (lo === hi) return single(index);
  if (!oblique) return PROJECTORS[plane](volume, lo, hi, projMode);
  // Tilted projection: accumulate oblique slices across the slab.
  const first = single(lo);
  const out = first.data;
  if (projMode === 'average') {
    for (let i = lo + 1; i <= hi; i++) {
      const s = single(i).data;
      for (let j = 0; j < out.length; j++) out[j] += s[j];
    }
    const n = hi - lo + 1;
    for (let j = 0; j < out.length; j++) out[j] /= n;
  } else {
    const wantMax = projMode === 'mip';
    for (let i = lo + 1; i <= hi; i++) {
      const s = single(i).data;
      for (let j = 0; j < out.length; j++) {
        if (wantMax ? s[j] > out[j] : s[j] < out[j]) out[j] = s[j];
      }
    }
  }
  return { data: out, width: first.width, height: first.height };
}

function windowToOffscreen(width, height, data, wc, ww, invert, monochrome1) {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const octx = off.getContext('2d');
  const imageData = octx.createImageData(width, height);
  const out = imageData.data;
  const lo = wc - ww / 2;
  const range = Math.max(1, ww);
  for (let i = 0; i < width * height; i++) {
    let v = ((data[i] - lo) / range) * 255;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (monochrome1) v = 255 - v;
    if (invert) v = 255 - v;
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = v;
    out[o + 3] = 255;
  }
  octx.putImageData(imageData, 0, 0);
  return off;
}

function drawCrosshair(pctx, w, h, sx, sy) {
  pctx.strokeStyle = 'rgba(147,179,203,0.75)'; // desaturated steel, matches the chrome
  pctx.lineWidth = 1;
  const gap = 8;
  pctx.beginPath();
  pctx.moveTo(0, sy); pctx.lineTo(sx - gap, sy);
  pctx.moveTo(sx + gap, sy); pctx.lineTo(w, sy);
  pctx.moveTo(sx, 0); pctx.lineTo(sx, sy - gap);
  pctx.moveTo(sx, sy + gap); pctx.lineTo(sx, h);
  pctx.stroke();
}

function fitPane(key, width, height, spacingX, spacingY) {
  const pane = state.panes[key];
  const canvas = el.panes[key].canvas;
  const scaleX = canvas.width / (width * spacingX);
  const scaleY = canvas.height / (height * spacingY);
  pane.scale = Math.min(scaleX, scaleY) * 0.9;
  pane.panX = 0;
  pane.panY = 0;
}

function renderMprPane(key) {
  const pane = state.panes[key];
  const paneEl = el.panes[key];
  const canvas = paneEl.canvas, pctx = paneEl.ctx;
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, canvas.width, canvas.height);
  paneEl.info.textContent = '';
  pane._transform = null;
  if (pane.plane === 'off' || !state.volume) return;

  const volume = state.volume;
  const def = PLANE_DEFS[pane.plane];
  const index = planeSliceIndex(pane.plane, state.cursor, volume);
  const { data, width, height } = extractPaneData(volume, pane.plane, index, pane.projMode, pane.projRange);
  const spacingX = def.spacingX(volume), spacingY = def.spacingY(volume);

  if (pane.scale == null) fitPane(key, width, height, spacingX, spacingY);

  const off = windowToOffscreen(width, height, data, state.mprWc, state.mprWw, state.invert, volume.monochrome1);
  const drawW = width * spacingX * pane.scale;
  const drawH = height * spacingY * pane.scale;
  const dx = (canvas.width - drawW) / 2 + pane.panX;
  const dy = (canvas.height - drawH) / 2 + pane.panY;

  pctx.imageSmoothingEnabled = pane.scale * Math.min(spacingX, spacingY) < 1;
  pctx.drawImage(off, dx, dy, drawW, drawH);

  const { px, py } = planeCursorToPx(pane.plane, state.cursor, volume);
  const sx = dx + px * spacingX * pane.scale;
  const sy = dy + py * spacingY * pane.scale;
  drawCrosshair(pctx, canvas.width, canvas.height, sx, sy);

  const projLabel = pane.projMode && pane.projMode !== 'slice' && pane.projRange
    ? `  ${pane.projMode.toUpperCase()} ±${pane.projRange}`
    : '';
  const t = state.mprTilt;
  const tiltLabel = tiltActive()
    ? `\nAlign ${[t.rx && `nod ${t.rx.toFixed(1)}°`, t.ry && `tilt ${t.ry.toFixed(1)}°`, t.rz && `turn ${t.rz.toFixed(1)}°`].filter(Boolean).join('  ')}`
    : '';
  paneEl.info.textContent = `${pane.plane.toUpperCase()}${projLabel}  ${index + 1} / ${def.count(volume)}\nZoom: ${(pane.scale * 10).toFixed(0)}%${tiltLabel}`;
  pane._transform = { dx, dy, scale: pane.scale, spacingX, spacingY, width, height, data };
}

// ---------- Live HU (Hounsfield unit) readout under the cursor ----------
// Real PACS/reading workstations show the density value at the crosshair as you
// move over the image — a genuinely useful reading aid, not decoration. Reads
// straight out of the already-rendered slice data, so it costs nothing extra.
function paneHuAt(key, clientX, clientY) {
  const pane = state.panes[key];
  const t = pane && pane._transform;
  if (!t) return null;
  const rect = el.panes[key].canvas.getBoundingClientRect();
  const sx = clientX - rect.left, sy = clientY - rect.top;
  const px = Math.floor((sx - t.dx) / (t.spacingX * t.scale));
  const py = Math.floor((sy - t.dy) / (t.spacingY * t.scale));
  if (px < 0 || py < 0 || px >= t.width || py >= t.height) return null;
  return t.data[py * t.width + px];
}

function renderAllPanes() {
  Object.keys(state.panes).forEach(renderMprPane);
  updateScrubber(); // keep the scrub bar in sync with wheel/cursor changes
}

// ---------- MPR interaction ----------

function handlePaneClick(key, e) {
  const pane = state.panes[key];
  const t = pane._transform;
  if (!t) return;
  const rect = el.panes[key].canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  let px = (sx - t.dx) / (t.spacingX * t.scale);
  let py = (sy - t.dy) / (t.spacingY * t.scale);
  px = clampInt(px, 0, t.width - 1);
  py = clampInt(py, 0, t.height - 1);
  Object.assign(state.cursor, planePxToCursor(pane.plane, px, py, state.volume));
  renderAllPanes();
}

// A single shared drag state (rather than one window-level listener set per pane)
// means panes can be freely rebuilt when the grid size changes without leaking listeners.
let paneDrag = null;

window.addEventListener('mousemove', (e) => {
  if (!paneDrag) return;
  const pane = state.panes[paneDrag.key];
  if (!pane) { paneDrag = null; return; }
  const dx = e.clientX - paneDrag.startX, dy = e.clientY - paneDrag.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) paneDrag.moved = true;

  if (paneDrag.mode === 'wl-or-click') {
    if (!paneDrag.moved) return;
    state.mprWw = Math.max(1, paneDrag.startWw + dx * 2);
    state.mprWc = paneDrag.startWc + dy * 2;
    renderAllPanes();
  } else if (paneDrag.mode === 'pan') {
    pane.panX = paneDrag.startPanX + dx;
    pane.panY = paneDrag.startPanY + dy;
    renderMprPane(paneDrag.key);
  } else if (paneDrag.mode === 'zoom') {
    const factor = Math.exp(-dy * 0.01);
    pane.scale = Math.max(0.02, Math.min(50, pane.scale * factor));
    paneDrag.startX = e.clientX;
    paneDrag.startY = e.clientY;
    renderMprPane(paneDrag.key);
  } else if (paneDrag.mode === 'rotate') {
    // Alt-drag: straighten the anatomy — rotates all three cut planes about this
    // pane's normal. 4px of drag per 1° keeps it easy to fine-tune.
    if (!state.mprTilt) state.mprTilt = { rx: 0, ry: 0, rz: 0 };
    const angle = paneDrag.startTilt + dx * 0.25;
    state.mprTilt[paneDrag.tiltAxis] = Math.max(-45, Math.min(45, Math.round(angle * 10) / 10));
    renderAllPanes();
  }
});

window.addEventListener('mouseup', (e) => {
  if (!paneDrag) return;
  if (paneDrag.mode === 'wl-or-click' && !paneDrag.moved) handlePaneClick(paneDrag.key, e);
  paneDrag = null;
});

function attachPaneHandlers(key, canvas, select, wrap) {
  canvas.title = 'Double-click (or F) to maximize · A / S / C switch plane, O turns it off · Alt-drag to straighten a tilted scan';

  canvas.addEventListener('mousedown', (e) => {
    state.activePane = key; // focus this pane for the plane hotkeys
    if (!state.volume || state.panes[key].plane === 'off') return;
    const tiltAxis = { axial: 'rz', sagittal: 'rx', coronal: 'ry' }[state.panes[key].plane];
    paneDrag = {
      key,
      mode: e.altKey && e.button === 0 ? 'rotate'
        : e.button === 0 ? 'wl-or-click' : e.button === 1 ? 'pan' : e.button === 2 ? 'zoom' : null,
      startX: e.clientX, startY: e.clientY,
      startPanX: state.panes[key].panX, startPanY: state.panes[key].panY,
      startWc: state.mprWc, startWw: state.mprWw,
      tiltAxis,
      startTilt: state.mprTilt ? state.mprTilt[tiltAxis] : 0,
      moved: false,
    };
    e.preventDefault();
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.volume) return;
    const pane = state.panes[key];
    if (pane.plane === 'off') return;
    const dir = e.deltaY > 0 ? 1 : -1;
    planeStepCursor(pane.plane, state.cursor, dir, state.volume);
    renderAllPanes();
  }, { passive: false });

  // Double-click blows this pane up to fill the grid (and back again). Maximizing
  // resets the zoom too, which is what the old double-click-to-refit did.
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    state.activePane = key;
    toggleMaximizePane(key);
  });

  canvas.addEventListener('mousemove', (e) => {
    const hu = el.panes[key].hu;
    if (paneDrag && paneDrag.key === key && paneDrag.moved) { hu.classList.add('hidden'); return; }
    const v = paneHuAt(key, e.clientX, e.clientY);
    if (v == null) { hu.classList.add('hidden'); return; }
    const rect = canvas.getBoundingClientRect();
    hu.textContent = `${Math.round(v)} HU`;
    hu.style.left = `${e.clientX - rect.left + 14}px`;
    hu.style.top = `${e.clientY - rect.top + 14}px`;
    hu.classList.remove('hidden');
  });
  canvas.addEventListener('mouseleave', () => el.panes[key].hu.classList.add('hidden'));

  select.addEventListener('change', (e) => {
    state.activePane = key;
    setPanePlane(key, e.target.value);
  });
}

function attachProjHandlers(key, projToggle, projSelect, projInput, wrap) {
  const updateVisibility = () => {
    wrap.classList.toggle('projActive', projSelect.value !== 'slice');
  };
  projToggle.addEventListener('click', () => {
    wrap.classList.toggle('projPanelOpen');
  });
  projSelect.addEventListener('change', () => {
    state.panes[key].projMode = projSelect.value;
    updateVisibility();
    renderMprPane(key);
  });
  projInput.addEventListener('change', () => {
    state.panes[key].projRange = Math.max(0, parseInt(projInput.value, 10) || 0);
    renderMprPane(key);
  });
  updateVisibility();
}

// ---------- Pane maximize + plane hotkeys ----------

// Blow one pane up to fill the whole grid (double-click), or restore the grid.
function toggleMaximizePane(key) {
  const willMaximize = state.maximizedPane !== key;
  state.maximizedPane = willMaximize ? key : null;

  el.mprGrid.classList.toggle('hasMaximized', willMaximize);
  Object.keys(el.panes).forEach(k => {
    el.panes[k].wrap.classList.toggle('maximized', willMaximize && k === key);
  });

  // The visible pane just changed size — resize its canvas and let every pane
  // recompute its fit-to-window zoom.
  fitPaneCanvases();
  Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
  renderAllPanes();
}

// Shared by the dropdown and the hotkeys so both behave identically.
function setPanePlane(key, plane) {
  const paneEl = el.panes[key];
  const pane = state.panes[key];
  if (!paneEl || !pane) return;
  pane.plane = plane;
  pane.scale = null; // the new plane has different dimensions — refit
  paneEl.select.value = plane; // keep the dropdown in sync when set via hotkey
  paneEl.wrap.classList.toggle('off', plane === 'off');
  renderMprPane(key);
}

// A/S/C switch the focused pane's plane (O turns it off) — much faster than the
// dropdown, especially on a maximized 1x1 pane.
const PLANE_HOTKEYS = { a: 'axial', s: 'sagittal', c: 'coronal', o: 'off' };

function hotkeyTargetPane() {
  if (state.maximizedPane && el.panes[state.maximizedPane]) return state.maximizedPane;
  if (state.activePane && el.panes[state.activePane]) return state.activePane;
  const keys = Object.keys(el.panes);
  return keys.length ? keys[0] : null;
}

document.addEventListener('keydown', (e) => {
  if (state.view !== 'viewer' || state.layout !== 'mpr') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Block only real text entry — NOT <select>. A focused dropdown (from using the
  // plane/preset/grid menus) must not disable the plane hotkeys, which are the
  // primary way the panes are driven.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (document.querySelector('.modal:not(.hidden)')) return;

  const key = e.key.toLowerCase();
  const isHotkey = key === 'f' || Object.prototype.hasOwnProperty.call(PLANE_HOTKEYS, key);
  if (!isHotkey) return;

  const target = hotkeyTargetPane();
  if (!target) return;
  e.preventDefault();
  // If a dropdown had focus, drop it so the key isn't also consumed as the select's
  // native type-ahead (e.g. "s" jumping to "Soft Tissue").
  if (document.activeElement && document.activeElement.tagName === 'SELECT') document.activeElement.blur();

  if (key === 'f') { toggleMaximizePane(target); return; }
  state.activePane = target;
  setPanePlane(target, PLANE_HOTKEYS[key]);
});

// Rebuilds the grid's pane DOM/state for the given rows x cols. Old pane canvases
// are dropped from the DOM (and eligible for GC along with their listeners) rather
// than reused, so switching grid sizes repeatedly never accumulates dead panes.
const GRID_DEFAULT_PLANES = ['axial', 'sagittal', 'coronal'];
const PROJ_MODES = [
  { value: 'slice', label: 'Thin' },
  { value: 'mip', label: 'MIP' },
  { value: 'minip', label: 'MinIP' },
  { value: 'average', label: 'Avg' },
];

function buildGridPanes(rows, cols) {
  el.mprGrid.innerHTML = '';
  // Panes are recreated, so any maximized/focused pane reference is now stale.
  state.maximizedPane = null;
  state.activePane = null;
  el.mprGrid.classList.remove('hasMaximized');
  el.mprGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  el.mprGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  el.panes = {};
  state.panes = {};

  const count = rows * cols;
  for (let i = 0; i < count; i++) {
    const key = `p${i}`;
    const defaultPlane = GRID_DEFAULT_PLANES[i] || 'off';

    const wrap = document.createElement('div');
    wrap.className = 'mprPane';
    wrap.dataset.pane = key;
    if (defaultPlane === 'off') wrap.classList.add('off');

    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);

    const controls = document.createElement('div');
    controls.className = 'paneControls';

    const topRow = document.createElement('div');
    topRow.className = 'paneTopRow';

    const select = document.createElement('select');
    select.className = 'paneSelect';
    ['axial', 'sagittal', 'coronal', 'off'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      if (v === defaultPlane) opt.selected = true;
      select.appendChild(opt);
    });
    topRow.appendChild(select);

    // Projection view (MIP/MinIP/Average) is opt-in and stays out of the way until
    // asked for — panes look exactly like plain slice views by default.
    const projToggle = document.createElement('button');
    projToggle.className = 'paneProjToggle';
    projToggle.title = 'Projection view (MIP / MinIP / Average)';
    projToggle.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l6-4 6 4-6 4z"/><path d="M2 10l6 4 6-4"/></svg>';
    topRow.appendChild(projToggle);

    controls.appendChild(topRow);

    const projRow = document.createElement('div');
    projRow.className = 'paneProjRow';

    const projSelect = document.createElement('select');
    projSelect.className = 'paneSelect paneProjSelect';
    projSelect.title = 'Projection mode';
    PROJ_MODES.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      projSelect.appendChild(opt);
    });
    projRow.appendChild(projSelect);

    const projInput = document.createElement('input');
    projInput.type = 'number';
    projInput.className = 'paneProjInput';
    projInput.min = '0';
    projInput.value = '0';
    projInput.title = 'Slab half-thickness, in source slices each side of the current position (0 = thin slice). Enter a large number for a full-volume projection.';
    projRow.appendChild(projInput);

    controls.appendChild(projRow);
    wrap.appendChild(controls);

    const info = document.createElement('div');
    info.className = 'paneInfo';
    wrap.appendChild(info);

    const hu = document.createElement('div');
    hu.className = 'huReadout hidden';
    wrap.appendChild(hu);

    el.mprGrid.appendChild(wrap);

    el.panes[key] = { wrap, canvas, ctx: canvas.getContext('2d'), select, projToggle, projSelect, projInput, info, hu };
    state.panes[key] = { plane: defaultPlane, scale: null, panX: 0, panY: 0, projMode: 'slice', projRange: 0 };

    attachPaneHandlers(key, canvas, select, wrap);
    attachProjHandlers(key, projToggle, projSelect, projInput, wrap);
  }

  fitPaneCanvases();
  if (state.layout === 'mpr') renderAllPanes();
}

// ---------- Layout switching ----------

function setLayout(mode) {
  state.layout = mode;
  el.btnLayoutStack.classList.toggle('active', mode === 'stack');
  el.btnLayoutGrid.classList.toggle('active', mode === 'mpr');
  el.stackView.classList.toggle('hidden', mode !== 'stack');
  el.mprGrid.classList.toggle('hidden', mode !== 'mpr');
  updateScrubber();
  if (mode === 'mpr') {
    fitPaneCanvases();
    Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
    renderAllPanes();
  } else {
    fitCanvas();
    render();
  }
}

// ---------- 3D volume view (hand off to the OHIF viewer on the same Orthanc) ----------
// Hounsfield does 2D + MPR; true GPU volume rendering is handled by the OHIF viewer
// that Orthanc already serves. We open the current study there by StudyInstanceUID.
// Requires the study to be in the archive (loaded via PACS or auto-imported).
function open3DView() {
  const entry = state.entries[state.currentIndex];
  const studyUid = entry && entry.dataSet ? entry.dataSet.string('x0020000d') : null;
  if (!studyUid) { setStatus('Load a study first to open it in 3D.', 'warn'); return; }
  // The Orthanc that serves OHIF is the one behind the PACS connection (fall back to
  // this app's own origin, which in production is that same Orthanc).
  const base = (state.pacs.qidoUrl || '').replace(/\/dicom-web\/?$/, '').replace(/\/+$/, '')
    || window.location.origin;
  const url = `${base}/ohif/viewer?StudyInstanceUIDs=${encodeURIComponent(studyUid)}`;
  window.open(url, '_blank', 'noopener');
  setStatus('Opening 3D view in a new tab (study must be in the archive).', 'ok');
}
document.getElementById('btn3D').addEventListener('click', open3DView);

el.btnLayoutStack.addEventListener('click', () => setLayout('stack'));
// Stack view lives in the Tools menu now — the toolbar button is hidden.
document.getElementById('btnMenuStack').addEventListener('click', () => setLayout('stack'));
el.btnLayoutGrid.addEventListener('click', () => { if (state.volume) setLayout('mpr'); });
el.gridSizeSelect.addEventListener('change', () => {
  const [rows, cols] = el.gridSizeSelect.value.split('x').map(Number);
  buildGridPanes(rows, cols);
  if (state.volume) setLayout('mpr');
});

// ---------- Toolbar ----------

el.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
el.dirInput.addEventListener('change', (e) => handleFiles(e.target.files));

el.btnReset.addEventListener('click', () => {
  if (state.layout === 'stack') {
    resetViewport();
    render();
  } else if (state.volume) {
    state.cursor = {
      x: Math.floor(state.volume.cols / 2),
      y: Math.floor(state.volume.rows / 2),
      z: Math.floor(state.volume.slices / 2),
    };
    state.mprTilt = { rx: 0, ry: 0, rz: 0 }; // clear any tilt correction too
    Object.keys(state.panes).forEach(k => {
      state.panes[k].scale = null;
      state.panes[k].panX = 0;
      state.panes[k].panY = 0;
    });
    renderAllPanes();
  }
});

el.btnInvert.addEventListener('click', () => {
  state.invert = !state.invert;
  if (state.layout === 'stack') render(); else renderAllPanes();
});

el.presetSelect.addEventListener('change', () => {
  const key = el.presetSelect.value;
  if (state.layout === 'stack') {
    const entry = state.entries[state.currentIndex];
    if (!entry) return;
    if (key && PRESETS[key]) {
      entry.wc = PRESETS[key].center;
      entry.ww = PRESETS[key].width;
    } else {
      entry.wc = entry.image.windowCenter;
      entry.ww = entry.image.windowWidth;
    }
    render();
  } else if (state.volume) {
    if (key && PRESETS[key]) {
      state.mprWc = PRESETS[key].center;
      state.mprWw = PRESETS[key].width;
    } else {
      state.mprWc = state.volume.defaultWc;
      state.mprWw = state.volume.defaultWw;
    }
    renderAllPanes();
  }
});

// ---------- Drag & drop (files and folders) ----------

['dragenter', 'dragover'].forEach(evt => {
  el.wrap.addEventListener(evt, (e) => {
    e.preventDefault();
    el.wrap.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  el.wrap.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragleave' && e.target !== el.wrap) return;
    el.wrap.classList.remove('dragover');
  });
});

el.wrap.addEventListener('drop', async (e) => {
  const items = e.dataTransfer.items;
  const files = [];
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = Array.from(items).map(it => it.webkitGetAsEntry());
    await Promise.all(entries.map(ent => walkEntry(ent, files)));
  } else {
    files.push(...Array.from(e.dataTransfer.files));
  }
  handleFiles(files);
});

function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(f => { out.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (children) => {
          if (!children.length) return resolve();
          await Promise.all(children.map(c => walkEntry(c, out)));
          readBatch();
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

// ---------- Lund-Mackay scoring ----------

const LM_REGIONS = [
  { key: 'maxillary', label: 'Maxillary' },
  { key: 'anteriorEthmoid', label: 'Anterior Ethmoid' },
  { key: 'posteriorEthmoid', label: 'Posterior Ethmoid' },
  { key: 'sphenoid', label: 'Sphenoid' },
  { key: 'frontal', label: 'Frontal' },
];
const LM_ROWS = [...LM_REGIONS, { key: 'omc', label: 'Ostiomeatal Complex' }];

function makeLmCell() { return { value: 0, source: 'manual', confirmed: true }; }

state.lm = { scores: {}, apiKey: localStorage.getItem('lm_api_key') || '' };
LM_ROWS.forEach(r => { state.lm.scores[r.key] = { left: makeLmCell(), right: makeLmCell() }; });

el.lm = {
  modal: document.getElementById('lmModal'),
  tableBody: document.querySelector('#lmTable tbody'),
  leftTotal: document.getElementById('lmLeftTotal'),
  rightTotal: document.getElementById('lmRightTotal'),
  grandTotal: document.getElementById('lmGrandTotal'),
  status: document.getElementById('lmStatus'),
  apiKeyBox: document.getElementById('lmApiKeyBox'),
  apiKeyInput: document.getElementById('lmApiKeyInput'),
  reportOutput: document.getElementById('lmReportOutput'),
  patientContext: document.getElementById('lmPatientContext'),
};

// Which stored patient (if any) is currently loaded — shown in the AI/report modals so
// it's never ambiguous which patient's images a score or note actually came from.
function activePatientLabel() {
  if (!state.activePatientKey) return null;
  const cached = (state.patientListCache || []).find(p => p.key === state.activePatientKey);
  return cached ? cached.name : state.activePatientKey;
}

function updatePatientContextBar(el_) {
  const name = activePatientLabel();
  if (name) {
    el_.classList.remove('noPatient');
    el_.textContent = `Analyzing: ${name}`;
  } else {
    el_.classList.add('noPatient');
    el_.textContent = 'No patient selected — load a patient from the library first.';
  }
}

// Scores, report text, and any AI note are tied to whichever patient's images produced
// them — carrying them over to the next patient loaded in the viewer would silently
// misattribute one patient's findings to another, so both reset on every patient switch.
function resetLmTab() {
  LM_ROWS.forEach(r => { state.lm.scores[r.key] = { left: makeLmCell(), right: makeLmCell() }; });
  if (el.lm) {
    buildLmTable();
    el.lm.reportOutput.value = '';
    el.lm.status.textContent = '';
  }
}

function resetAiNote() {
  if (!el.aiNote) return;
  el.aiNote.card.classList.add('hidden');
  el.aiNote.list.innerHTML = '';
  el.aiNote.impression.textContent = '';
  el.aiNote.status.textContent = '';
}

function resetAiAnalysisState() {
  resetLmTab();
  resetAiNote();
}

function buildLmTable() {
  el.lm.tableBody.innerHTML = '';
  LM_ROWS.forEach(r => {
    const tr = document.createElement('tr');
    const options = r.key === 'omc' ? [0, 2] : [0, 1, 2];
    const cellHtml = (side) => {
      const cell = state.lm.scores[r.key][side];
      const opts = options.map(v => `<option value="${v}"${v === cell.value ? ' selected' : ''}>${v}</option>`).join('');
      const pending = cell.source === 'ai' && !cell.confirmed;
      return `<td><select data-region="${r.key}" data-side="${side}" class="lmSelect${pending ? ' ai-pending' : ''}">${opts}</select>${pending ? '<span class="lmAiBadge" title="AI-suggested, unconfirmed">AI</span>' : ''}</td>`;
    };
    tr.innerHTML = `<td>${r.label}</td>${cellHtml('left')}${cellHtml('right')}`;
    el.lm.tableBody.appendChild(tr);
  });

  el.lm.tableBody.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const region = e.target.dataset.region;
      const side = e.target.dataset.side;
      state.lm.scores[region][side] = { value: parseInt(e.target.value, 10), source: 'manual', confirmed: true };
      buildLmTable();
    });
  });

  updateLmTotals();
}

function updateLmTotals() {
  let left = 0, right = 0;
  LM_ROWS.forEach(r => {
    left += state.lm.scores[r.key].left.value;
    right += state.lm.scores[r.key].right.value;
  });
  el.lm.leftTotal.textContent = left;
  el.lm.rightTotal.textContent = right;
  el.lm.grandTotal.textContent = left + right;
}

// ---------- AI-assisted suggestions (experimental, requires review) ----------

function lmPairSchema(binary) {
  const enumVals = binary ? [0, 2] : [0, 1, 2];
  return {
    type: 'object',
    properties: {
      left: { type: 'integer', enum: enumVals },
      right: { type: 'integer', enum: enumVals },
    },
    required: ['left', 'right'],
    additionalProperties: false,
  };
}

const LM_SCHEMA = {
  type: 'object',
  properties: {
    maxillary: lmPairSchema(false),
    anteriorEthmoid: lmPairSchema(false),
    posteriorEthmoid: lmPairSchema(false),
    sphenoid: lmPairSchema(false),
    frontal: lmPairSchema(false),
    omc: lmPairSchema(true),
    notes: { type: 'string' },
  },
  required: ['maxillary', 'anteriorEthmoid', 'posteriorEthmoid', 'sphenoid', 'frontal', 'omc', 'notes'],
  additionalProperties: false,
};

// Fixed soft-tissue window for AI analysis, independent of whatever the user
// happens to have on screen — a bone/default window washes out exactly the
// mucosal thickening / fluid opacification this tool needs to see. (Same
// values as the "Soft Tissue" preset: WC 40, WW 400.)
const LM_AI_WC = 40;
const LM_AI_WW = 400;

// Returns [{ label, b64 }] — each image gets a text label (plane + index) sent right
// before it, so the model can cross-reference planes instead of reading images blind.
function captureLmImages() {
  const images = [];
  if (state.volume) {
    const v = state.volume;
    // Sample coronal slices across most of the volume's anterior-posterior
    // extent, not a narrow window around whatever the 3D cursor happens to be
    // sitting on (which defaults to dead center of the whole scan and may be
    // nowhere near the sinuses). Frontal-to-sphenoid sinus anatomy can span a
    // wide AP range, so under-sampling risks missing regions entirely.
    const yLo = Math.round(v.rows * 0.12);
    const yHi = Math.round(v.rows * 0.88);
    const coronalSteps = 11;
    const seenY = new Set();
    for (let i = 0; i < coronalSteps; i++) {
      const y = clampInt(yLo + Math.round((yHi - yLo) * (i / (coronalSteps - 1))), 0, v.rows - 1);
      if (seenY.has(y)) continue;
      seenY.add(y);
      const { data, width, height } = sliceVolume(v, 'coronal', y);
      // invert=false: always send standard-polarity images (air dark, bone/
      // tissue bright) — an inverted display is non-standard and can confuse
      // a vision model's read of tissue density.
      const canvas = windowToOffscreen(width, height, data, LM_AI_WC, LM_AI_WW, false, v.monochrome1);
      images.push({ label: `Coronal image ${images.length + 1}, anterior-to-posterior order`, b64: canvas.toDataURL('image/png').split(',')[1] });
    }

    // Axial slices too — sinus disease that's subtle in one plane is often obvious in
    // the other, which is why radiologists read both rather than coronal alone.
    const zLo = Math.round(v.slices * 0.1);
    const zHi = Math.round(v.slices * 0.9);
    const axialSteps = Math.min(9, v.slices);
    const seenZ = new Set();
    for (let i = 0; i < axialSteps; i++) {
      const z = clampInt(zLo + Math.round((zHi - zLo) * (i / (axialSteps - 1))), 0, v.slices - 1);
      if (seenZ.has(z)) continue;
      seenZ.add(z);
      const { data, width, height } = sliceVolume(v, 'axial', z);
      const canvas = windowToOffscreen(width, height, data, LM_AI_WC, LM_AI_WW, false, v.monochrome1);
      images.push({ label: `Axial image ${images.length - coronalSteps + 1}, superior-to-inferior order`, b64: canvas.toDataURL('image/png').split(',')[1] });
    }
  } else {
    const entry = state.entries[state.currentIndex];
    if (entry && entry.image) {
      const canvas = renderToOffscreen(entry.image, LM_AI_WC, LM_AI_WW);
      images.push({ label: 'Single loaded image', b64: canvas.toDataURL('image/png').split(',')[1] });
    }
  }
  return images;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Shared caller for both AI features. Retries on Anthropic capacity errors (HTTP 429/529,
// or error.type "overloaded_error") with a short backoff before giving up, since those are
// transient — the model is momentarily out of capacity, not the request being wrong.
async function callClaudeVision(apiKey, images, prompt, schema) {
  const content = [];
  images.forEach(img => {
    content.push({ type: 'text', text: img.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.b64 } });
  });
  content.push({ type: 'text', text: prompt });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content }],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const textBlock = data.content.find(b => b.type === 'text');
      return JSON.parse(textBlock.text);
    }

    const errBody = await res.json().catch(() => ({}));
    const errType = errBody && errBody.error && errBody.error.type;
    const overloaded = res.status === 429 || res.status === 529 || errType === 'overloaded_error';
    if (overloaded && attempt < maxAttempts) { await sleep(1200 * attempt); continue; }

    if (overloaded) throw new Error("Anthropic's servers are overloaded right now — please try again in a minute.");
    throw new Error((errBody && errBody.error && errBody.error.message) || `HTTP ${res.status}`);
  }
}

// Stated bluntly and up front because "gray = disease" is the one rule most likely to
// get silently overridden by a generic prior (e.g. assuming a normal scan is the default).
const LM_GREYSCALE_RULE =
  'These images are windowed for soft tissue. Greyscale convention, read literally: BLACK = air (a normal, ' +
  'empty, aerated sinus). ANY shade of GRAY filling a sinus cavity = disease — mucosal thickening, soft ' +
  'tissue, or fluid — the more completely a cavity is filled with gray instead of black, the more severe the ' +
  'opacification. WHITE/bright = bone. Do not default to calling a sinus "clear" — actively look inside each ' +
  'sinus cavity, in every image it appears in, for ANY non-black (gray) filling before concluding it is ' +
  'aerated. A cavity that is partly or mostly gray is NOT clear, even if some black air is still visible. ';

async function runLmAiSuggest() {
  if (!state.activePatientKey) {
    el.lm.status.textContent = 'No patient selected — load a patient from the library first.';
    return;
  }
  if (!state.lm.apiKey) {
    el.lm.status.textContent = 'Set an API key first.';
    el.lm.apiKeyBox.classList.remove('hidden');
    return;
  }
  const images = captureLmImages();
  if (!images.length) {
    el.lm.status.textContent = 'No image loaded to analyze. Load a series first.';
    return;
  }

  el.lm.status.textContent = `Contacting AI for ${activePatientLabel()} (draft suggestion only, requires your review)...`;

  const prompt = LM_GREYSCALE_RULE +
    'You are assisting a radiologist by drafting a Lund-Mackay CT paranasal sinus score from the attached ' +
    'CT images (coronal images first, then axial). This is a DRAFT ONLY — a qualified clinician must review ' +
    'and confirm every value before it is used. Examine ALL images individually, in both planes, before ' +
    'scoring each region — a region that looks equivocal in one plane is often obvious in the other, and ' +
    'different sinuses are best seen at different image indices. For each sinus region, score 0 (no ' +
    'opacification — normal aerated sinus, uniformly black with no gray filling anywhere in the cavity), 1 ' +
    '(partial opacification/mucosal thickening — gray filling part of the cavity, air still visible), or 2 ' +
    '(total opacification — the cavity is filled with gray soft-tissue/fluid density and shows no residual ' +
    'black air), separately for the left and right side. The ostiomeatal complex (omc) is scored only 0 (not ' +
    'obstructed) or 2 (obstructed) — never 1. Base your assessment only on what is visible in the provided ' +
    'images. If a region is not clearly visible in any image, make your best estimate and say so explicitly ' +
    'in the notes field, naming which region(s) were hard to assess and why.';

  try {
    const parsed = await callClaudeVision(state.lm.apiKey, images, prompt, LM_SCHEMA);

    LM_ROWS.forEach(r => {
      const src = parsed[r.key];
      if (!src) return;
      state.lm.scores[r.key].left = { value: src.left, source: 'ai', confirmed: false };
      state.lm.scores[r.key].right = { value: src.right, source: 'ai', confirmed: false };
    });

    buildLmTable();
    el.lm.status.textContent = 'AI suggestions added (highlighted) — review and confirm each one before generating the report.' +
      (parsed.notes ? ` AI notes: ${parsed.notes}` : '');
  } catch (err) {
    el.lm.status.textContent = `AI suggest failed: ${errMsg(err)}`;
  }
}

// ---------- AI Note (standalone "clip note" quick read — separate from the Lund-Mackay tab) ----------

const LM_READ_LEVELS = ['clear', 'mild thickening', 'moderate opacification', 'severe opacification'];

function lmReadPairSchema(levels) {
  return {
    type: 'object',
    properties: {
      left: { type: 'string', enum: levels },
      right: { type: 'string', enum: levels },
    },
    required: ['left', 'right'],
    additionalProperties: false,
  };
}

const LM_READ_SCHEMA = {
  type: 'object',
  properties: {
    maxillary: lmReadPairSchema(LM_READ_LEVELS),
    anteriorEthmoid: lmReadPairSchema(LM_READ_LEVELS),
    posteriorEthmoid: lmReadPairSchema(LM_READ_LEVELS),
    sphenoid: lmReadPairSchema(LM_READ_LEVELS),
    frontal: lmReadPairSchema(LM_READ_LEVELS),
    omc: lmReadPairSchema(['clear', 'obstructed']),
    impression: { type: 'string' },
  },
  required: ['maxillary', 'anteriorEthmoid', 'posteriorEthmoid', 'sphenoid', 'frontal', 'omc', 'impression'],
  additionalProperties: false,
};

function lmReadLevelClass(level) {
  if (level === 'clear') return 'lmReadLevel-clear';
  if (level === 'mild thickening') return 'lmReadLevel-mild';
  if (level === 'moderate opacification') return 'lmReadLevel-moderate';
  if (level === 'severe opacification' || level === 'obstructed') return 'lmReadLevel-severe';
  return 'lmReadLevel-mild';
}

async function runAiNote() {
  if (!state.activePatientKey) {
    el.aiNote.status.textContent = 'No patient selected — load a patient from the library first.';
    return;
  }
  if (!state.lm.apiKey) {
    el.aiNote.status.textContent = 'Set an API key first.';
    el.aiNote.apiKeyBox.classList.remove('hidden');
    return;
  }
  const images = captureLmImages();
  if (!images.length) {
    el.aiNote.status.textContent = 'No image loaded to analyze. Load a series first.';
    return;
  }

  el.aiNote.status.textContent = `Contacting AI for ${activePatientLabel()} (draft only, requires your review)...`;

  const prompt = LM_GREYSCALE_RULE +
    'You are assisting a radiologist by drafting a plain-language, descriptive read of the attached CT ' +
    'images of the paranasal sinuses (coronal images first, then axial). This is a DRAFT ONLY — a qualified ' +
    'clinician must review and confirm every value before it is used. Examine ALL images individually, in ' +
    'both planes, before describing each region — a region that looks equivocal in one plane is often ' +
    'obvious in the other, and different sinuses are best seen at different image indices. For each sinus ' +
    'region, describe it as one of: "clear" (normal aerated sinus, uniformly black, no gray filling anywhere ' +
    'in the cavity), "mild thickening" (a thin rim of gray mucosal thickening, mostly still black/aerated), ' +
    '"moderate opacification" (a substantial portion of the cavity filled with gray soft-tissue/fluid ' +
    'density, but not complete), or "severe opacification" (the cavity is nearly or completely filled with ' +
    'gray soft-tissue/fluid density, little or no residual black air) — separately for the left and right ' +
    'side. The ostiomeatal complex (omc) is described only as "clear" or "obstructed". Then write a 2-4 ' +
    'sentence plain-language impression summarizing the overall pattern of disease across all regions. Base ' +
    'your assessment only on what is visible in the provided images.';

  try {
    const parsed = await callClaudeVision(state.lm.apiKey, images, prompt, LM_READ_SCHEMA);

    el.aiNote.list.innerHTML = '';
    LM_ROWS.forEach(r => {
      const src = parsed[r.key];
      if (!src) return;
      ['left', 'right'].forEach(side => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="lmReadRegion">${r.label} (${side === 'left' ? 'L' : 'R'})</span>` +
          `<span class="lmReadLevel ${lmReadLevelClass(src[side])}">${escapeHtml(src[side])}</span>`;
        el.aiNote.list.appendChild(li);
      });
    });
    el.aiNote.impression.textContent = parsed.impression || '';
    el.aiNote.card.classList.remove('hidden');

    el.aiNote.status.textContent = 'Draft note below — review before relying on it.';
  } catch (err) {
    el.aiNote.status.textContent = `AI note failed: ${errMsg(err)}`;
  }
}

// ---------- Report template (modeled on the Excel ENT sinus CT report) ----------
// Static letterhead / boilerplate. Edit these to match your practice.
const REPORT_PRACTICE = {
  name: 'EXCEL ENT OF ALABAMA',
  addr1: '2161 VALLEYDALE ROAD, BIRMINGHAM, AL 35244',
  addr2: '509 BROOKWOOD BLVD., STE. 100, BIRMINGHAM, AL 35209',
  title: 'CT Paranasal Sinuses (Sinus CT) Report',
  physician: 'J. Christopher Davis, M.D., FACS',
};
const REPORT_TECHNIQUE =
  'Non-contrast axial CT images of the paranasal sinuses were obtained, with coronal and sagittal ' +
  'reconstructions. The study was performed using a stereotactic localization protocol compatible with ' +
  'Medtronic ENT image-guided navigation systems (CT Guidance Stereotactic Localization / Medtronic ENT ' +
  'Navigational Protocol).';
const REPORT_ATTESTATION =
  'All CT images were personally reviewed and interpreted by the undersigned interpreting physician, in ' +
  'accordance with IAC standards. The findings and impressions in this report accurately reflect the ' +
  'interpretation of the complete image dataset.';

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function usDate(d) {
  if (!d || d.length !== 8) return d || '';
  return `${d.slice(4, 6)}/${d.slice(6, 8)}/${d.slice(0, 4)}`;
}
function lmSeverityWord(score) {
  return score >= 2 ? 'complete opacification' : score === 1 ? 'mild mucosal thickening' : 'clear';
}

// Draft a per-sinus finding sentence from left/right Lund-Mackay scores. These are
// STARTING TEXT the physician edits — they are derived mechanically from the score,
// not from an independent read of the image.
function lmPairedFinding(l, r) {
  if (l === 0 && r === 0) return 'Clear bilaterally.';
  if (l === r) return cap(lmSeverityWord(l)) + ' bilaterally.';
  if (l === 0 || r === 0) {
    const side = l > 0 ? 'left' : 'right';
    const other = side === 'left' ? 'right' : 'left';
    return `${cap(lmSeverityWord(Math.max(l, r)))} on the ${side}; the ${other} side is clear.`;
  }
  return `${cap(lmSeverityWord(r))} on the right, ${lmSeverityWord(l)} on the left.`;
}

function lmEthmoidFinding(ant, post) {
  const leftMax = Math.max(ant.left.value, post.left.value);
  const rightMax = Math.max(ant.right.value, post.right.value);
  if (leftMax === 0 && rightMax === 0) return 'Anterior and posterior ethmoid air cells are clear bilaterally.';
  const antInv = ant.left.value > 0 || ant.right.value > 0;
  const postInv = post.left.value > 0 || post.right.value > 0;
  const cells = (antInv && postInv) ? 'anterior and posterior ethmoid air cells'
    : antInv ? 'the anterior ethmoid air cells' : 'the posterior ethmoid air cells';
  const sev = lmSeverityWord(Math.max(leftMax, rightMax));
  if (leftMax > 0 && rightMax > 0) return `${cap(sev)} involving ${cells} bilaterally.`;
  const side = leftMax > 0 ? 'left' : 'right';
  const other = side === 'left' ? 'right' : 'left';
  return `${cap(sev)} involving ${cells} on the ${side}; the ${other} side is clear.`;
}

function lmOmcFinding(l, r) {
  if (l === 0 && r === 0) return 'Bilateral infundibula are patent.';
  if (l > 0 && r > 0) return 'Bilateral infundibular obstruction.';
  const side = l > 0 ? 'left' : 'right';
  const other = side === 'left' ? 'right' : 'left';
  return `The ${side} infundibulum is obstructed; the ${other} is patent.`;
}

function lmImpression(scores, L, R) {
  const total = L + R;
  if (total === 0) {
    return 'The paranasal sinuses are clear bilaterally with patent drainage pathways. No evidence of acute or chronic sinusitis.';
  }
  const maxScore = Math.max(...LM_ROWS.flatMap(r => [scores[r.key].left.value, scores[r.key].right.value]));
  const sev = maxScore >= 2 ? 'moderate to marked' : 'mild';
  const involved = [];
  [['maxillary', 'maxillary'], ['anteriorEthmoid', 'anterior ethmoid'], ['posteriorEthmoid', 'posterior ethmoid'],
   ['sphenoid', 'sphenoid'], ['frontal', 'frontal']].forEach(([k, label]) => {
    const l = scores[k].left.value, r = scores[k].right.value;
    if (l > 0 && r > 0) involved.push('bilateral ' + label);
    else if (l > 0) involved.push('left ' + label);
    else if (r > 0) involved.push('right ' + label);
  });
  if (scores.omc.left.value > 0 || scores.omc.right.value > 0) involved.push('ostiomeatal complex obstruction');
  const list = involved.length ? involved.join(', ') : 'the paranasal sinuses';
  return `Findings consistent with ${sev} inflammatory sinus disease involving ${list}. ` +
    `Total Lund-Mackay score ${total}/24 (left ${L}, right ${R}). Clinical correlation is recommended.`;
}

function generateLmReport() {
  const unconfirmed = [];
  LM_ROWS.forEach(r => {
    ['left', 'right'].forEach(side => {
      const cell = state.lm.scores[r.key][side];
      if (cell.source === 'ai' && !cell.confirmed) unconfirmed.push(`${r.label} (${side})`);
    });
  });
  if (unconfirmed.length) {
    el.lm.status.textContent = `Review the AI-suggested scores before generating the report: ${unconfirmed.join(', ')}.`;
    return;
  }

  const s = state.lm.scores;
  const entry = state.entries[state.currentIndex];
  const ds = entry ? entry.dataSet : null;
  const g = (tag) => ds ? (ds.string(tag) || '').trim() : '';
  const patientName = g('x00100010').replace(/\^/g, ' ').trim() || '________________';
  const dob = usDate(g('x00100030')) || '__________';
  const chart = g('x00100020') || '__________';
  const examDate = usDate(g('x00080020')) || '__________';
  const referring = g('x00080090').replace(/\^/g, ' ').trim() || '________________';
  const history = g('x001021b0') || g('x00081030') || '';

  let L = 0, R = 0;
  LM_ROWS.forEach(r => { L += s[r.key].left.value; R += s[r.key].right.value; });

  const scoreRow = (label, l, r) => `${label.padEnd(24)}${String(l).padStart(4)}${String(r).padStart(8)}`;

  const lines = [];
  lines.push('*** DRAFT — for interpreting physician review, editing, and signature ***');
  lines.push('');
  lines.push(REPORT_PRACTICE.name);
  lines.push(REPORT_PRACTICE.addr1);
  lines.push(REPORT_PRACTICE.addr2);
  lines.push('');
  lines.push(REPORT_PRACTICE.title);
  lines.push('');
  lines.push(`Patient Name: ${patientName}     Patient DOB: ${dob}     Patient Chart # ${chart}`);
  lines.push(`Date of Examination: ${examDate}`);
  lines.push(`Referring Physician: ${referring}`);
  lines.push(`Clinical History: ${history || '________________________________________'}`);
  lines.push('');
  lines.push('Technique');
  lines.push(REPORT_TECHNIQUE);
  lines.push('');
  lines.push('Findings');
  lines.push(`Maxillary Sinuses: ${lmPairedFinding(s.maxillary.left.value, s.maxillary.right.value)}`);
  lines.push(`Ethmoid Sinuses: ${lmEthmoidFinding(s.anteriorEthmoid, s.posteriorEthmoid)}`);
  lines.push(`Sphenoid Sinuses: ${lmPairedFinding(s.sphenoid.left.value, s.sphenoid.right.value)}`);
  lines.push(`Frontal Sinuses: ${lmPairedFinding(s.frontal.left.value, s.frontal.right.value)}`);
  lines.push(`Ostiomeatal Complex: ${lmOmcFinding(s.omc.left.value, s.omc.right.value)}`);
  lines.push('Nasal Septum: Midline.');
  lines.push('Additional Findings: No evidence of air-fluid levels, bony erosion, or sinonasal mass. Nasal airway remains adequate without obstruction.');
  lines.push('');
  lines.push('Lund-Mackay Scoring');
  lines.push(scoreRow('Sinus Region', 'Left', 'Right'));
  lines.push(scoreRow('Maxillary', s.maxillary.left.value, s.maxillary.right.value));
  lines.push(scoreRow('Anterior Ethmoid', s.anteriorEthmoid.left.value, s.anteriorEthmoid.right.value));
  lines.push(scoreRow('Posterior Ethmoid', s.posteriorEthmoid.left.value, s.posteriorEthmoid.right.value));
  lines.push(scoreRow('Sphenoid', s.sphenoid.left.value, s.sphenoid.right.value));
  lines.push(scoreRow('Frontal', s.frontal.left.value, s.frontal.right.value));
  lines.push(scoreRow('Ostiomeatal Complex', s.omc.left.value, s.omc.right.value));
  lines.push(scoreRow('Total Score (0-24)', L, R));
  lines.push('');
  lines.push('Impression');
  lines.push(lmImpression(s, L, R));
  lines.push('');
  lines.push(REPORT_ATTESTATION);
  lines.push('');
  lines.push(`Interpreting Physician: ${REPORT_PRACTICE.physician}`);
  lines.push('Electronic Signature: ______________________________');
  lines.push(`Date of Signature: ${usDate(new Date().toISOString().slice(0, 10).replace(/-/g, ''))}`);
  lines.push('');
  lines.push('------------------------------------------------------------');
  lines.push('DRAFT generated by DICOM Viewer. The Findings and Impression above are drafted');
  lines.push('mechanically from the entered Lund-Mackay scores (some of which may have originated');
  lines.push('as unvalidated AI suggestions) and are NOT an independent interpretation. The');
  lines.push('interpreting physician must review the images, edit this report as needed, and sign');
  lines.push('it before it is entered into the medical record or used for patient care.');

  el.lm.reportOutput.value = lines.join('\n');
  el.lm.status.textContent = 'Draft report generated — review, edit, and sign before use.';
}

// ---------- Lund-Mackay wiring ----------

document.getElementById('btnLundMackay').addEventListener('click', () => {
  buildLmTable();
  updatePatientContextBar(el.lm.patientContext);
  el.lm.modal.classList.remove('hidden');
});
document.getElementById('lmClose').addEventListener('click', () => el.lm.modal.classList.add('hidden'));
document.querySelector('#lmModal .modalBackdrop').addEventListener('click', () => el.lm.modal.classList.add('hidden'));

document.getElementById('lmApiKeyBtn').addEventListener('click', () => {
  el.lm.apiKeyInput.value = state.lm.apiKey;
  el.lm.apiKeyBox.classList.toggle('hidden');
});
document.getElementById('lmApiKeySave').addEventListener('click', () => {
  state.lm.apiKey = el.lm.apiKeyInput.value.trim();
  localStorage.setItem('lm_api_key', state.lm.apiKey);
  el.lm.apiKeyBox.classList.add('hidden');
  el.lm.status.textContent = 'API key saved.';
});

document.getElementById('lmAiSuggest').addEventListener('click', runLmAiSuggest);
document.getElementById('lmGenerate').addEventListener('click', generateLmReport);
document.getElementById('lmClear').addEventListener('click', () => {
  if (!window.confirm('Clear all Lund-Mackay scores and the draft report? This cannot be undone.')) return;
  resetLmTab();
  el.lm.status.textContent = 'Cleared.';
});
document.getElementById('lmCopyReport').addEventListener('click', () => {
  el.lm.reportOutput.select();
  if (navigator.clipboard) navigator.clipboard.writeText(el.lm.reportOutput.value);
  el.lm.status.textContent = 'Copied to clipboard.';
});
document.getElementById('lmDownloadReport').addEventListener('click', () => {
  const entry = state.entries[state.currentIndex];
  const nm = entry ? (entry.dataSet.string('x00100010') || '').replace(/[\^\s]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') : '';
  const blob = new Blob([el.lm.reportOutput.value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sinus_ct_report${nm ? '_' + nm : ''}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- AI Note wiring ----------

el.aiNote = {
  modal: document.getElementById('aiNoteModal'),
  status: document.getElementById('aiNoteStatus'),
  apiKeyBox: document.getElementById('aiNoteApiKeyBox'),
  apiKeyInput: document.getElementById('aiNoteApiKeyInput'),
  card: document.getElementById('aiNoteCard'),
  list: document.getElementById('aiNoteList'),
  impression: document.getElementById('aiNoteImpression'),
  patientContext: document.getElementById('aiNotePatientContext'),
};

document.getElementById('btnAiNote').addEventListener('click', () => {
  updatePatientContextBar(el.aiNote.patientContext);
  el.aiNote.modal.classList.remove('hidden');
});
document.getElementById('aiNoteClose').addEventListener('click', () => el.aiNote.modal.classList.add('hidden'));
document.querySelector('#aiNoteModal .modalBackdrop').addEventListener('click', () => el.aiNote.modal.classList.add('hidden'));

document.getElementById('aiNoteApiKeyBtn').addEventListener('click', () => {
  el.aiNote.apiKeyInput.value = state.lm.apiKey;
  el.aiNote.apiKeyBox.classList.toggle('hidden');
});
document.getElementById('aiNoteApiKeySave').addEventListener('click', () => {
  state.lm.apiKey = el.aiNote.apiKeyInput.value.trim();
  localStorage.setItem('lm_api_key', state.lm.apiKey);
  el.aiNote.apiKeyBox.classList.add('hidden');
  el.aiNote.status.textContent = 'API key saved.';
});

document.getElementById('aiNoteGenerate').addEventListener('click', runAiNote);
document.getElementById('aiNoteClear').addEventListener('click', () => {
  resetAiNote();
});

// ---------- Backup & Restore (move the whole local library to another computer) ----------
// Everything lives in this browser's IndexedDB only — there's no server and no sync. This
// packs every patient, DICOM file, and video into one portable file: a 4-byte little-endian
// length header, then a JSON manifest (patient/file/video metadata + byte offsets), then the
// raw binary payloads back-to-back. Avoiding base64/JSON for the binary data keeps large scans
// and videos fast to pack/unpack instead of ballooning ~33% and choking JSON.stringify/parse.

function idbGetAll(db, storeName) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const r = tx.objectStore(storeName).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbPutAll(db, storeName, records) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    records.forEach(r => store.put(r));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('storage transaction aborted (quota?)'));
  });
}

// Backups are AES-256-GCM encrypted with a key derived from the user's password
// (PBKDF2). Layout: magic "HFENC1" | 16-byte salt | 12-byte IV | ciphertext. The
// plaintext inside is the original [4-byte manifest length][manifest JSON][binaries].
const BACKUP_MAGIC = new Uint8Array([0x48, 0x46, 0x45, 0x4E, 0x43, 0x31]); // "HFENC1"

async function deriveBackupKey(password, salt, usage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, usage
  );
}

function hasBackupMagic(u8) {
  if (u8.length < 6) return false;
  for (let i = 0; i < 6; i++) if (u8[i] !== BACKUP_MAGIC[i]) return false;
  return true;
}

async function exportLibrary() {
  const password = el.backup.password.value;
  if (!password) { el.backup.status.textContent = 'Enter a backup password first — it encrypts the patient data in the file.'; return; }
  el.backup.status.textContent = 'Preparing encrypted export...';
  try {
    const db = await openLibraryDB();
    const [patients, files, videos] = await Promise.all([
      idbGetAll(db, 'patients'),
      idbGetAll(db, 'files'),
      idbGetAll(db, 'videos'),
    ]);

    const binaryParts = [];
    let offset = 0;

    const fileManifest = files.map(f => {
      const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const entry = {
        id: f.id, patientKey: f.patientKey, seriesUid: f.seriesUid, filename: f.filename,
        byteOffset: offset, byteLength: bytes.byteLength,
      };
      binaryParts.push(bytes);
      offset += bytes.byteLength;
      return entry;
    });

    const videoManifest = [];
    for (const v of videos) {
      const bytes = new Uint8Array(await v.blob.arrayBuffer());
      videoManifest.push({
        id: v.id, folder: v.folder, filename: v.filename, size: v.size, type: v.type,
        thumbnail: v.thumbnail, addedAt: v.addedAt, byteOffset: offset, byteLength: bytes.byteLength,
      });
      binaryParts.push(bytes);
      offset += bytes.byteLength;
    }

    const manifest = { version: 1, exportedAt: Date.now(), patients, files: fileManifest, videos: videoManifest };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, manifestBytes.byteLength, true);

    // Assemble the plaintext, then encrypt the whole thing.
    const plainBuf = await new Blob([header, manifestBytes, ...binaryParts]).arrayBuffer();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(password, salt, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBuf));

    const blob = new Blob([BACKUP_MAGIC, salt, iv, cipher], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hounsfield_backup_${new Date().toISOString().slice(0, 10)}.dvbackup`;
    a.click();
    URL.revokeObjectURL(a.href);

    el.backup.status.textContent =
      `Exported ${patients.length} patient(s), ${files.length} image(s), ${videos.length} video(s), encrypted. ` +
      'Keep the password safe — the file cannot be imported without it.';
  } catch (e) {
    el.backup.status.textContent = `Export failed: ${errMsg(e)}`;
  }
}

async function importLibraryFromFile(file) {
  el.backup.status.textContent = 'Reading backup file...';
  try {
    const raw = await file.arrayBuffer();
    let buf; // plaintext: [4-byte manifest length][manifest JSON][binaries]

    if (hasBackupMagic(new Uint8Array(raw, 0, Math.min(6, raw.byteLength)))) {
      const password = el.backup.password.value;
      if (!password) throw new Error('This backup is encrypted — enter its password above, then Import again.');
      const salt = new Uint8Array(raw, 6, 16);
      const iv = new Uint8Array(raw, 22, 12);
      const cipher = raw.slice(34);
      const key = await deriveBackupKey(password, salt, ['decrypt']);
      el.backup.status.textContent = 'Decrypting...';
      try {
        buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
      } catch (e) {
        throw new Error('Wrong password, or the backup file is damaged.');
      }
    } else {
      buf = raw; // legacy unencrypted backup
    }

    const manifestLength = new DataView(buf, 0, 4).getUint32(0, true);
    const manifestBytes = new Uint8Array(buf, 4, manifestLength);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!manifest || manifest.version !== 1) throw new Error('Unrecognized backup file — was this exported from this app?');

    const binaryStart = 4 + manifestLength;
    const db = await openLibraryDB();

    await idbPutAll(db, 'patients', manifest.patients);

    const fileRecords = manifest.files.map(f => ({
      id: f.id, patientKey: f.patientKey, seriesUid: f.seriesUid, filename: f.filename,
      bytes: new Uint8Array(buf.slice(binaryStart + f.byteOffset, binaryStart + f.byteOffset + f.byteLength)),
    }));
    await idbPutAll(db, 'files', fileRecords);

    const videoRecords = manifest.videos.map(v => ({
      id: v.id, folder: v.folder, filename: v.filename, size: v.size, type: v.type,
      thumbnail: v.thumbnail, addedAt: v.addedAt,
      blob: new Blob([buf.slice(binaryStart + v.byteOffset, binaryStart + v.byteOffset + v.byteLength)], { type: v.type || 'video/mp4' }),
    }));
    await idbPutAll(db, 'videos', videoRecords);

    el.backup.status.textContent =
      `Imported ${manifest.patients.length} patient(s), ${manifest.files.length} image(s), ${manifest.videos.length} video(s).`;
    await renderPatientList();
    if (el.video.modal && !el.video.modal.classList.contains('hidden')) {
      await refreshFolderNav();
      await renderVideoList();
    }
  } catch (e) {
    el.backup.status.textContent = `Import failed: ${errMsg(e)}`;
  }
}

el.backup = {
  modal: document.getElementById('backupModal'),
  exportBtn: document.getElementById('backupExport'),
  importInput: document.getElementById('backupImportInput'),
  importBtn: document.getElementById('backupImport'),
  password: document.getElementById('backupPassword'),
  status: document.getElementById('backupStatus'),
};
let backupSelectedFile = null;

document.getElementById('btnBackup').addEventListener('click', () => el.backup.modal.classList.remove('hidden'));
document.getElementById('backupClose').addEventListener('click', () => el.backup.modal.classList.add('hidden'));
document.querySelector('#backupModal .modalBackdrop').addEventListener('click', () => el.backup.modal.classList.add('hidden'));

el.backup.exportBtn.addEventListener('click', exportLibrary);

el.backup.importInput.addEventListener('change', (e) => {
  backupSelectedFile = e.target.files[0] || null;
  el.backup.importBtn.disabled = !backupSelectedFile;
  el.backup.status.textContent = backupSelectedFile ? `Selected: ${backupSelectedFile.name}` : '';
});
el.backup.importBtn.addEventListener('click', async () => {
  if (!backupSelectedFile) return;
  const ok = window.confirm(
    'Import this backup? Patients, images, and videos already stored here with matching IDs will be ' +
    'overwritten; everything else is added alongside what you already have.'
  );
  if (!ok) return;
  await importLibraryFromFile(backupSelectedFile);
});

// ---------- PACS (DICOMweb QIDO-RS / WADO-RS) ----------

// Default to the local Orthanc bridge (see orthanc/README.txt) so that once
// Orthanc is installed, connecting to the scanner archive is zero-config.
// When Orthanc itself serves the app (port 8042), talk to that same host — so PACS
// works whether the page is opened locally or from another computer over Tailscale.
// Otherwise (standalone dev server or a file:// open) fall back to the local Orthanc.
const ORTHANC_DICOMWEB = (location.protocol.indexOf('http') === 0 && location.port === '8042')
  ? location.origin + '/dicom-web'
  : 'http://localhost:8042/dicom-web';

state.pacs = {
  qidoUrl: localStorage.getItem('pacs_qido_url') || ORTHANC_DICOMWEB,
  wadoUrl: localStorage.getItem('pacs_wado_url') || ORTHANC_DICOMWEB,
  authType: localStorage.getItem('pacs_auth_type') || 'none',
  username: localStorage.getItem('pacs_username') || '',
  password: '', // never persisted
  token: '',    // never persisted
  // Saved locations (This Office, Other Office, ...). Passwords/tokens are never
  // persisted here — only URLs, auth type, and username.
  locations: JSON.parse(localStorage.getItem('pacs_locations') || 'null') || [
    { name: 'This Office', qidoUrl: ORTHANC_DICOMWEB, wadoUrl: ORTHANC_DICOMWEB, authType: 'none', username: '' },
  ],
  activeLoc: localStorage.getItem('pacs_active_loc') || 'This Office',
};

el.pacs = {
  modal: document.getElementById('pacsModal'),
  qidoUrl: document.getElementById('pacsQidoUrl'),
  wadoUrl: document.getElementById('pacsWadoUrl'),
  authType: document.getElementById('pacsAuthType'),
  basicFields: document.getElementById('pacsBasicFields'),
  bearerFields: document.getElementById('pacsBearerFields'),
  username: document.getElementById('pacsUsername'),
  password: document.getElementById('pacsPassword'),
  token: document.getElementById('pacsToken'),
  patientName: document.getElementById('pacsPatientName'),
  patientId: document.getElementById('pacsPatientId'),
  studyDate: document.getElementById('pacsStudyDate'),
  accession: document.getElementById('pacsAccession'),
  modality: document.getElementById('pacsModality'),
  status: document.getElementById('pacsStatus'),
  resultsBody: document.querySelector('#pacsResults tbody'),
  locations: document.getElementById('pacsLocations'),
  locName: document.getElementById('pacsLocName'),
  locDelete: document.getElementById('pacsLocDelete'),
};

el.pacs.qidoUrl.value = state.pacs.qidoUrl;
el.pacs.wadoUrl.value = state.pacs.wadoUrl;
el.pacs.authType.value = state.pacs.authType;
el.pacs.username.value = state.pacs.username;
updatePacsAuthFieldVisibility();

function updatePacsAuthFieldVisibility() {
  el.pacs.basicFields.classList.toggle('hidden', el.pacs.authType.value !== 'basic');
  el.pacs.bearerFields.classList.toggle('hidden', el.pacs.authType.value !== 'bearer');
}

// ----- Saved PACS locations -----

function savePacsLocations() {
  localStorage.setItem('pacs_locations', JSON.stringify(state.pacs.locations));
  localStorage.setItem('pacs_active_loc', state.pacs.activeLoc);
}

function populatePacsLocations() {
  el.pacs.locations.innerHTML = state.pacs.locations
    .map(l => `<option value="${escapeHtml(l.name)}"${l.name === state.pacs.activeLoc ? ' selected' : ''}>${escapeHtml(l.name)}</option>`)
    .join('');
  el.pacs.locDelete.disabled = state.pacs.locations.length <= 1;
}

// Make a saved location the active connection: fill the form, update state, and
// mirror it into the active-connection localStorage keys the search actually reads.
function applyPacsLocation(loc) {
  if (!loc) return;
  state.pacs.activeLoc = loc.name;
  state.pacs.qidoUrl = loc.qidoUrl || '';
  state.pacs.wadoUrl = loc.wadoUrl || '';
  state.pacs.authType = loc.authType || 'none';
  state.pacs.username = loc.username || '';
  el.pacs.locName.value = loc.name;
  el.pacs.qidoUrl.value = state.pacs.qidoUrl;
  el.pacs.wadoUrl.value = state.pacs.wadoUrl;
  el.pacs.authType.value = state.pacs.authType;
  el.pacs.username.value = state.pacs.username;
  updatePacsAuthFieldVisibility();
  localStorage.setItem('pacs_qido_url', state.pacs.qidoUrl);
  localStorage.setItem('pacs_wado_url', state.pacs.wadoUrl);
  localStorage.setItem('pacs_auth_type', state.pacs.authType);
  localStorage.setItem('pacs_username', state.pacs.username);
  localStorage.setItem('pacs_active_loc', state.pacs.activeLoc);
}

function openPacsModal() {
  populatePacsLocations();
  const active = state.pacs.locations.find(l => l.name === state.pacs.activeLoc) || state.pacs.locations[0];
  if (active) applyPacsLocation(active);
  el.pacs.modal.classList.remove('hidden');
}

// Restore the last active location's name into the form on startup.
el.pacs.locName.value = state.pacs.activeLoc;
populatePacsLocations();

function pacsAuthHeaders() {
  const headers = {};
  if (state.pacs.authType === 'basic' && state.pacs.username) {
    headers['Authorization'] = 'Basic ' + btoa(`${state.pacs.username}:${state.pacs.password}`);
  } else if (state.pacs.authType === 'bearer' && state.pacs.token) {
    headers['Authorization'] = 'Bearer ' + state.pacs.token;
  }
  return headers;
}

// DICOMweb JSON responses key each attribute by its DICOM tag (group+element, no comma).
function dwString(obj, tag) {
  const el = obj[tag];
  if (!el || !el.Value || !el.Value.length) return '';
  return String(el.Value[0]);
}
function dwPersonName(obj, tag) {
  const el = obj[tag];
  if (!el || !el.Value || !el.Value.length) return '';
  const v = el.Value[0];
  if (v && typeof v === 'object') return (v.Alphabetic || '').replace(/\^/g, ' ').trim();
  return String(v || '');
}

async function pacsSearchStudies() {
  if (!state.pacs.qidoUrl) {
    el.pacs.status.textContent = 'Set the QIDO-RS URL under Connection first.';
    return;
  }
  const qs = new URLSearchParams();
  if (el.pacs.patientName.value.trim()) qs.set('PatientName', el.pacs.patientName.value.trim());
  if (el.pacs.patientId.value.trim()) qs.set('PatientID', el.pacs.patientId.value.trim());
  if (el.pacs.studyDate.value.trim()) qs.set('StudyDate', el.pacs.studyDate.value.trim());
  if (el.pacs.accession.value.trim()) qs.set('AccessionNumber', el.pacs.accession.value.trim());
  if (el.pacs.modality.value) qs.set('ModalitiesInStudy', el.pacs.modality.value);
  qs.set('limit', '50');

  el.pacs.status.textContent = 'Searching...';
  el.pacs.resultsBody.innerHTML = '';

  try {
    const url = `${state.pacs.qidoUrl.replace(/\/$/, '')}/studies?${qs.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/dicom+json', ...pacsAuthHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const studies = await res.json();

    if (!studies.length) {
      el.pacs.status.textContent = 'No studies found.';
      return;
    }

    studies.forEach(s => {
      const studyUid = dwString(s, '0020000D');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${dwPersonName(s, '00100010') || 'Unknown'}</td>
        <td>${dwString(s, '00100020') || ''}</td>
        <td>${formatDate(dwString(s, '00080020'))}</td>
        <td>${dwString(s, '00081030') || ''}</td>
        <td>${dwString(s, '00080061') || dwString(s, '00080060') || ''}</td>
        <td><button class="btn btn-primary pacsLoadBtn">Load</button></td>
      `;
      tr.querySelector('.pacsLoadBtn').addEventListener('click', () => pacsLoadStudy(studyUid));
      el.pacs.resultsBody.appendChild(tr);
    });

    el.pacs.status.textContent = `Found ${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}.`;
  } catch (err) {
    el.pacs.status.textContent = `Search failed: ${errMsg(err)}`;
  }
}

// A single WADO-RS series retrieve for a CBCT-sized series can be 200-400MB —
// fetch()'s own promise doesn't resolve until the whole thing lands, so without
// this the UI just sits on one static message for however long that takes.
// Reads the body as a stream instead so we can report real bytes-received progress.
async function fetchWithProgress(url, options, onProgress) {
  const res = await fetch(url, options);
  if (!res.ok || !res.body || !res.body.getReader) {
    return { ok: res.ok, status: res.status, headers: res.headers, arrayBuffer: () => res.arrayBuffer() };
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return { ok: res.ok, status: res.status, headers: res.headers, arrayBuffer: async () => merged.buffer };
}

function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

// A WADO-RS series retrieve returns all instances as one multipart/related body.
// Boundary matching is done at the byte level since DICOM instance data is binary.
function parseMultipartRelated(arrayBuffer, contentType) {
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('No multipart boundary in response Content-Type');
  const boundaryBytes = new TextEncoder().encode('--' + boundaryMatch[1]);
  const sepBytes = new TextEncoder().encode('\r\n\r\n');
  const bytes = new Uint8Array(arrayBuffer);

  function indexOfBytes(haystack, needle, start) {
    outer: for (let i = start; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  const boundaryPositions = [];
  let pos = 0;
  while (true) {
    const idx = indexOfBytes(bytes, boundaryBytes, pos);
    if (idx === -1) break;
    boundaryPositions.push(idx);
    pos = idx + boundaryBytes.length;
  }

  const parts = [];
  for (let i = 0; i < boundaryPositions.length - 1; i++) {
    const partStart = boundaryPositions[i] + boundaryBytes.length;
    const headerSep = indexOfBytes(bytes, sepBytes, partStart);
    if (headerSep === -1) continue;
    let bodyStart = headerSep + sepBytes.length;
    let bodyEnd = boundaryPositions[i + 1];
    if (bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    if (bodyEnd > bodyStart) parts.push(bytes.slice(bodyStart, bodyEnd));
  }
  return parts;
}

async function pacsLoadStudy(studyUid) {
  const wadoBase = (state.pacs.wadoUrl || state.pacs.qidoUrl).replace(/\/$/, '');
  const qidoBase = state.pacs.qidoUrl.replace(/\/$/, '');

  // Close the search results now and let the loading overlay carry every remaining
  // phase (download, parse, decode) — a single visible bar the whole way through,
  // instead of the modal's status text vanishing right as the slow part starts.
  el.pacs.modal.classList.add('hidden');
  showLoadingProgress('Initializing scan', 0, 0);

  try {
    const seriesRes = await fetch(`${qidoBase}/studies/${studyUid}/series`, {
      headers: { Accept: 'application/dicom+json', ...pacsAuthHeaders() },
    });
    if (!seriesRes.ok) throw new Error(`HTTP ${seriesRes.status} listing series`);
    const seriesList = await seriesRes.json();

    const parsed = [];
    for (let i = 0; i < seriesList.length; i++) {
      const seriesUid = dwString(seriesList[i], '0020000E');
      const seriesLabel = seriesList.length > 1 ? `series ${i + 1} / ${seriesList.length}` : 'study';
      showLoadingProgress(
        `Retrieving from archive`, 0, 0,
        `Pulling the full ${seriesLabel} over the network — new studies aren't cached yet, so this is the slow part. Opening it again after this will be instant.`
      );
      const instRes = await fetchWithProgress(
        `${wadoBase}/studies/${studyUid}/series/${seriesUid}`,
        { headers: { Accept: 'multipart/related; type="application/dicom"', ...pacsAuthHeaders() } },
        (received, total) => {
          showLoadingProgress(`Retrieving from archive — ${formatBytes(received)}${total ? ' / ' + formatBytes(total) : ''}`, received, total);
        }
      );
      if (!instRes.ok) {
        console.warn(`Series ${seriesUid} retrieve failed: HTTP ${instRes.status}`);
        continue;
      }
      const contentType = instRes.headers.get('content-type');
      const buf = await instRes.arrayBuffer();
      const parts = parseMultipartRelated(buf, contentType);
      for (let idx = 0; idx < parts.length; idx++) {
        try {
          const dataSet = dicomParser.parseDicom(parts[idx]);
          parsed.push({ filename: `${seriesUid}-${idx}.dcm`, dataSet, bytes: parts[idx] });
        } catch (e) {
          console.warn('Skipping unparsable instance from PACS:', e);
        }
        if (idx % 25 === 0 || idx === parts.length - 1) {
          showLoadingProgress(
            `Parsing DICOM data — ${idx + 1} / ${parts.length}`, idx + 1, parts.length,
            `Reading each image out of the archive format before it can be displayed.`
          );
          await yieldToUI();
        }
      }
    }

    if (!parsed.length) {
      el.pacs.status.textContent = 'No readable instances retrieved from PACS.';
      return;
    }

    await ingestParsed(parsed);
  } catch (err) {
    el.pacs.status.textContent = `Load failed: ${errMsg(err)}`;
  } finally {
    hideLoadingProgress();
  }
}

// ---------- PACS wiring ----------

document.getElementById('btnPacs').addEventListener('click', openPacsModal);
document.getElementById('pacsClose').addEventListener('click', () => el.pacs.modal.classList.add('hidden'));
document.querySelector('#pacsModal .modalBackdrop').addEventListener('click', () => el.pacs.modal.classList.add('hidden'));

el.pacs.authType.addEventListener('change', updatePacsAuthFieldVisibility);

el.pacs.locations.addEventListener('change', () => {
  const loc = state.pacs.locations.find(l => l.name === el.pacs.locations.value);
  if (loc) { applyPacsLocation(loc); el.pacs.status.textContent = `Switched to "${loc.name}".`; }
});

el.pacs.locDelete.addEventListener('click', () => {
  const name = el.pacs.locations.value;
  if (state.pacs.locations.length <= 1) return;
  if (!window.confirm(`Delete saved location "${name}"?`)) return;
  state.pacs.locations = state.pacs.locations.filter(l => l.name !== name);
  if (state.pacs.activeLoc === name) applyPacsLocation(state.pacs.locations[0]);
  savePacsLocations();
  populatePacsLocations();
  el.pacs.status.textContent = `Deleted "${name}".`;
});

document.getElementById('pacsSaveConnection').addEventListener('click', () => {
  const name = el.pacs.locName.value.trim() || 'Unnamed';
  const loc = {
    name,
    qidoUrl: el.pacs.qidoUrl.value.trim(),
    wadoUrl: el.pacs.wadoUrl.value.trim(),
    authType: el.pacs.authType.value,
    username: el.pacs.username.value.trim(),
  };
  const idx = state.pacs.locations.findIndex(l => l.name === name);
  if (idx >= 0) state.pacs.locations[idx] = loc; else state.pacs.locations.push(loc);

  // Password/token stay in memory only, applied to the now-active connection.
  state.pacs.password = el.pacs.password.value;
  state.pacs.token = el.pacs.token.value;
  applyPacsLocation(loc);
  savePacsLocations();
  populatePacsLocations();
  el.pacs.status.textContent = `Saved location "${name}" (password/token kept in-memory only, not persisted).`;
});

document.getElementById('pacsSearch').addEventListener('click', pacsSearchStudies);

// ---------- Send to Archive (STOW-RS upload to the shared Orthanc bridge) ----------
// Locally-loaded files only live in this browser's library; pushing them to the
// archive makes them visible from every computer via the PACS search.

async function sendActivePatientToArchive() {
  if (!state.entries.length) {
    setStatus('Nothing loaded to archive — open a patient first.', 'warn');
    return;
  }
  const base = (state.pacs.qidoUrl || '').replace(/\/+$/, '');
  if (!base) {
    setStatus('No archive configured — set the PACS connection first.', 'warn');
    return;
  }

  // One part per source file: multi-frame entries share a dataSet, so dedupe on it.
  const seen = new Set();
  const parts = [];
  for (const entry of state.entries) {
    if (!entry.dataSet || seen.has(entry.dataSet)) continue;
    seen.add(entry.dataSet);
    parts.push(entry.dataSet.byteArray);
  }
  if (!parts.length) {
    setStatus('Loaded entries have no raw file data to archive.', 'err');
    return;
  }

  setStatus(`Sending ${parts.length} file(s) to the archive...`);
  const boundary = 'HOUNSFIELD-' + Date.now();
  const chunks = [];
  for (const bytes of parts) {
    chunks.push(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
    chunks.push(bytes);
    chunks.push('\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);

  try {
    const res = await fetch(`${base}/studies`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
        'Accept': 'application/dicom+json',
        ...pacsAuthHeaders(),
      },
      body: new Blob(chunks),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Archived ${parts.length} file(s) — now visible from every computer via PACS search.`, 'ok');
  } catch (err) {
    setStatus(`Archive upload failed: ${errMsg(err)}`, 'err');
  }
}

document.getElementById('btnSendArchive').addEventListener('click', sendActivePatientToArchive);

// ---------- Surgery videos (shared patient-education library, folders + thumbnails) ----------

const VIDEO_ICON = '<svg class="videoRowIcon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="10" rx="1.5"/><path d="M14 8.5l4-2.5v8l-4-2.5"/></svg>';

state.video = { objectUrl: null, activeId: null, activeFolder: null };

el.video = {
  modal: document.getElementById('videoModal'),
  folderInput: document.getElementById('videoFolderInput'),
  folderDatalist: document.getElementById('videoFolderDatalist'),
  dropZone: document.getElementById('videoDropZone'),
  fileInput: document.getElementById('videoFileInput'),
  folderFileInput: document.getElementById('videoFolderFileInput'),
  uploadStatus: document.getElementById('videoUploadStatus'),
  player: document.getElementById('videoPlayer'),
  folderNav: document.getElementById('videoFolderNav'),
  filterInput: document.getElementById('videoFilterInput'),
  list: document.getElementById('videoList'),
  empty: document.getElementById('videoEmpty'),
};

// Blob URLs are only revoked when we stop pointing the <video> at them —
// leaving stale ones around leaks memory for the life of the tab.
function stopVideoPlayback() {
  el.video.player.pause();
  el.video.player.removeAttribute('src');
  el.video.player.load();
  el.video.player.classList.add('hidden');
  if (state.video.objectUrl) { URL.revokeObjectURL(state.video.objectUrl); state.video.objectUrl = null; }
  state.video.activeId = null;
  el.video.list.querySelectorAll('.videoCard.active').forEach(li => li.classList.remove('active'));
}

// Rebuilds the folder sidebar (name + count per folder, plus "All videos") and keeps
// the upload field's autocomplete list in sync with folders that already exist.
async function refreshFolderNav() {
  let all;
  try { all = await listVideos(); }
  catch (e) { el.video.uploadStatus.textContent = `Could not load videos: ${errMsg(e)}`; return; }

  const counts = new Map();
  all.forEach(v => counts.set(v.folder || 'Untitled', (counts.get(v.folder || 'Untitled') || 0) + 1));
  const folders = [...counts.keys()].sort((a, b) => a.localeCompare(b));

  el.video.folderNav.innerHTML = '';
  const allLi = document.createElement('li');
  allLi.className = 'videoFolderRow' + (state.video.activeFolder === null ? ' active' : '');
  allLi.innerHTML = `<span>All videos</span><span class="videoFolderCount">${all.length}</span>`;
  allLi.addEventListener('click', () => { state.video.activeFolder = null; refreshFolderNav(); renderVideoList(); });
  el.video.folderNav.appendChild(allLi);

  folders.forEach(f => {
    const li = document.createElement('li');
    li.className = 'videoFolderRow' + (state.video.activeFolder === f ? ' active' : '');
    li.innerHTML = `<span>${escapeHtml(f)}</span><span class="videoFolderCount">${counts.get(f)}</span>`;
    li.addEventListener('click', () => { state.video.activeFolder = f; refreshFolderNav(); renderVideoList(); });
    el.video.folderNav.appendChild(li);
  });

  el.video.folderDatalist.innerHTML = folders.map(f => `<option value="${escapeHtml(f)}"></option>`).join('');
}

async function renderVideoList() {
  el.video.list.innerHTML = '';

  let records;
  try { records = await listVideos(); }
  catch (e) { el.video.uploadStatus.textContent = `Could not load videos: ${errMsg(e)}`; return; }

  if (state.video.activeFolder !== null) {
    records = records.filter(rec => (rec.folder || 'Untitled') === state.video.activeFolder);
  }
  const filter = el.video.filterInput.value.trim().toLowerCase();
  if (filter) {
    records = records.filter(rec =>
      (rec.folder || '').toLowerCase().includes(filter) || rec.filename.toLowerCase().includes(filter)
    );
  }

  el.video.empty.classList.toggle('hidden', records.length > 0);

  records.forEach(rec => {
    const li = document.createElement('li');
    li.className = 'videoCard';
    li.dataset.id = rec.id;
    if (rec.id === state.video.activeId) li.classList.add('active');
    const when = rec.addedAt ? new Date(rec.addedAt).toLocaleDateString() : '';
    li.innerHTML = `
      <div class="videoCardThumb">${rec.thumbnail ? `<img src="${rec.thumbnail}" alt="" />` : VIDEO_ICON}</div>
      <div class="videoCardBody">
        <div class="videoRowTitle" title="${escapeHtml(rec.filename)}">${escapeHtml(rec.filename)}</div>
        <div class="videoRowMeta">
          <span class="videoRowProcedure">${escapeHtml(rec.folder || 'Untitled')}</span>
          <span>${formatBytes(rec.size)}${when ? ' &middot; ' + escapeHtml(when) : ''}</span>
        </div>
      </div>
      <button class="videoDelete" title="Delete video">${TRASH_ICON}</button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.videoDelete')) return;
      playVideoRecord(rec);
    });
    li.querySelector('.videoDelete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = window.confirm(`Delete "${rec.filename}" from the surgery video library?\n\nThis cannot be undone.`);
      if (!ok) return;
      if (state.video.activeId === rec.id) stopVideoPlayback();
      try { await deleteVideoById(rec.id); }
      catch (err) { el.video.uploadStatus.textContent = `Delete failed: ${errMsg(err)}`; return; }
      await refreshFolderNav();
      await renderVideoList();
      el.video.uploadStatus.textContent = `Deleted ${rec.filename}.`;
    });
    el.video.list.appendChild(li);
  });
}

function playVideoRecord(rec) {
  if (state.video.objectUrl) URL.revokeObjectURL(state.video.objectUrl);
  state.video.objectUrl = URL.createObjectURL(rec.blob);
  state.video.activeId = rec.id;
  el.video.player.src = state.video.objectUrl;
  el.video.player.classList.remove('hidden');
  el.video.player.play().catch(() => {}); // autoplay can be blocked; controls remain usable either way
  el.video.list.querySelectorAll('.videoCard').forEach(li => li.classList.toggle('active', li.dataset.id === rec.id));
  // If the list was scrolled past the player, bring the playback back into view.
  el.video.player.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Directory-selected files (input[webkitdirectory]) carry a real webkitRelativePath;
// dropped folders don't, so walkVideoEntry stamps an equivalent one while it recurses.
function folderForFile(file, fallbackFolder) {
  const rel = file.webkitRelativePath || '';
  if (rel.includes('/')) return rel.split('/')[0];
  return fallbackFolder;
}

function walkVideoEntry(entry, basePath, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(f => {
        const rel = basePath ? `${basePath}/${f.name}` : '';
        if (rel) { try { Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true }); } catch (e) {} }
        out.push(f);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const nextBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (children) => {
          if (!children.length) return resolve();
          await Promise.all(children.map(c => walkVideoEntry(c, nextBase, out)));
          readBatch();
        }, () => resolve());
      };
      readBatch();
    } else resolve();
  });
}

async function handleVideoFiles(fileList) {
  const fallbackFolder = el.video.folderInput.value.trim();
  const all = Array.from(fileList).filter(f =>
    f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name)
  );
  if (!all.length) { el.video.uploadStatus.textContent = 'No video files found in that selection.'; return; }

  const withFolders = all.map(f => ({ file: f, folder: folderForFile(f, fallbackFolder) }));
  if (withFolders.some(x => !x.folder)) {
    el.video.uploadStatus.textContent = 'Enter a folder/procedure name first, so these videos can be found later.';
    return;
  }

  for (let i = 0; i < withFolders.length; i++) {
    const { file, folder } = withFolders[i];
    el.video.uploadStatus.textContent = `Storing ${i + 1}/${withFolders.length}: ${file.name}...`;
    try {
      const thumbnail = await generateVideoThumbnail(file);
      await saveVideo(file, folder, thumbnail);
    } catch (e) {
      el.video.uploadStatus.textContent = `Storing ${file.name} failed: ${errMsg(e)}`;
      return;
    }
  }
  el.video.uploadStatus.textContent = `Stored ${withFolders.length} video${withFolders.length > 1 ? 's' : ''}.`;
  await refreshFolderNav();
  await renderVideoList();
}

async function openVideoModal() {
  el.video.uploadStatus.textContent = '';
  stopVideoPlayback();
  // Always open as a side dock (not blown up / not pinned) for a predictable start.
  el.video.modal.classList.remove('blownUp');
  document.getElementById('app').classList.remove('videoDockPinned');
  document.getElementById('videoPin').classList.remove('pinned');
  document.getElementById('videoBlowUp').classList.remove('active');
  await refreshFolderNav();
  await renderVideoList();
  el.video.modal.classList.remove('hidden');
  document.getElementById('btnVideos').classList.add('active'); // light up the tab
}

function closeVideoModal() {
  stopVideoPlayback();
  el.video.modal.classList.add('hidden');
  document.getElementById('btnVideos').classList.remove('active');
  // Release any reserved viewer space and refit the canvases.
  document.getElementById('app').classList.remove('videoDockPinned');
  refitAfterDockChange();
}

// The dock is fixed-position, so pinning/blow-up/close can change how much of the
// viewer is visible — the canvases must be re-measured and repainted afterward.
function refitAfterDockChange() {
  setTimeout(() => {
    if (state.view !== 'viewer') return;
    if (state.layout === 'stack') { fitCanvas(); render(); }
    else {
      fitPaneCanvases();
      Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
      renderAllPanes();
    }
  }, 60);
}

document.getElementById('btnVideos').addEventListener('click', openVideoModal);
document.getElementById('videoClose').addEventListener('click', closeVideoModal);

// Pin: keep the panel docked beside the scan (viewer makes room) instead of overlaying.
document.getElementById('videoPin').addEventListener('click', () => {
  const app = document.getElementById('app');
  const dock = el.video.modal;
  const pinned = app.classList.toggle('videoDockPinned');
  document.getElementById('videoPin').classList.toggle('pinned', pinned);
  if (pinned) dock.classList.remove('blownUp'); // pinned and fullscreen are mutually exclusive
  document.getElementById('videoBlowUp').classList.toggle('active', dock.classList.contains('blownUp'));
  refitAfterDockChange();
});

// Blow up: fill the whole content area for easy viewing.
document.getElementById('videoBlowUp').addEventListener('click', () => {
  const dock = el.video.modal;
  const big = dock.classList.toggle('blownUp');
  document.getElementById('videoBlowUp').classList.toggle('active', big);
  if (big) { // fullscreen supersedes pinned
    document.getElementById('app').classList.remove('videoDockPinned');
    document.getElementById('videoPin').classList.remove('pinned');
  }
  refitAfterDockChange();
});

el.video.fileInput.addEventListener('change', (e) => {
  handleVideoFiles(e.target.files);
  e.target.value = '';
});
el.video.folderFileInput.addEventListener('change', (e) => {
  handleVideoFiles(e.target.files);
  e.target.value = '';
});

el.video.filterInput.addEventListener('input', renderVideoList);

['dragenter', 'dragover'].forEach(evt => {
  el.video.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.video.dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  el.video.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragleave' && e.target !== el.video.dropZone) return;
    el.video.dropZone.classList.remove('dragover');
  });
});
el.video.dropZone.addEventListener('drop', async (e) => {
  const items = e.dataTransfer.items;
  const files = [];
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = Array.from(items).map(it => it.webkitGetAsEntry());
    await Promise.all(entries.map(ent => walkVideoEntry(ent, '', files)));
  } else {
    files.push(...Array.from(e.dataTransfer.files));
  }
  handleVideoFiles(files);
});

// ---------- Toolbar dropdown menu (Tools) ----------

(function setupToolsMenu() {
  const trigger = document.getElementById('btnTools');
  const panel = document.getElementById('toolsMenu');
  if (!trigger || !panel) return;

  const close = () => {
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.contains('hidden') ? open() : close();
  });
  // Selecting an item runs its own handler (bound elsewhere by ID) and closes the menu.
  panel.querySelectorAll('.menuItem').forEach(item => item.addEventListener('click', close));
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !e.target.closest('.menu')) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();

// ---------- Worklist landing page ----------

const wl = {
  page: document.getElementById('worklist'),
  main: document.getElementById('main'),
  toolbar: document.getElementById('toolbar'),
  btn: document.getElementById('btnWorklist'),
  body: document.getElementById('worklistBody'),
  empty: document.getElementById('worklistEmpty'),
  count: document.getElementById('worklistCount'),
  filter: document.getElementById('worklistFilter'),
};

function showView(view) {
  stopCine(); // never leave the cine loop running across a view switch
  state.view = view;
  const onWorklist = view === 'worklist';
  wl.page.classList.toggle('hidden', !onWorklist);
  wl.main.classList.toggle('hidden', onWorklist);
  wl.btn.classList.toggle('active', onWorklist);
  wl.toolbar.classList.toggle('onWorklist', onWorklist);
  if (onWorklist) {
    renderWorklist();
  } else {
    // The viewer container was display:none while the worklist showed, so its
    // canvases have zero size — resize and repaint now that it's visible again.
    if (state.layout === 'stack') { fitCanvas(); render(); }
    else {
      fitPaneCanvases();
      Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
      renderAllPanes();
    }
  }
}

// Pulls the study list straight from the archive (Orthanc) so anything auto-imported
// into it — e.g. dropped into the watched inbox folder — shows on the worklist without
// a manual PACS search. Fails soft: if the archive is unreachable, returns nothing and
// the worklist just shows the local library.
async function queryArchiveStudies() {
  const base = (state.pacs.qidoUrl || '').replace(/\/+$/, '');
  if (!base) return [];
  try {
    const res = await fetch(`${base}/studies?limit=200&includefield=00201206,00201208`, {
      headers: { Accept: 'application/dicom+json', ...pacsAuthHeaders() },
    });
    if (!res.ok) return [];
    const studies = await res.json();
    return studies.map(s => ({
      archive: true,
      studyUid: dwString(s, '0020000D'),
      name: dwPersonName(s, '00100010') || 'Unknown',
      id: dwString(s, '00100020'),
      studyDate: dwString(s, '00080020'),
      modality: dwString(s, '00080061') || dwString(s, '00080060'),
      series: dwString(s, '00201206'),
      images: dwString(s, '00201208'),
    }));
  } catch (e) { return []; }
}

function worklistRowMatches(f, name, id, mod) {
  if (!f) return true;
  return (name || '').toLowerCase().includes(f) || (id || '').toLowerCase().includes(f) || (mod || '').toLowerCase().includes(f);
}

async function renderWorklist() {
  let patients;
  try { patients = await listPatients(); }
  catch (e) { console.warn('worklist listPatients failed', e); patients = []; }
  state.patientListCache = patients;

  // Paint local library rows immediately, then merge in archive studies once the
  // (usually instant, on localhost) query returns.
  paintWorklist(patients, []);
  const archive = await queryArchiveStudies();
  const localIds = new Set(patients.map(p => (p.id || '').trim()).filter(Boolean));
  const extra = archive.filter(s => !s.id || !localIds.has(s.id.trim()));
  paintWorklist(patients, extra);
}

function paintWorklist(patients, archiveStudies) {
  const f = wl.filter.value.trim().toLowerCase();
  wl.body.innerHTML = '';

  const localShown = patients.filter(p => worklistRowMatches(f, p.name, p.id, (p.modalities || []).join(' ')));
  const archiveShown = archiveStudies.filter(s => worklistRowMatches(f, s.name, s.id, s.modality));

  wl.count.textContent = patients.length + archiveStudies.length;
  wl.empty.classList.toggle('hidden', localShown.length + archiveShown.length > 0);

  let rowIndex = 0;
  // Staggered fade-in, capped so a long worklist doesn't leave the last rows
  // waiting around — the entrance is a courtesy, not something to sit through.
  const rowDelay = () => `${Math.min(rowIndex++ * 22, 260)}ms`;

  localShown.forEach(p => {
    const tr = document.createElement('tr');
    tr.className = 'wlRowIn';
    tr.style.animationDelay = rowDelay();
    const mods = (p.modalities || []).join(' ');
    // The scan's acquisition date (StudyDate tag) — when the CT was actually taken.
    const scanDate = p.studyDate ? usDate(p.studyDate)
      : (p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '');
    tr.innerHTML =
      `<td class="wlName">${escapeHtml(p.name)}</td>` +
      `<td class="wlMono">${escapeHtml(p.id || '—')}</td>` +
      `<td>${mods ? `<span class="wlModBadge">${escapeHtml(mods)}</span>` : '—'}</td>` +
      `<td class="wlMono">${(p.seriesUids || []).length}</td>` +
      `<td class="wlMono">${p.fileCount}</td>` +
      `<td class="wlMono">${escapeHtml(scanDate)}</td>` +
      `<td><button class="wlOpen" tabindex="-1">Open &rsaquo;</button></td>`;
    tr.addEventListener('click', () => openStudyFromWorklist(p.key));
    wl.body.appendChild(tr);
  });

  archiveShown.forEach(s => {
    const tr = document.createElement('tr');
    tr.className = 'wlRowIn';
    tr.style.animationDelay = rowDelay();
    tr.innerHTML =
      `<td class="wlName">${escapeHtml(s.name)} <span class="wlArchiveBadge">Archive</span></td>` +
      `<td class="wlMono">${escapeHtml(s.id || '—')}</td>` +
      `<td>${s.modality ? `<span class="wlModBadge">${escapeHtml(s.modality)}</span>` : '—'}</td>` +
      `<td class="wlMono">${escapeHtml(s.series || '')}</td>` +
      `<td class="wlMono">${escapeHtml(s.images || '')}</td>` +
      `<td class="wlMono">${escapeHtml(usDate(s.studyDate))}</td>` +
      `<td><button class="wlOpen" tabindex="-1">Open &rsaquo;</button></td>`;
    tr.addEventListener('click', () => loadArchiveStudy(s.studyUid));
    wl.body.appendChild(tr);
  });
}

async function loadArchiveStudy(studyUid) {
  if (!studyUid) return;
  setStatus('Retrieving study from archive...');
  await pacsLoadStudy(studyUid); // pulls via WADO, ingests, and switches to the viewer
}

async function openStudyFromWorklist(key) {
  // Already loaded — just reveal the viewer. Otherwise load it (finishLoadingEntries
  // flips to the viewer on success; if nothing loads we stay on the worklist).
  if (key === state.activePatientKey && state.entries.length) { showView('viewer'); return; }
  await activatePatientByKey(key);
}

wl.btn.addEventListener('click', () => showView('worklist'));
wl.filter.addEventListener('input', renderWorklist);

// Auto-refresh the worklist so newly auto-imported studies appear on their own:
// whenever the window regains focus, and every 20s while the worklist is showing.
window.addEventListener('focus', () => { if (state.view === 'worklist') renderWorklist(); });
setInterval(() => { if (state.view === 'worklist' && document.hasFocus()) renderWorklist(); }, 20000);
document.getElementById('fileInput2').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
document.getElementById('worklistPacs').addEventListener('click', () => openPacsModal());

// Sample studies for visitors trying the viewer without their own DICOM files.
// Real multi-slice TCIA studies (CC BY 4.0, redistributed by saga-it.com) — see
// samples/SOURCE.txt and each folder's CITATION.txt for the required attribution.
const SAMPLE_STUDIES = ['ct-chest-nlst', 'mr-brain-upenn-gbm'];
document.getElementById('worklistSamples').addEventListener('click', async () => {
  setStatus('Loading sample studies...');
  try {
    const files = [];
    for (const folder of SAMPLE_STUDIES) {
      const manifestRes = await fetch(`samples/${folder}/manifest.json`);
      if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} fetching ${folder} manifest`);
      const names = await manifestRes.json();
      let loaded = 0;
      const studyFiles = await Promise.all(names.map(async (name) => {
        const res = await fetch(`samples/${folder}/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${folder}/${name}`);
        const blob = await res.blob();
        loaded++;
        if (loaded % 20 === 0 || loaded === names.length) {
          setStatus(`Loading sample studies... (${folder}: ${loaded}/${names.length})`);
          await yieldToUI();
        }
        return new File([blob], name, { type: 'application/dicom' });
      }));
      files.push(...studyFiles);
    }
    await handleFiles(files);
  } catch (e) {
    setStatus(`Could not load sample studies — ${errMsg(e)}`, 'err');
  }
});

// ---------- Image export (PNG download + clipboard) ----------

// Returns a canvas of what's on screen: the stack canvas, or a composite of the
// MPR panes laid out exactly as displayed.
function captureViewCanvas() {
  if (state.layout === 'stack') return el.canvas;
  const gridRect = el.mprGrid.getBoundingClientRect();
  if (!gridRect.width) return el.canvas;
  const out = document.createElement('canvas');
  out.width = Math.round(gridRect.width);
  out.height = Math.round(gridRect.height);
  const octx = out.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, out.width, out.height);
  Object.keys(el.panes).forEach(k => {
    const c = el.panes[k].canvas;
    const r = c.getBoundingClientRect();
    if (r.width) octx.drawImage(c, r.left - gridRect.left, r.top - gridRect.top, r.width, r.height);
  });
  return out;
}

function exportFilenameBase() {
  const entry = state.entries[state.currentIndex];
  const nm = entry ? (entry.dataSet.string('x00100010') || '').replace(/[\^\s]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') : '';
  return `hounsfield${nm ? '_' + nm : ''}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
}

function exportViewPng() {
  if (!state.entries.length) { setStatus('Load a study first.', 'warn'); return; }
  const canvas = captureViewCanvas();
  if (!canvas || !canvas.width) { setStatus('Nothing to export.', 'warn'); return; }
  canvas.toBlob(blob => {
    if (!blob) { setStatus('Export failed.', 'err'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilenameBase() + '.png';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('Image exported (PNG).', 'ok');
  }, 'image/png');
}

async function copyViewToClipboard() {
  if (!state.entries.length) { setStatus('Load a study first.', 'warn'); return; }
  const canvas = captureViewCanvas();
  if (!canvas || !canvas.width) { setStatus('Nothing to copy.', 'warn'); return; }
  if (!navigator.clipboard || !window.ClipboardItem) {
    setStatus('This browser can\'t copy images to the clipboard — use Export instead.', 'warn');
    return;
  }
  try {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Image copied — paste into Word, PowerPoint, etc.', 'ok');
  } catch (e) {
    setStatus(`Copy failed: ${errMsg(e)}`, 'err');
  }
}

document.getElementById('btnExportPng').addEventListener('click', exportViewPng);
document.getElementById('btnCopyImage').addEventListener('click', copyViewToClipboard);

// Ctrl/Cmd+C copies the current view — but only in the viewer, and never when the
// user is copying text from a field or has a text selection.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    const ae = document.activeElement;
    const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    const hasSelection = window.getSelection && String(window.getSelection()).length > 0;
    if (state.view === 'viewer' && !inField && !hasSelection) {
      e.preventDefault();
      copyViewToClipboard();
    }
  }
});

// ---------- Sidebar collapse (full-screen CT) ----------

(function setupSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarToggle');
  if (!sidebar || !btn) return;

  const apply = (collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
    btn.classList.toggle('collapsed', collapsed);
    btn.title = collapsed ? 'Show panel' : 'Hide panel';
    localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0');
    // The viewport just changed width — resize canvases and refit, exactly like a
    // window resize. Waits out the 0.16s CSS width transition first.
    setTimeout(() => {
      if (state.layout === 'stack') { fitCanvas(); render(); }
      else {
        fitPaneCanvases();
        Object.keys(state.panes).forEach(k => { state.panes[k].scale = null; });
        renderAllPanes();
      }
    }, 190);
  };

  btn.addEventListener('click', () => apply(!sidebar.classList.contains('collapsed')));
  if (localStorage.getItem('sidebar_collapsed') === '1') apply(true);
})();

// ---------- Automatic session lock (idle timeout) ----------
// After a period of no activity the screen is covered so patient information is not
// left visible on an unattended workstation. Resuming reloads the app (which re-runs
// the login if the browser hasn't saved it). Default 10 min; override by setting
// localStorage 'idle_minutes'.
(function setupSessionLock() {
  const lock = document.getElementById('lockScreen');
  const resume = document.getElementById('lockResume');
  if (!lock || !resume) return;

  const mins = parseInt(localStorage.getItem('idle_minutes'), 10);
  const idleMs = (Number.isFinite(mins) && mins > 0 ? mins : 10) * 60000;
  let timer = null;
  let locked = false;

  function lockNow() {
    locked = true;
    try { el.video && el.video.player && el.video.player.pause(); } catch (e) {}
    lock.classList.remove('hidden');
  }
  function poke() {
    if (locked) return; // stay locked until the user explicitly resumes
    clearTimeout(timer);
    timer = setTimeout(lockNow, idleMs);
  }

  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev =>
    window.addEventListener(ev, poke, { passive: true, capture: true }));
  resume.addEventListener('click', () => location.reload());
  poke();
})();

// ---------- Init ----------

fitCanvas();
render();
buildLmTable();
buildGridPanes(2, 2);
renderPatientList(); // keep the sidebar list in sync too
showView('worklist'); // open on the study list, like a real PACS
