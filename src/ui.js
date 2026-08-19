/* ======================================================================
   grid, modes, LCD, knobs, transport
   ----------------------------------------------------------------------
   Mode buttons work two ways at once: tap to latch, or hold as a
   modifier. The hardware only does the second; on a touchscreen you often
   have one hand free, so both are supported and they share one state
   machine — `mode` is always heldMod || latchedMod || 'keys'.
   ====================================================================== */

const $ = id => document.getElementById(id);

const gridEl = $('grid'), dotsEl = $('dots');
const modeLbl = $('modeLbl'), sndLbl = $('sndLbl'), patLbl = $('patLbl'), noteLbl = $('noteLbl');
const chainLbl = $('chainLbl'), msgLbl = $('msgLbl'), lvlFill = $('lvlFill');
const memFill = $('memFill'), memVal = $('memVal');
const slotLbl = $('slotLbl'), slotType = $('slotType'), warnEl = $('warn');
const playBtn = $('play'), liveBtn = $('live'), clrBtn = $('clr');
const bpmS = $('bpm'), swingS = $('swing'), masterS = $('master'), tempoBtn = $('tempo');

const keyEls = [], dotEls = [];

const DEFAULT_MSG = 'hold a mode button, or tap to latch';
let msgTimer = null;

function msg(text, ms){
  msgLbl.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msgLbl.textContent = DEFAULT_MSG; }, ms || 1900);
}
function warn(text){
  warnEl.innerHTML = text;
  warnEl.classList.toggle('show', !!text);
}

/* Enter and Space on a focused control, with press/release semantics so
   FX and REC can be held from the keyboard too. Native buttons only fire
   `click`, which cannot express a hold. */
function bindHold(el, onDown, onUp){
  let down = false;
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    e.stopPropagation();
    if (down) return;              // ignore auto-repeat
    down = true;
    onDown();
  });
  const release = e => {
    if (e.type === 'keyup' && e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (!down) return;
    if (e.preventDefault) e.preventDefault();
    down = false;
    onUp();
  };
  el.addEventListener('keyup', release);
  el.addEventListener('blur', release);
}

/* ====================================================== build the 4x4 */
for (let i = 0; i < N; i++){
  const k = document.createElement('button');
  k.className = 'key';
  k.type = 'button';
  k.innerHTML = `<span class="kidx">${i + 1}</span><span class="kdot"></span>` +
                `<span class="klabel"></span><span class="ksub"></span>`;
  k.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    k.setPointerCapture(e.pointerId);
    keyDown(i, k);
  });
  const up = e => {
    e.preventDefault();
    try { k.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    keyUp(i, k);
  };
  k.addEventListener('pointerup', up);
  k.addEventListener('pointercancel', up);
  bindHold(k, () => keyDown(i, k), () => keyUp(i, k));
  gridEl.appendChild(k);
  keyEls.push(k);

  const d = document.createElement('div');
  d.className = 'dot' + ([0, 4, 8, 12].includes(i) ? ' beat' : '');
  dotsEl.appendChild(d);
  dotEls.push(d);
}

/* ====================================================== modifier state */
/* Several modifiers can be physically down at once — WRITE latched plus FX
   held is how effects get saved into a pattern — so held buttons are a
   stack, not a single slot. The topmost one decides the mode. */
const heldStack = [];               // [{ mod, at, used, wasLatched }]
let latchedMod = null;
let chainBuilding = false;

const topHeld = () => (heldStack.length ? heldStack[heldStack.length - 1].mod : null);
const isHeld  = m => heldStack.some(h => h.mod === m);
const writeArmed = () => isHeld('write') || latchedMod === 'write';

function applyMode(){
  const next = topHeld() || latchedMod || 'keys';
  if (next === mode){ paintModeButtons(); return; }
  const prev = mode;
  mode = next;
  onLeaveMode(prev);
  onEnterMode(next);
  modeLbl.textContent = next.toUpperCase();
  paintModeButtons();
  renderGrid();
}

function paintModeButtons(){
  document.querySelectorAll('.mbtn').forEach(b => {
    b.classList.toggle('on', b.dataset.mod === mode || b.dataset.mod === latchedMod);
    b.classList.toggle('held', isHeld(b.dataset.mod));
  });
}

function onEnterMode(m){
  if (m === 'rec'){
    clearTimeout(micReleaseTimer);
    armMicWithFeedback();
  }
  if (m === 'pattern') msg('hold and press keys to chain');
  if (m === 'fx') msg('hold a key for an effect');
  if (m === 'bpm') msg('keys 1–16 set master volume');
  if (m === 'write') msg(playing ? 'punch keys in — quantized' : 'keys are the 16 steps');
  if (m === 'sound') msg('pick a sound');
}
function onLeaveMode(m){
  if (m === 'fx') fxAllOff();
  if (m === 'rec'){
    recIntent = null;
    clearTimeout(micReleaseTimer);
    // Hand the microphone back at once. iOS routes output to the earpiece
    // while a play-and-record session is open, so lingering in it costs the
    // speaker. The only reason to wait is a permission prompt still on
    // screen — releasing then would cancel it.
    if (!micArming()){
      releaseMic();
    } else {
      let waits = 0;
      micReleaseTimer = setTimeout(function tryRelease(){
        if (mode === 'rec') return;
        if (micArming() && waits++ < 20){
          micReleaseTimer = setTimeout(tryRelease, 500);
          return;
        }
        releaseMic();
      }, 400);
    }
  }
}

/* Safari has not consistently treated `pointerdown` as the kind of user
   gesture that unlocks media capture — the same quirk the AudioContext has to
   work around. While REC is waiting for a microphone that never arrived, take
   the next touchend or click as a fresh gesture and ask again. */
['touchend', 'click'].forEach(type => {
  document.addEventListener(type, () => {
    if (mode === 'rec' && !micActive() && !micArming()) armMicWithFeedback();
  }, { capture:true, passive:true });
});

function modDown(m){
  ensureAudio();
  if (isHeld(m)) return;
  const wasLatched = latchedMod === m;
  if (wasLatched) latchedMod = null;            // tapping a latched mode exits it
  heldStack.push({ mod:m, at:performance.now(), used:false, wasLatched });
  // Each fresh press of PATTERN starts a new chain, even when the mode was
  // already active and applyMode below has nothing to transition.
  if (m === 'pattern') chainBuilding = false;
  applyMode();
}
function modUp(m){
  const ix = heldStack.findIndex(h => h.mod === m);
  if (ix < 0) return;
  const h = heldStack.splice(ix, 1)[0];
  const quick = performance.now() - h.at < 450;
  // A quick tap that did nothing latches the mode. Anything else — a long
  // hold, or a hold that was used as a modifier — leaves any existing latch
  // alone, so WRITE survives being combined with FX.
  if (!h.used && quick && !h.wasLatched) latchedMod = m;
  applyMode();
}
function markModUsed(){
  if (heldStack.length) heldStack[heldStack.length - 1].used = true;
}

document.querySelectorAll('.mbtn').forEach(b => {
  const m = b.dataset.mod;
  b.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    modDown(m);
  });
  const up = e => {
    e.preventDefault();
    try { b.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    modUp(m);
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  bindHold(b, () => modDown(m), () => modUp(m));
});

/* ====================================================== key dispatch */
function keyDown(i, el){
  ensureAudio();
  markModUsed();

  switch (mode){
    case 'keys':    playKey(i, el); break;
    case 'sound':   soundKey(i); flash(el); break;
    case 'pattern': patternKey(i); flash(el); break;
    case 'write':   writeKey(i, el); break;
    case 'fx':      fxKey(i, el); break;
    case 'rec':     recKeyDown(i); break;
    case 'bpm':     volumeKey(i); flash(el); break;
  }
}
function keyUp(i, el){
  if (mode === 'fx'){ fxOff(i); el.classList.remove('act'); renderGrid(); }
  if (mode === 'rec') recKeyUp(i);
}
/* After a one-shot pick, drop back to KEYS if the mode was only latched. */
function releaseLatch(){
  if (!topHeld() && latchedMod){ latchedMod = null; applyMode(); }
}
function flash(el){
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 90);
}

/* -------------------------------------------------------------- SOUND */
function soundKey(i){
  if (copyArmed && copySource != null && i !== copySource) doCopy(i);
  else if (copyArmed) cancelCopy('pick a different slot');
  selectSlot(i);
  releaseLatch();
}

/* --------------------------------------------------------------- KEYS */
function playKey(i, el){
  const s = slots[sel];
  if (s.type === 'drum'){ lastSlice = i; } else { lastNote = i; }
  trig(sel, actx.currentTime + 0.005, i);
  flash(el);
  updateNoteLabel();
  if (page === 'trim'){ drawWave(); syncKnobsFromSlot(); }

  if (live && playing){
    const st = quantizedStep();
    patterns[curPat].tracks[sel][st] = { v: i };
    scheduleSave();
    paintHeads();
  }
}

/* ------------------------------------------------------------ PATTERN */
/* Holding PATTERN and pressing several keys builds a chain, exactly as the
   hardware does. When the mode is merely latched, each press is a plain
   single selection instead — otherwise a second tap would silently turn a
   pattern change into a two-bar song. */
function patternKey(i){
  const chaining = isHeld('pattern') && chainBuilding;
  if (chaining && chain.length < MAX_CHAIN){
    chain.push(i);
    msg('chain — ' + chain.length + ' bars');
  } else if (chaining){
    msg('chain is full (' + MAX_CHAIN + ')');
  } else {
    chain = [i];
    chainBuilding = true;
    chainPos = 0;
    if (!playing) curPat = i;
    msg('pattern ' + (i + 1));
  }
  updateChainLabel();
  renderGrid();
  scheduleSave();
}

/* -------------------------------------------------------------- WRITE */
function writeKey(i, el){
  const pat = patterns[curPat];
  if (playing){
    // punch in: the key is a note, quantized to the nearest step
    const st = quantizedStep();
    const s = slots[sel];
    if (s.type === 'drum') lastSlice = i; else lastNote = i;
    pat.tracks[sel][st] = { v: i };
    trig(sel, actx.currentTime + 0.005, i);
    flash(el);
    msg('step ' + (st + 1) + ' ← ' + noteName(i));
  } else {
    // step mode: the key is a step, toggled on and off
    const cur = pat.tracks[sel][i];
    pat.tracks[sel][i] = cur == null ? { v: slots[sel].type === 'drum' ? lastSlice : lastNote } : null;
    flash(el);
  }
  renderGrid();
  scheduleSave();
}

/* ----------------------------------------------------------------- FX */
function fxKey(i, el){
  fxOn(i);
  el.classList.add('act');
  if (writeArmed() && playing){
    patterns[curPat].fx[quantizedStep()] = i;
    msg(i === 15 ? 'fx cleared at step' : 'saved ' + FX_NAMES[i]);
    scheduleSave();
  } else {
    msg(FX_NAMES[i] + ' — ' + FX_HINTS[i]);
  }
  renderGrid();
}

/* ---------------------------------------------------------------- REC */
let recIntent = null;
let micReleaseTimer = null;
let micArmTimer = null;

/* Ask for the microphone and report what happens where it can be seen.
   The old code only wrote failures into the warning box inside the sample
   card, which on a phone is well below the fold — so a refusal looked
   identical to a hang. */
function armMicWithFeedback(){
  if (micActive()){ warn(''); msg('hold a key to sample'); return; }
  msg('opening the microphone…');
  clearTimeout(micArmTimer);
  micArmTimer = setTimeout(() => {
    if (!micActive() && mode === 'rec'){
      msg('no answer from the microphone — tap REC again');
      warn('Safari never answered the microphone request. Tap <b>REC</b> again, ' +
           'or reload the page. If no permission prompt appeared, open <b>aA</b> in ' +
           'the address bar → <b>Website Settings</b> → <b>Microphone</b> → <b>Ask</b>, ' +
           'then reload.');
    }
  }, 8000);

  return armMic()
    .then(() => {
      clearTimeout(micArmTimer);
      warn('');
      if (mode === 'rec') msg('hold a key to sample');
      return true;
    })
    .catch(err => {
      clearTimeout(micArmTimer);
      showMicError(err);
      return false;
    });
}

function recKeyDown(i){
  if (memFreeFor(i) < 0.1){ msg('memory full — delete a sound'); return; }
  recIntent = i;

  if (micActive()){ beginRec(i); return; }

  // not armed yet — this tap is itself a fresh user gesture, so try again and
  // start the moment it is ready, provided the key is still held
  armMicWithFeedback().then(ok => {
    if (ok && recIntent === i) beginRec(i);
    else if (!ok) recIntent = null;
    renderGrid();
  });
  renderGrid();
}

function beginRec(i){
  if (startRec(i)){ renderGrid(); msg('sampling into ' + slotName(i) + '…'); }
  else { msg('could not start recording'); recIntent = null; }
}

function recKeyUp(i){
  if (recIntent !== i) return;
  recIntent = null;
  if (recActiveSlot() == null){
    // released before the microphone came up
    if (micActive()) msg('too short — hold the key down');
    renderGrid();
    return;
  }
  // the capture node flushes asynchronously, so the take lands a moment later
  stopRec().then(r => {
    if (r === 'ok'){
      invalidatePeaks();
      lastSlice = 0;
      selectSlot(i);
      releaseLatch();
      msg('sampled ' + slotName(i) + ' — ' + slots[i].buffer.duration.toFixed(2) + 's');
      scheduleSave();
    } else if (r === 'short'){
      msg('too short — hold the key down');
    }
    renderGrid();
    updateMem();
  });
}
const MIC_ERRORS = {
  NotAllowedError: {
    lcd: 'microphone blocked for this site',
    warn: 'Safari is refusing the microphone for this page. Tap <b>aA</b> in the ' +
          'address bar → <b>Website Settings</b> → <b>Microphone</b> → <b>Allow</b>, ' +
          'then reload. A system-wide permission in Settings is not enough — Safari ' +
          'also keeps a per-site one.'
  },
  NotFoundError: {
    lcd: 'no microphone found',
    warn: 'No audio input device is available on this device.'
  },
  NotReadableError: {
    lcd: 'microphone is busy elsewhere',
    warn: 'Another app or tab is holding the microphone. Close it and tap <b>REC</b> again.'
  },
  OverconstrainedError: {
    lcd: 'microphone settings unsupported',
    warn: 'This microphone rejected every capture format offered. Please report this ' +
          'along with your device and iOS version.'
  },
  InsecureContextError: {
    lcd: 'microphone needs https',
    warn: 'Microphone capture needs a secure context. Open the page over <code>https</code>, ' +
          'or serve it on <code>localhost</code>.'
  },
  NotSupportedError: {
    lcd: 'this browser cannot record',
    warn: 'This browser does not expose <code>getUserMedia</code>. Everything else works — ' +
          'empty slots play synth voices.'
  },
  InvalidStateError: {
    lcd: 'audio session refused the mic',
    warn: 'The audio session would not accept a microphone. This is usually iOS ' +
          'switching the audio hardware underneath the page — reload and try REC ' +
          'again. If it keeps happening, please report it with your iOS version.'
  }
};

function showMicError(err){
  if (err && err.name === 'AbortError') return;      // we cancelled it ourselves
  const name = (err && err.name) || 'Error';
  const where = err && err.stage ? ' @' + err.stage : '';
  const known = MIC_ERRORS[name];
  if (known){
    msg(known.lcd + where, 6000);
    warn(known.warn + (where ? ' <code>(' + name + where + ')</code>' : ''));
  } else {
    msg('microphone failed: ' + name + where, 6000);
    warn('The microphone could not be opened (<code>' + name + where + '</code>' +
         (err && err.message ? ': ' + String(err.message).slice(0, 120) : '') +
         '). Everything else works — empty slots play synth voices.');
  }
}

/* ---------------------------------------------------------------- BPM */
function volumeKey(i){
  setMaster((i + 1) / 16);
  masterS.value = Math.round(master * 100);
  paintRange(masterS);
  $('masterV').textContent = Math.round(master * 100);
  msg('volume ' + Math.round(master * 100));
  renderGrid();
  scheduleSave();
}

/* ====================================================== slot selection */
function slotName(i){ return (i < 8 ? 'M' : 'D') + (i + 1); }
function noteName(v){
  return slots[sel].type === 'drum' ? 'slice ' + (v + 1) : NOTE_NAMES[v];
}
function updateNoteLabel(){
  noteLbl.textContent = slots[sel].type === 'drum' ? 'S' + (lastSlice + 1) : NOTE_NAMES[lastNote];
}

function selectSlot(i){
  sel = i;
  lastSlice = Math.min(lastSlice, 15);
  invalidatePeaks();
  slotLbl.textContent = slotName(i);
  slotType.textContent = slots[i].type === 'drum' ? '16 slices' : 'chromatic';
  sndLbl.textContent = slotName(i);
  updateNoteLabel();
  syncKnobsFromSlot();
  drawWave();
  renderGrid();
}

/* ============================================================== knobs */
function pct(v){ return Math.round(v * 100) + '%'; }
function filterLabel(v){
  if (filterIsOpen(v, 0)) return 'open';
  const f = filterFreq(v);
  return f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f) + '';
}

const KNOB_DEFS = {
  tone: {
    a: { key:'tune', name:'A · tune', min:-12, max:12, step:1, def:0, center:true,
         format:v => (v > 0 ? '+' : '') + v, tag:() => '' },
    b: { key:'vol', name:'B · volume', min:0, max:1, step:0.01, def:0.9,
         format:v => String(Math.round(v * 100)), tag:() => '' }
  },
  filter: {
    a: { key:'cut', name:'A · filter', min:0, max:1, step:0.01, def:0.5, center:true,
         format:filterLabel,
         tag:v => filterIsOpen(v, 0) ? '' : (v < FILTER_OPEN ? 'lo' : 'hi') },
    b: { key:'res', name:'B · resonance', min:0, max:1, step:0.01, def:0,
         format:v => String(Math.round(v * 100)), tag:() => '' }
  },
  trim: {
    a: { key:'start', name:'A · start', min:0, max:1, step:0.002, def:0,
         format:pct, tag:() => '' },
    b: { key:'len', name:'B · length', min:0, max:1, step:0.002, def:1,
         format:pct, tag:() => '' }
  }
};

function readParam(key){
  const s = slots[sel];
  if (key === 'start') return activeRegion().start;
  if (key === 'len')   return activeRegion().len;
  return s[key];
}
function writeParam(key, v){
  const s = slots[sel];
  if (key === 'start'){ const r = activeRegion(); setRegion(v, r.start + r.len - v); drawWave(); return; }
  if (key === 'len'){   const r = activeRegion(); setRegion(r.start, v); drawWave(); return; }
  s[key] = v;
  if (key === 'cut' || key === 'res') drawWave();
}

let knobA = null, knobB = null, knobGesture = false;

function knobChanged(def, v){
  // hold WRITE while playing to lock the value to the current step
  if (writeArmed() && playing && PAGE_SPEC[page].lock){
    const st = quantizedStep();
    const pat = patterns[curPat];
    const cell = pat.tracks[sel][st] || (pat.tracks[sel][st] = { v: slots[sel].type === 'drum' ? lastSlice : lastNote });
    cell[def.key] = v;
    msg('locked ' + def.key + ' at step ' + (st + 1));
    paintHeads();
  } else {
    writeParam(def.key, v);
  }
  scheduleSave();
}

function buildKnobs(){
  const mk = (el, side) => {
    // The knobs are built once and reconfigured on every page change, so the
    // handler has to read the definition when it fires. Capturing it here
    // would nail both knobs to whatever page was current at boot.
    const def = KNOB_DEFS[page][side];
    return makeKnob(el, Object.assign({}, def, {
      def: def.def,
      onInput: v => knobChanged(KNOB_DEFS[page][side], v),
      onGesture: on => { knobGesture = on; }
    }));
  };
  knobA = mk($('knobA'), 'a');
  knobB = mk($('knobB'), 'b');
  syncKnobsFromSlot();
}

function syncKnobsFromSlot(){
  if (!knobA) return;
  const da = KNOB_DEFS[page].a, db = KNOB_DEFS[page].b;
  knobA.reconfigure(Object.assign({}, da, { value: readParam(da.key) }));
  knobB.reconfigure(Object.assign({}, db, { value: readParam(db.key) }));
  const lockable = PAGE_SPEC[page].lock && writeArmed() && playing;
  knobA.setLocked(lockable);
  knobB.setLocked(lockable);
}

function setPage(p){
  page = p;
  document.querySelectorAll('.pg').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  syncKnobsFromSlot();
  drawWave();
}
document.querySelectorAll('.pg').forEach(b => {
  b.addEventListener('click', () => setPage(b.dataset.page));
});

/* ========================================================= grid render */
function renderGrid(){
  const s = slots[sel];
  const pat = patterns[curPat];

  keyEls.forEach((el, i) => {
    el.className = 'key';
    const lab = el.querySelector('.klabel');
    const sub = el.querySelector('.ksub');
    let t = '', st = '';

    switch (mode){
      case 'keys':
        t = s.type === 'drum' ? 'S' + (i + 1) : NOTE_NAMES[i];
        if (s.type === 'drum' && i === lastSlice) el.classList.add('sel', 'drum');
        break;

      case 'sound':
        t = slotName(i);
        el.classList.add(i < 8 ? 'mel' : 'drum');
        if (slots[i].buffer) el.classList.add('loaded');
        if (i === sel) el.classList.add('sel');
        st = slots[i].buffer ? slots[i].buffer.duration.toFixed(1) + 's' : 'synth';
        break;

      case 'pattern': {
        t = 'P' + (i + 1);
        if (patternHasContent(i)) el.classList.add('loaded');
        if (i === curPat) el.classList.add('sel');
        const n = chain.filter(c => c === i).length;
        if (n) st = n > 1 ? '×' + n : 'in chain';
        break;
      }

      case 'write':
        if (playing){
          t = s.type === 'drum' ? 'S' + (i + 1) : NOTE_NAMES[i];
          st = 'punch';
        } else {
          t = String(i + 1);
          const cell = pat.tracks[sel][i];
          if (cell) el.classList.add('on');
          if (hasLock(cell)) st = 'lock';
          else if (cell && s.type === 'mel') st = NOTE_NAMES[cell.v];
          else if (cell && s.type === 'drum') st = 'S' + (cell.v + 1);
          if (i === drawStepIx && playing) el.classList.add('head');
        }
        break;

      case 'fx':
        t = FX_NAMES[i];
        el.classList.add('fxkey');
        if (fxIsActive(i)) el.classList.add('act');
        if (pat.fx.includes(i)) el.classList.add('saved');
        break;

      case 'rec':
        t = slotName(i);
        el.classList.add(i < 8 ? 'mel' : 'drum');
        if (slots[i].buffer) el.classList.add('loaded');
        if (recActiveSlot() === i || (recIntent === i && !micActive())) el.classList.add('recing');
        st = recIntent === i && !micActive() ? 'wait…' : (slots[i].buffer ? 'replace' : 'empty');
        break;

      case 'bpm':
        t = String(i + 1);
        if ((i + 1) / 16 <= master + 0.001) el.classList.add('on');
        st = i === 15 ? 'max' : (i === 0 ? 'min' : '');
        break;
    }
    lab.textContent = t;
    sub.textContent = st;
  });
  paintHeads();
}

function paintHeads(){
  const track = patterns[curPat].tracks[sel];
  const fxRow = patterns[curPat].fx;
  for (let i = 0; i < N; i++){
    const d = dotEls[i];
    d.classList.toggle('set', track[i] != null || fxRow[i] != null);
    d.classList.toggle('lock', hasLock(track[i]));
    d.classList.toggle('head', i === drawStepIx);
    if (mode === 'write' && !playing) continue;
    keyEls[i].classList.toggle('head', mode === 'write' && i === drawStepIx && playing);
  }
}

/* ============================================================ LCD bits */
function updateMem(){
  const free = memFree();
  const f = free / MEM_SECONDS;
  memFill.style.width = (f * 100).toFixed(1) + '%';
  memVal.textContent = free.toFixed(1);
  memFill.parentElement.classList.toggle('low', f < 0.25 && f > 0.02);
  memFill.parentElement.classList.toggle('full', f <= 0.02);
}
function updateChainLabel(){
  chainLbl.textContent = chain.length > 1
    ? 'chain ' + chain.map(c => c + 1).join('·').slice(0, 22)
    : 'chain ' + (chain[0] + 1);
  patLbl.textContent = (curPat + 1) + (chain.length > 1 ? '/' + chain.length : '');
}

/* ============================================================ transport */
playBtn.addEventListener('click', () => {
  ensureAudio();
  if (playing){ stopSeq(); } else { startSeq(); }
  playBtn.classList.toggle('on', playing);
  playBtn.innerHTML = playing ? '■&nbsp; STOP' : '▶&nbsp; PLAY';
  renderGrid();
});
liveBtn.addEventListener('click', () => {
  live = !live;
  liveBtn.classList.toggle('on', live);
  msg(live ? 'live record armed' : 'live record off');
});
clrBtn.addEventListener('click', () => {
  const pat = patterns[curPat];
  pat.tracks[sel].fill(null);
  msg('cleared ' + slotName(sel) + ' in pattern ' + (curPat + 1));
  renderGrid();
  scheduleSave();
});

/* The skin fills a slider track with background-size, which needs the
   value as a percentage — the one thing the stylesheet cannot work out on
   its own, so every path that moves a slider ends up here. */
function paintRange(el){
  const min = +el.min, max = +el.max;
  el.style.setProperty('--fill', ((el.value - min) / ((max - min) || 1)) * 100 + '%');
}
function paintRanges(){ [bpmS, swingS, masterS].forEach(paintRange); }

bpmS.addEventListener('input', e => {
  bpm = +e.target.value; paintRange(e.target); syncTempoLabels(); scheduleSave();
});
swingS.addEventListener('input', e => {
  swing = +e.target.value;
  $('swingV').textContent = swing;
  paintRange(e.target);
  scheduleSave();
});
masterS.addEventListener('input', e => {
  setMaster(e.target.value / 100);
  $('masterV').textContent = e.target.value;
  paintRange(e.target);
  scheduleSave();
});
tempoBtn.addEventListener('click', () => {
  tempoIx = (tempoIx + 1) % TEMPOS.length;
  bpm = TEMPOS[tempoIx].b;
  bpmS.value = bpm;
  syncTempoLabels();
  scheduleSave();
});
function syncTempoLabels(){
  paintRange(bpmS);
  $('bpmVal').textContent = bpm;
  $('bpmV2').textContent = bpm;
  $('tempoBpm').textContent = bpm;
  const m = TEMPOS.find(x => x.b === bpm);
  $('tempoName').textContent = m ? m.n : 'CUSTOM';
}

/* ======================================================= sound actions */
$('clrSamp').addEventListener('click', () => {
  const s = slots[sel];
  if (!s.buffer){ msg('slot is already empty'); return; }
  s.buffer = null; s.rev = null; s.start = 0; s.length = 1;
  resetSlices(s);
  invalidatePeaks();
  msg('deleted ' + slotName(sel));
  drawWave(); renderGrid(); updateMem(); syncKnobsFromSlot(); scheduleSave();
});
$('revBtn').addEventListener('click', () => {
  const s = slots[sel];
  if (!s.buffer){ msg('nothing to reverse'); return; }
  s.buffer = makeRev(s.buffer);
  s.rev = null;
  invalidatePeaks();
  msg('reversed ' + slotName(sel));
  drawWave(); scheduleSave();
});
$('resliceBtn').addEventListener('click', () => {
  const s = slots[sel];
  if (s.type !== 'drum'){ msg('slices are for drum slots 9–16'); return; }
  resetSlices(s);
  msg('re-sliced into 16 even pieces');
  drawWave(); syncKnobsFromSlot(); scheduleSave();
});

let copyArmed = false, copySource = null;
const copyBtn = $('copyBtn');

copyBtn.addEventListener('click', () => {
  if (copyArmed){ cancelCopy('copy cancelled'); return; }
  if (!slots[sel].buffer){ msg('nothing to copy'); return; }
  copyArmed = true;
  copySource = sel;
  copyBtn.classList.add('armed');
  latchedMod = 'sound';
  applyMode();
  msg('pick a destination slot');
});
function cancelCopy(why){
  copyArmed = false; copySource = null;
  copyBtn.classList.remove('armed');
  if (why) msg(why);
}
function doCopy(dstIx){
  const src = slots[copySource], dst = slots[dstIx];
  if (!src.buffer){ cancelCopy('source is empty'); return; }
  // buffers are shared by reference, so a copy costs no extra memory
  dst.buffer = src.buffer;
  dst.rev = null;
  dst.start = src.start; dst.length = src.length;
  dst.tune = src.tune; dst.vol = src.vol; dst.cut = src.cut; dst.res = src.res;
  dst.slices = src.slices ? src.slices.map(x => ({ s:x.s, l:x.l })) : null;
  const from = slotName(copySource), to = slotName(dstIx);
  cancelCopy(null);
  msg('copied ' + from + ' → ' + to);
  updateMem();
  scheduleSave();
}

/* ============================================================== guide
   Everything explanatory lives in one dialog instead of sitting in the
   interface all the time. Native <dialog> gives Esc, focus trapping and a
   backdrop for free. */
const guideEl = $('guide');

function openGuide(){
  if (!guideEl || guideEl.open) return;
  fxAllOff();
  if (typeof guideEl.showModal === 'function') guideEl.showModal();
  else guideEl.setAttribute('open', '');
}
function closeGuide(){
  if (!guideEl || !guideEl.open) return;
  if (typeof guideEl.close === 'function') guideEl.close();
  else guideEl.removeAttribute('open');
}
function guideOpen(){ return !!(guideEl && guideEl.open); }

$('guideBtn').addEventListener('click', openGuide);
$('guideClose').addEventListener('click', closeGuide);
// clicking the backdrop lands on the dialog element itself
guideEl.addEventListener('click', e => { if (e.target === guideEl) closeGuide(); });

/* ============================================================= UI loop */
let lastPat = -1, lastDrawStep = -2, rafRunning = false;

function uiLoop(){
  if (!actx){ rafRunning = false; return; }
  requestAnimationFrame(uiLoop);

  if (playing){
    while (queue.length && queue[0].time <= actx.currentTime){
      drawStepIx = queue.shift().step;
    }
  }
  if (drawStepIx !== lastDrawStep){ lastDrawStep = drawStepIx; paintHeads(); }
  if (curPat !== lastPat){
    lastPat = curPat;
    updateChainLabel();
    if (mode === 'pattern' || mode === 'write' || mode === 'fx') renderGrid();
    else paintHeads();
  }

  // level meter — recording level while sampling, output level otherwise
  const lvl = recActiveSlot() != null ? recPeakLevel() : meterLevel();
  lvlFill.style.width = Math.min(100, lvl * 130).toFixed(0) + '%';

  if (recActiveSlot() != null){
    const left = Math.max(0, memFreeFor(recActiveSlot()) - recSeconds());
    memVal.textContent = left.toFixed(1);
    memFill.style.width = (left / MEM_SECONDS * 100).toFixed(1) + '%';
  }
}
/* Called by ensureAudio — the loop can only run once there is a clock. */
function startUiLoop(){
  if (rafRunning) return;
  rafRunning = true;
  requestAnimationFrame(uiLoop);
}
