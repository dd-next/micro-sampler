/* ======================================================================
   16 punch-in effects
   ----------------------------------------------------------------------
   Effects are a set, not a single slot: several keys can be held at once
   and releasing one must not cancel the others. Every derived flag is
   recomputed from that set, so the engine can never end up in a state no
   held key accounts for.

   Held keys win over an effect saved in the pattern.
   ====================================================================== */

const heldFX  = new Set();      // fx indices under a finger right now
const fxAnchor = new Map();     // index → state captured when it was engaged
let   stepFX  = null;           // effect written into the pattern at this step

/* derived — read by the scheduler and the trigger */
let loopWindow = null;
let stutterSub = 0;
let octaveShift = 0;
let unison = 0;                 // 0 none, 1 detuned, 2 octave down
let reverseOn = false;
let quant68 = false;

let scratchMode = null;         // null | 'slow' | 'fast'
let scratchNodes = null;

function fxIsActive(i){ return heldFX.has(i) || stepFX === i; }
function fxActiveList(){ return heldFX.size ? [...heldFX] : (stepFX != null ? [stepFX] : []); }

/* Some effects need to remember where the transport was when they landed. */
function captureAnchor(i){
  switch (i){
    case 2:  return Math.floor(currentStep / 4) * 4;
    case 3:  return Math.floor(currentStep / 2) * 2;
    default: return null;
  }
}
function claimAnchor(i){ if (!fxAnchor.has(i)) fxAnchor.set(i, captureAnchor(i)); }
function dropAnchor(i){ if (!fxIsActive(i)) fxAnchor.delete(i); }

/* ------------------------------------------------------------- engaging */
function fxOn(i){
  ensureAudio();
  if (heldFX.has(i)) return;
  claimAnchor(i);
  heldFX.add(i);
  if (i === 13) currentStep = 0;       // retrigger snaps the transport back
  recomputeFX();
}
function fxOff(i){
  if (!heldFX.delete(i)) return;
  dropAnchor(i);
  recomputeFX();
}
function fxAllOff(){
  const was = [...heldFX];
  heldFX.clear();
  was.forEach(dropAnchor);
  recomputeFX();
}
/* Called by the scheduler when a step carries a saved effect. */
function setStepFX(i){
  if (stepFX === i) return;
  const old = stepFX;
  stepFX = i;
  if (i != null) claimAnchor(i);
  if (old != null) dropAnchor(old);
  recomputeFX();
}

/* ------------------------------------------------------------ recompute */
function recomputeFX(){
  loopWindow = null; stutterSub = 0; octaveShift = 0;
  unison = 0; reverseOn = false; quant68 = false;
  let wantScratch = null;

  for (const i of fxActiveList().sort((a, b) => a - b)){
    switch (i){
      case 0:  loopWindow = [0, 16]; break;
      case 1:  loopWindow = [0, 12]; break;
      case 2:  { const lo = fxAnchor.get(2) ?? 0; loopWindow = [lo, lo + 4]; break; }
      case 3:  { const lo = fxAnchor.get(3) ?? 0; loopWindow = [lo, lo + 2]; break; }
      case 4:  unison = 1; break;
      case 5:  unison = 2; break;
      case 6:  octaveShift = 12; break;
      case 7:  octaveShift = -12; break;
      case 8:  stutterSub = 4; break;
      case 9:  stutterSub = 3; break;
      case 10: wantScratch = 'slow'; break;
      case 11: wantScratch = 'fast'; break;
      case 12: quant68 = true; break;
      case 13: loopWindow = [0, 2]; break;
      case 14: reverseOn = true; break;
      case 15: break;                    // explicit "no effect"
    }
  }
  syncScratch(wantScratch);
}

/* ------------------------------------------------------------- scratch
   Driven by a diff so holding both scratch keys, or rolling from one to
   the other, can never strand a running oscillator. */
function syncScratch(want){
  if (want === scratchMode) return;
  stopScratch();
  scratchMode = want;
  if (want) startScratch(want === 'fast');
}

function startScratch(fast){
  ensureAudio();
  const s = slots[sel];
  const g = actx.createGain();
  const lfo = actx.createOscillator();
  const ld = actx.createGain();
  lfo.type = 'triangle';
  lfo.frequency.value = fast ? 8 : 4;
  g.connect(masterGain);

  if (s.buffer){
    const src = actx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    const dur = s.buffer.duration;
    src.loopStart = s.start * dur;
    src.loopEnd   = Math.max(src.loopStart + 0.02, (s.start + s.length) * dur);
    src.playbackRate.value = 1;
    ld.gain.value = 0.85;
    lfo.connect(ld); ld.connect(src.playbackRate);
    g.gain.value = 0.9 * master;
    src.connect(g);
    src.start(actx.currentTime, src.loopStart);
    lfo.start();
    scratchNodes = { src, lfo, g, ld };
  } else {
    const o = actx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 200;
    ld.gain.value = 170;
    lfo.connect(ld); ld.connect(o.frequency);
    g.gain.value = 0.22 * master;
    o.connect(g);
    o.start(); lfo.start();
    scratchNodes = { src:o, lfo, g, ld };
  }
}

function stopScratch(){
  if (!scratchNodes) return;
  const { src, lfo, g, ld } = scratchNodes;
  scratchNodes = null;
  scratchMode = null;
  try { src.stop(); } catch (e) { /* already stopped */ }
  try { lfo.stop(); } catch (e) { /* already stopped */ }
  // unhook on the next tick so the stop lands before the disconnect
  setTimeout(() => {
    [src, lfo, ld, g].forEach(n => { try { n.disconnect(); } catch (e) { /* gone */ } });
  }, 60);
}
