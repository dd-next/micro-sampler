/* ======================================================================
   persistence
   ----------------------------------------------------------------------
   Samples and patterns live in IndexedDB on this device. Float32Array is
   structured-cloneable, so raw PCM goes in as-is — no encoding, no base64.
   Sounds that share a buffer (from a copy) are stored once.
   ====================================================================== */

const DB_NAME = 'micro-sampler';
const DB_STORE = 'state';
const DB_KEY = 'current';
const SAVE_DELAY = 1200;

let dbPromise = null;
let saveTimer = null;
let saveInFlight = false;
let savingDisabled = false;   // set by a wipe, so the reload cannot re-save

function openDB(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB){ reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbPut(value){
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, DB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(){
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(DB_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));
}
function idbClear(){
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(DB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}

/* ------------------------------------------------------------ snapshot */
function snapshot(){
  const bufIds = new Map();
  const buffers = [];

  const slotData = slots.map(s => {
    let bufId = null;
    if (s.buffer){
      if (!bufIds.has(s.buffer)){
        bufIds.set(s.buffer, buffers.length);
        buffers.push({
          rate: s.buffer.sampleRate,
          pcm:  new Float32Array(s.buffer.getChannelData(0))
        });
      }
      bufId = bufIds.get(s.buffer);
    }
    return {
      bufId,
      start:s.start, length:s.length,
      slices:s.slices ? s.slices.map(x => ({ s:x.s, l:x.l })) : null,
      tune:s.tune, vol:s.vol, cut:s.cut, res:s.res
    };
  });

  return {
    version: 1,
    buffers,
    slots: slotData,
    patterns: patterns.map(p => ({
      tracks: p.tracks.map(tr => tr.map(c => c ? Object.assign({}, c) : null)),
      fx: p.fx.slice()
    })),
    settings: {
      bpm, swing, master, tempoIx, sel, page,
      chain: chain.slice()
    }
  };
}

function scheduleSave(){
  if (savingDisabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

function saveNow(){
  if (savingDisabled) return;
  if (saveInFlight) { scheduleSave(); return; }
  saveInFlight = true;
  let snap;
  try { snap = snapshot(); }
  catch (e){ saveInFlight = false; return; }

  idbPut(snap)
    .catch(err => {
      console.warn('save failed', err);
      if (err && err.name === 'QuotaExceededError') msg('storage full — sounds may not persist');
    })
    .finally(() => { saveInFlight = false; });
}

/* --------------------------------------------------------------- load */
function restore(snap){
  if (!snap || snap.version !== 1) return false;

  // deliberately no ensureAudio() here — see makeAudioBuffer in audio.js
  const bufs = (snap.buffers || []).map(b => {
    const ab = makeAudioBuffer(b.pcm.length, b.rate);
    ab.getChannelData(0).set(b.pcm);
    return ab;
  });

  (snap.slots || []).forEach((d, i) => {
    if (i >= N) return;
    const s = slots[i];
    s.buffer = d.bufId != null && bufs[d.bufId] ? bufs[d.bufId] : null;
    s.rev = null;
    s.start = num(d.start, 0);
    s.length = num(d.length, 1);
    s.slices = Array.isArray(d.slices) && d.slices.length === 16
      ? d.slices.map(x => ({ s:num(x.s, 0), l:num(x.l, 1 / 16) }))
      : null;
    s.tune = num(d.tune, 0);
    s.vol  = num(d.vol, 0.9);
    s.cut  = num(d.cut, 0.5);
    s.res  = num(d.res, 0);
  });

  (snap.patterns || []).forEach((p, i) => {
    if (i >= N) return;
    if (Array.isArray(p.tracks)){
      p.tracks.forEach((tr, t) => {
        if (t >= N) return;
        for (let st = 0; st < N; st++){
          const c = tr[st];
          patterns[i].tracks[t][st] = (c && typeof c === 'object') ? Object.assign({}, c) : null;
        }
      });
    }
    if (Array.isArray(p.fx)){
      for (let st = 0; st < N; st++){
        const f = p.fx[st];
        patterns[i].fx[st] = (typeof f === 'number' && f >= 0 && f < 16) ? f : null;
      }
    }
  });

  const st = snap.settings || {};
  bpm     = clampNum(st.bpm, 60, 240, 120);
  swing   = clampNum(st.swing, 0, 60, 0);
  tempoIx = clampNum(st.tempoIx, 0, TEMPOS.length - 1, 1);
  sel     = clampNum(st.sel, 0, N - 1, 0);
  page    = PAGES.includes(st.page) ? st.page : 'tone';
  chain   = Array.isArray(st.chain) && st.chain.length
    ? st.chain.filter(c => Number.isInteger(c) && c >= 0 && c < N).slice(0, MAX_CHAIN)
    : [0];
  if (!chain.length) chain = [0];
  curPat = chain[0];
  setMaster(clampNum(st.master, 0, 1, 0.9));
  return true;
}

function num(v, dflt){ return typeof v === 'number' && isFinite(v) ? v : dflt; }
function clampNum(v, lo, hi, dflt){
  if (typeof v !== 'number' || !isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

function loadSaved(){
  return idbGet()
    .then(snap => (snap ? restore(snap) : false))
    .catch(err => { console.warn('load failed', err); return false; });
}

/* Stop saving first: the reload fires `pagehide`, which would otherwise
   write the still-loaded state straight back over the wipe. */
function wipeSaved(){
  savingDisabled = true;
  clearTimeout(saveTimer);
  return idbClear()
    .catch(err => console.warn('wipe failed', err))
    .then(() => location.reload());
}
