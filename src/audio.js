/* ======================================================================
   audio graph, synth fallback voices, sample playback
   ----------------------------------------------------------------------
   Every voice is built, played and torn down explicitly on the audio
   clock. Nothing is left connected to the master bus after it has run.
   ====================================================================== */

let actx = null, masterGain, comp, analyser, noiseBuf;
let meterData = null;
let offlineCtx = null;
let resumePromise = null;
let contextStale = false;   // a resume was tried and the output stayed dead
let heldTransport = null;   // where the loop was when the audio was handed back
let ctxGen = 0;             // how many contexts this page has been through

/* iOS is the only platform that takes the audio session away and does not
   give it back, and the handling below costs something everywhere else —
   a hidden desktop tab is expected to keep playing. */
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* Build an AudioBuffer without an AudioContext.
   iOS gives you a permanently silent context if one is constructed outside a
   user gesture, so restoring saved samples at page load must not create one.
   An OfflineAudioContext never touches the audio hardware, and AudioBuffers
   are not bound to the context that made them. */
function makeAudioBuffer(length, rate){
  if (actx) return actx.createBuffer(1, length, rate || actx.sampleRate);
  if (!offlineCtx){
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    offlineCtx = new OC(1, 1, Math.min(96000, Math.max(8000, rate || 44100)));
  }
  return offlineCtx.createBuffer(1, length, rate || offlineCtx.sampleRate);
}

/* Resume only from a user gesture when possible. Safari returns a promise
   here, so track it for the first voice and avoid an unhandled rejection when
   iOS is interrupted. A timeout lets a later gesture retry a stuck resume. */
function resumeAudio(){
  if (!actx || actx.state === 'running' || actx.state === 'closed') {
    return Promise.resolve(true);
  }
  if (resumePromise) return resumePromise;

  /* Safari also resolves resume() on a context that stays put, so the state
     afterwards is the answer, not the promise. A resume that does not take
     is remembered: from there only a new context can play anything. */
  const ctx = actx;
  const stalled = () => { if (actx === ctx) contextStale = true; };

  try {
    const attempt = Promise.resolve(ctx.resume()).then(() => ctx.state === 'running');
    const timeout = new Promise(resolve => {
      setTimeout(() => resolve(false), 1200);
    });
    resumePromise = Promise.race([attempt, timeout]).then(ok => {
      if (!ok){
        console.warn('AudioContext resume did not take', ctx.state);
        stalled();
      }
      resumePromise = null;
      return ok;
    }).catch(err => {
      console.warn('AudioContext resume failed', err);
      stalled();
      resumePromise = null;
      return false;
    });
  } catch (err){
    console.warn('AudioContext resume failed', err);
    stalled();
    return Promise.resolve(false);
  }
  return resumePromise;
}

/* A context that has been through an iOS interruption — a lock screen, a
   call, minutes in the background — often comes back reporting `running`
   while playing nothing, and resume() on it never settles. Replacing it is
   the only way out, and iOS only builds a working context inside a user
   gesture, which is what every caller of ensureAudio is. */
function reviveAudio(){
  // The capture graph belongs to the context being dropped. Letting go of
  // the microphone here means the next REC opens a live one instead of
  // recording silence into a context nothing can hear.
  if (typeof micActive === 'function' && micActive() &&
      typeof releaseMic === 'function') releaseMic();
  return rebuildAudio();
}

/* A stalled context is not always honest about it: the state reads
   `running` and the clock stands still, so every voice is scheduled for a
   time that never arrives. Only the clock itself gives that away. */
function checkClock(){
  const ctx = actx;
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  setTimeout(() => {
    if (actx !== ctx || ctx.state !== 'running') return;
    if (ctx.currentTime === t0){
      console.warn('AudioContext clock is not advancing');
      contextStale = true;
    }
  }, 400);
}

/* iOS audio sessions.
   `playback` is what stops the physical silent switch muting Web Audio — but
   it is an output-only session, and asking for the microphone while it is
   active fails with InvalidStateError. Recording needs `play-and-record`, so
   the type follows what the app is actually doing. */
function setAudioSession(type){
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type){
      navigator.audioSession.type = type;
      // iOS interrupts the running context when the session category changes.
      // Nothing else notices, so the output would simply go quiet from here.
      if (actx) resumeAudio();
      return true;
    }
  } catch (e) { /* not supported on this browser */ }
  return false;
}

/* Going to the background still holding a `playback` session is what wedges
   iOS: the session is interrupted by the lock screen and never comes back to
   this page. Not for a resumed context, not for a new one — not even for a
   reload, since the tab keeps the session that was wedged. Only a new tab
   plays again, which is no kind of fix.

   So the session is handed back before the page is put away. Nothing is
   holding it while the screen is off, there is no interruption to recover
   from, and the next tap takes a fresh one. */
function releaseAudio(){
  if (!actx) return;
  const wasPlaying = typeof playing !== 'undefined' && playing;
  heldTransport = wasPlaying ? { step: currentStep, pat: curPat, pos: chainPos } : null;
  if (wasPlaying && typeof stopSeq === 'function') stopSeq();
  if (typeof stopScratch === 'function') stopScratch();
  if (typeof micActive === 'function' && micActive() &&
      typeof releaseMic === 'function') releaseMic();

  const old = actx;
  actx = null; masterGain = null; comp = null; analyser = null; noiseBuf = null;
  resumePromise = null;
  contextStale = false;
  if (typeof slots !== 'undefined') slots.forEach(s => { s.rev = null; });
  revSynth.clear();
  try { old.close(); } catch (e) { /* already gone */ }
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'auto';
  } catch (e) { /* not supported on this browser */ }
}

/* Switching session type can change the hardware sample rate underneath a
   live AudioContext, which leaves it unusable. Start a clean one and rebuild
   the graph. AudioBuffers survive: they are not bound to a context. */
function rebuildAudio(){
  const old = actx;
  const wasPlaying = typeof playing !== 'undefined' && playing;
  const at = { step: currentStep, pat: curPat, pos: chainPos };
  if (wasPlaying && typeof stopSeq === 'function') stopSeq();
  if (typeof stopScratch === 'function') stopScratch();

  actx = null; masterGain = null; comp = null; analyser = null; noiseBuf = null;
  resumePromise = null;    // it was waiting on the context being thrown away
  contextStale = false;
  if (typeof slots !== 'undefined') slots.forEach(s => { s.rev = null; });
  revSynth.clear();
  if (old){ try { old.close(); } catch (e) { /* already gone */ } }

  const next = ensureAudio();
  if (wasPlaying && typeof startSeq === 'function'){
    startSeq();
    // pick the loop up where it stopped, not at the top of the pattern
    currentStep = at.step; curPat = at.pat; chainPos = at.pos;
  }
  return next;
}

function ensureAudio(){
  if (actx){
    if (contextStale || actx.state === 'interrupted' || actx.state === 'closed'){
      return reviveAudio();
    }
    resumeAudio();
    if (typeof startUiLoop === 'function') startUiLoop();
    return actx;
  }
  setAudioSession('playback');

  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC({ latencyHint:'interactive' });

  masterGain = actx.createGain();
  masterGain.gain.value = master;

  comp = actx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value      = 20;
  comp.ratio.value     = 4;
  comp.attack.value    = 0.003;
  comp.release.value   = 0.15;

  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  meterData = new Uint8Array(analyser.frequencyBinCount);

  masterGain.connect(comp);
  comp.connect(analyser);
  comp.connect(actx.destination);

  ctxGen++;

  const len = actx.sampleRate * 2;
  noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

  watchContextState();
  unlockIOS();
  resumeAudio();
  if (typeof startUiLoop === 'function') startUiLoop();

  // the loop was left running when the session was handed back
  if (heldTransport && typeof startSeq === 'function'){
    const at = heldTransport;
    heldTransport = null;
    startSeq();
    currentStep = at.step; curPat = at.pat; chainPos = at.pos;
  }
  return actx;
}

/* Safari has a fourth state beyond running/suspended/closed: `interrupted`,
   entered on a phone call, a session change, or the app losing audio focus.
   It never leaves on its own. Only that state is auto-resumed — a deliberate
   suspend is left alone. */
function watchContextState(){
  if (!actx) return;
  actx.onstatechange = () => {
    if (actx && actx.state === 'interrupted') resumeAudio();
  };
}

/* iOS only really wakes the output up once something has been played through
   it from inside a user gesture. One silent sample is enough. */
function unlockIOS(){
  try {
    const b = actx.createBuffer(1, 1, actx.sampleRate);
    const s = actx.createBufferSource();
    s.buffer = b;
    s.connect(actx.destination);
    s.start(0);
  } catch (e) { /* nothing to unlock */ }
}

/* Mobile browsers suspend the context when the tab goes to the background
   and do not always resume it on return. Coming back is not proof of life
   either, so the clock is checked afterwards; a context that fails either
   test is left for the next tap to replace, since that tap is a gesture and
   this event is not. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden'){
    if (IS_IOS) releaseAudio();
    return;
  }
  if (!actx) return;
  resumeAudio().then(ok => { if (ok) checkClock(); });
});
window.addEventListener('pagehide', () => { if (IS_IOS) releaseAudio(); });

/* Restored from the page cache — the session was never reloaded, it was
   frozen and thawed. Nothing built before the freeze plays again on iOS. */
window.addEventListener('pageshow', e => {
  if (e.persisted && actx) contextStale = true;
});

/* On iOS, pointerdown/touchstart has not been a reliable Web Audio unlock
   event across Safari versions. The compatibility click/touchend path gives
   a suspended context another trusted user gesture without changing the
   low-latency pointer path used by the pads. */
['touchend', 'click'].forEach(type => {
  document.addEventListener(type, () => {
    if (!actx || contextStale || actx.state !== 'running') ensureAudio();
  }, { capture:true, passive:true });
});

function setMaster(v){
  master = v;
  if (masterGain) masterGain.gain.setTargetAtTime(v, actx.currentTime, 0.01);
}

/* Peak level 0..1 for the LCD meter. */
function meterLevel(){
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(meterData);
  let peak = 0;
  for (let i = 0; i < meterData.length; i++){
    const v = Math.abs(meterData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  return peak;
}

/* ---------------------------------------------------------------- utils */
function noise(){
  const s = actx.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

/* Percussive envelope. `atk` defaults to a 5 ms click; a longer one turns
   the same helper into a swell for the sustained voices.
   `pk` is clamped away from zero: exponentialRampToValueAtTime(0) throws a
   RangeError, and a throw inside the scheduler stalls the transport. */
function env(g, t, pk, decay, atk){
  const peak = Math.max(0.0002, pk);
  const a = atk === undefined ? 0.005 : atk;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(decay, a + 0.01));
}

/* --------------------------------------------------------- filter model
   One knob sweeps from a shut low-pass, through fully open at the centre,
   to a shut high-pass. A second knob adds resonance.                    */
const FILTER_OPEN = 0.5;

function filterIsOpen(cut, res){
  return Math.abs(cut - FILTER_OPEN) < 0.012 && res < 0.02;
}
function filterFreq(cut){
  if (cut <= FILTER_OPEN){
    const t = cut / FILTER_OPEN;                 // 0..1
    return 120 * Math.pow(20000 / 120, t);       // 120 Hz → 20 kHz
  }
  const t = (cut - FILTER_OPEN) / FILTER_OPEN;   // 0..1
  return 20 * Math.pow(8000 / 20, t);            // 20 Hz → 8 kHz
}
function makeFilter(cut, res){
  const f = actx.createBiquadFilter();
  f.type = cut <= FILTER_OPEN ? 'lowpass' : 'highpass';
  f.frequency.value = Math.min(filterFreq(cut), actx.sampleRate / 2 - 100);
  f.Q.value = 0.7 + res * 13;
  return f;
}

/* A per-voice chain: [input] → (filter) → gain → master.
   `release()` unhooks it from the bus so nothing accumulates.          */
function makeChain(vol, cut, res){
  const g = actx.createGain();
  // resonance adds a lot of level at the peak — trim it back
  g.gain.value = Math.max(0, vol) * (1 - res * 0.35);
  g.connect(masterGain);

  let input = g, filt = null;
  if (!filterIsOpen(cut, res)){
    filt = makeFilter(cut, res);
    filt.connect(g);
    input = filt;
  }
  return {
    input, gain:g,
    release(){
      try { g.disconnect(); } catch (e) { /* already gone */ }
      if (filt) { try { filt.disconnect(); } catch (e) { /* already gone */ } }
    }
  };
}

/* Every voice that is still sounding. A hit played by hand outlives the
   step that fired it, so STOP needs a list of what is running rather than
   only the scheduler's future notes. */
const liveVoices = new Set();

/* Tear the chain down once the source that feeds it has finished. */
function autoRelease(src, chain, fallbackSeconds){
  let done = false;
  const voice = { src, chain };
  const kill = () => {
    if (done) return;
    done = true;
    liveVoices.delete(voice);
    chain.release();
  };
  liveVoices.add(voice);
  src.onended = kill;
  // onended is not guaranteed to fire if the context is closed mid-flight
  setTimeout(kill, Math.max(0.2, fallbackSeconds) * 1000 + 400);
}

/* Silence the instrument. Each voice is faded over a few milliseconds
   instead of cut dead, so stopping in the middle of a sample does not
   click; the stop itself then fires onended and releases the chain.
   A voice scheduled for later is stopped before its start time, which
   means it never sounds at all. */
function stopAllVoices(){
  if (!actx) return;
  const t = actx.currentTime;
  liveVoices.forEach(v => {
    try {
      const g = v.chain.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.0001, t + 0.012);
    } catch (e) { /* chain already released */ }
    try { v.src.stop(t + 0.02); } catch (e) { /* already stopped */ }
  });
}

/* ------------------------------------------------- synth fallback voices
   Used by any slot that has no sample yet, so the instrument is playable —
   and varied — the moment it loads. Each melodic slot has its own timbre
   and each drum slot its own kit, so an empty machine is still worth
   playing. `r` is the tuning ratio, `d` scales the decay.              */

/* --------------------------------------------------------- drum voices */
function sKick(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(150 * r, t);
  o.frequency.exponentialRampToValueAtTime(48 * r, t + 0.11 * d);
  env(g, t, v, 0.35 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.4 * d);
  return { src:o, dur:0.4 * d };
}
function sSnare(t, v, into, r, d){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1800 * r;
  env(g, t, v * 0.8, 0.18 * d);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.2 * d);
  return { src:s, dur:0.2 * d };
}
function sHatC(t, v, into, r, d){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 7000 * r;
  env(g, t, v * 0.5, 0.05 * d);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.06 * d);
  return { src:s, dur:0.06 * d };
}
function sHatO(t, v, into, r, d){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 7000 * r;
  env(g, t, v * 0.5, 0.3 * d);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.32 * d);
  return { src:s, dur:0.32 * d };
}
function sClap(t, v, into, r, d){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1200 * r;
  env(g, t, v * 0.7, 0.16 * d);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.18 * d);
  return { src:s, dur:0.18 * d };
}
function sTom(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(160 * r, t);
  o.frequency.exponentialRampToValueAtTime(90 * r, t + 0.15 * d);
  env(g, t, v * 0.7, 0.25 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.3 * d);
  return { src:o, dur:0.3 * d };
}
function sRim(t, v, into, r, d){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1700 * r; bp.Q.value = 3;
  env(g, t, v * 0.5, 0.04 * d);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.05 * d);
  return { src:s, dur:0.05 * d };
}
function sCow(t, v, into, r, d){
  let last = null;
  [540, 800].forEach(f => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = f * r;
    env(g, t, v * 0.25, 0.2 * d);
    o.connect(g).connect(into);
    o.start(t); o.stop(t + 0.22 * d);
    last = o;
  });
  return { src:last, dur:0.22 * d };
}
/* A short kick with the click left in — sits on top of a pattern rather
   than under it. */
function sKick2(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(320 * r, t);
  o.frequency.exponentialRampToValueAtTime(60 * r, t + 0.05 * d);
  env(g, t, v * 0.9, 0.16 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.2 * d);
  return { src:o, dur:0.2 * d };
}
/* Brushed snare: noise only, no body. */
function sSnare2(t, v, into, r, d){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 3000 * r;
  env(g, t, v * 0.6, 0.1 * d, 0.02);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.14 * d);
  return { src:s, dur:0.14 * d };
}
/* Metal: six inharmonic squares through a band-pass, the classic 808
   cymbal trick. `hi` picks ride (tight) or crash (open). */
function metal(t, v, into, r, d, hi, decay){
  const bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = hi * r; bp.Q.value = 1.4;
  env(g, t, v * 0.22, decay * d);
  bp.connect(g).connect(into);
  let last = null;
  [1, 1.41, 1.68, 2.11, 2.72, 3.14].forEach(m => {
    const o = actx.createOscillator();
    o.type = 'square'; o.frequency.value = 320 * m * r;
    o.connect(bp);
    o.start(t); o.stop(t + decay * d + 0.02);
    last = o;
  });
  return { src:last, dur:decay * d + 0.02 };
}
function sRide(t, v, into, r, d){  return metal(t, v, into, r, d, 6000, 0.5); }
function sCrash(t, v, into, r, d){ return metal(t, v, into, r, d, 4200, 1.2); }
function sCongaH(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(420 * r, t);
  o.frequency.exponentialRampToValueAtTime(360 * r, t + 0.08 * d);
  env(g, t, v * 0.6, 0.18 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.22 * d);
  return { src:o, dur:0.22 * d };
}
function sCongaL(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(260 * r, t);
  o.frequency.exponentialRampToValueAtTime(210 * r, t + 0.1 * d);
  env(g, t, v * 0.6, 0.26 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.3 * d);
  return { src:o, dur:0.3 * d };
}
/* Shaker: noise with a soft attack, so it reads as a shake not a hit. */
function sShaker(t, v, into, r, d){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 9000 * r;
  env(g, t, v * 0.45, 0.1 * d, 0.025);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.14 * d);
  return { src:s, dur:0.14 * d };
}
/* Wood block / zap: a fast pitch drop, useful as an accent. */
function sZap(t, v, into, r, d){
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(900 * r, t);
  o.frequency.exponentialRampToValueAtTime(160 * r, t + 0.06 * d);
  env(g, t, v * 0.3, 0.08 * d);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.1 * d);
  return { src:o, dur:0.1 * d };
}

/* Sixteen voices, one per key, so the top half of a drum slot is no
   longer a repeat of the bottom half. */
const SDRUM = [sKick, sSnare, sHatC, sHatO, sClap, sTom, sRim, sCow,
               sKick2, sSnare2, sRide, sCrash, sCongaH, sCongaL, sShaker, sZap];

/* One kit per drum slot. `rot` rotates which voice each key gets, `r`
   tunes the whole kit and `d` stretches or shortens every decay, so the
   eight slots read as eight machines rather than one copied eight times. */
const KITS = [
  { name:'909',   rot:0,  r:1.00, d:1.00 },
  { name:'808',   rot:0,  r:0.80, d:1.80 },
  { name:'TIGHT', rot:0,  r:1.18, d:0.50 },
  { name:'ROOM',  rot:8,  r:0.94, d:1.30 },
  { name:'PERC',  rot:12, r:1.00, d:1.00 },
  { name:'HI',    rot:2,  r:1.35, d:0.75 },
  { name:'DEEP',  rot:0,  r:0.62, d:2.20 },
  { name:'WIRE',  rot:6,  r:1.45, d:0.45 }
];
const kitOf = i => KITS[((i - 8) % KITS.length + KITS.length) % KITS.length];

/* ------------------------------------------------------ melodic voices
   One per melodic slot. Each takes the note frequency and plays it into
   the slot's own filter/gain chain.                                    */

/* Two oscillators an interval apart, summed — the backbone of most of
   the voices below. */
function stack(specs, t, v, into, decay, atk){
  const g = actx.createGain();
  env(g, t, v, decay, atk);
  g.connect(into);
  let last = null;
  specs.forEach(sp => {
    const o = actx.createOscillator();
    o.type = sp.type;
    o.frequency.value = sp.f;
    if (sp.detune) o.detune.value = sp.detune;
    const og = actx.createGain();
    og.gain.value = sp.g;
    o.connect(og).connect(g);
    o.start(t); o.stop(t + decay + 0.05);
    last = o;
  });
  return { src:last, dur:decay + 0.05 };
}

/* Sine carrier with a sine modulator on its frequency — bells, e-pianos
   and anything else that needs partials a filter cannot give you. */
function fm(freq, ratio, depth, t, v, into, decay){
  const car = actx.createOscillator(), g = actx.createGain();
  const mod = actx.createOscillator(), md = actx.createGain();
  car.frequency.value = freq;
  mod.frequency.value = freq * ratio;
  md.gain.setValueAtTime(freq * depth, t);
  md.gain.exponentialRampToValueAtTime(freq * depth * 0.02, t + decay);
  mod.connect(md).connect(car.frequency);
  env(g, t, v, decay);
  car.connect(g).connect(into);
  car.start(t); car.stop(t + decay + 0.05);
  mod.start(t); mod.stop(t + decay + 0.05);
  return { src:car, dur:decay + 0.05 };
}

function mPluck(f, t, v, into){
  const o = actx.createOscillator(), lp = actx.createBiquadFilter(), g = actx.createGain();
  o.type = 'triangle'; o.frequency.value = f;
  lp.type = 'lowpass'; lp.frequency.value = 3200;
  env(g, t, v * 0.9, 0.3);
  o.connect(lp).connect(g).connect(into);
  o.start(t); o.stop(t + 0.35);
  return { src:o, dur:0.35 };
}
/* Sub sine plus a filtered saw an octave down — sits under the drums. */
function mBass(f, t, v, into){
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, t);
  lp.frequency.exponentialRampToValueAtTime(220, t + 0.3);
  lp.connect(into);
  return stack([{ type:'sine', f:f / 2, g:0.9 },
                { type:'sawtooth', f:f / 2, g:0.35 }], t, v * 0.55, lp, 0.45);
}
function mEPiano(f, t, v, into){ return fm(f, 2, 2.2, t, v * 0.5, into, 0.5); }
function mBell(f, t, v, into){   return fm(f, 3.51, 3.4, t, v * 0.4, into, 1.2); }
/* Drawbar organ: three sines, no decay to speak of. */
function mOrgan(f, t, v, into){
  return stack([{ type:'sine', f:f, g:0.7 },
                { type:'sine', f:f * 2, g:0.4 },
                { type:'sine', f:f * 3, g:0.22 }], t, v * 0.42, into, 0.4, 0.012);
}
/* Detuned saw pair through a closing filter — the lead voice. */
function mSaw(f, t, v, into){
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 6;
  lp.frequency.setValueAtTime(5200, t);
  lp.frequency.exponentialRampToValueAtTime(700, t + 0.35);
  lp.connect(into);
  return stack([{ type:'sawtooth', f:f, g:0.5, detune:-7 },
                { type:'sawtooth', f:f, g:0.5, detune:7 }], t, v * 0.5, lp, 0.4);
}
/* Slow attack, long tail — chords rather than hits. */
function mStrings(f, t, v, into){
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2600;
  lp.connect(into);
  return stack([{ type:'sawtooth', f:f, g:0.4, detune:-9 },
                { type:'sawtooth', f:f, g:0.4, detune:9 },
                { type:'sawtooth', f:f * 2, g:0.15 }], t, v * 0.6, lp, 0.9, 0.09);
}
/* One square, gone in a flash. */
function mBlip(f, t, v, into){
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square'; o.frequency.value = f;
  env(g, t, v * 0.5, 0.09);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.12);
  return { src:o, dur:0.12 };
}

const SMEL = [mPluck, mBass, mEPiano, mOrgan, mSaw, mBell, mStrings, mBlip];
const MEL_NAMES = ['PLUCK', 'BASS', 'E.PIANO', 'ORGAN', 'SAW', 'BELL',
                   'STRINGS', 'BLIP'];

/* What an empty slot is playing, for the pads and the display. */
function voiceName(i){
  return i < 8 ? MEL_NAMES[i % 8] : 'KIT ' + kitOf(i).name;
}
function voiceDesc(i){
  return i < 8 ? MEL_NAMES[i % 8] + ' voice' : kitOf(i).name + ' kit';
}

const noteFreq = n => 261.63 * Math.pow(2, n / 12);

/* ----------------------------------------------------- reversed buffers */
function makeRev(buf){
  const ch = buf.numberOfChannels;
  const rb = actx.createBuffer(ch, buf.length, buf.sampleRate);
  for (let c = 0; c < ch; c++){
    const s = buf.getChannelData(c), d = rb.getChannelData(c), n = buf.length;
    for (let i = 0; i < n; i++) d[i] = s[n - 1 - i];
  }
  return rb;
}
function getRev(s){
  if (!s.rev) s.rev = makeRev(s.buffer);
  return s.rev;
}

/* ------------------------------------------------ reversed synth voices
   A synth voice is generated, not sampled, so there is no buffer to flip.
   Render one into an OfflineAudioContext, reverse what comes back and keep
   it: the same key on the same slot renders identically every time, so one
   render serves every later hit. The first hit of a voice still sounds
   forwards — its render is in flight — and everything after it is reversed.
   Without this, REVERSE was silent on every empty slot, which is most of
   the machine until samples are loaded. */
const revSynth = new Map();          // voice key → AudioBuffer, or REV_PENDING
const REV_PENDING    = 'rendering';
const REV_CACHE_MAX  = 96;
const REV_RENDER_MAX = 4;            // seconds; longer than the longest voice

function revSynthBuffer(key, build){
  const have = revSynth.get(key);
  if (have) return have === REV_PENDING ? null : have;

  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OC) return null;

  const rate = actx.sampleRate;
  let off;
  try { off = new OC(1, Math.ceil(REV_RENDER_MAX * rate), rate); }
  catch (e){ console.warn('reverse render unavailable', e); return null; }

  // the voice builders reach for the global context, so lend them this one
  const live = actx;
  let dur;
  try {
    actx = off;
    dur = build(off.destination).dur;
  } catch (e){
    console.warn('reverse render failed', e);
    return null;
  } finally {
    actx = live;
  }

  revSynth.set(key, REV_PENDING);
  off.startRendering().then(buf => {
    if (revSynth.size > REV_CACHE_MAX) revSynth.clear();
    revSynth.set(key, revHead(buf, dur));
  }).catch(err => {
    console.warn('reverse render failed', err);
    revSynth.delete(key);
  });
  return null;
}

/* The first `seconds` of a rendered voice, flipped. Trimming before the
   flip matters: reversing the whole render would put its trailing silence
   at the front and the hit would arrive late. */
function revHead(buf, seconds){
  const n = Math.max(1, Math.min(buf.length, Math.ceil(seconds * buf.sampleRate)));
  const out = actx.createBuffer(1, n, buf.sampleRate);
  const s = buf.getChannelData(0), d = out.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = s[n - 1 - i];
  return out;
}

function playRevVoice(buf, chain, time){
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.connect(chain.input);
  try {
    src.start(time);
    autoRelease(src, chain, buf.duration);
  } catch (e){
    console.warn('reverse playback failed', e);
    chain.release();
  }
}

/* --------------------------------------------- sample playback (one hit)
   `off` and `len` are seconds inside the buffer; the source is started on
   the audio clock so trims and slices are sample accurate.             */
function playSample(s, o){
  const buf = o.rev ? getRev(s) : s.buffer;
  const dur = s.buffer.duration;

  const chain = makeChain(o.vol, o.cut, o.res);
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.max(0.03, o.rate);
  src.connect(chain.input);

  let start = o.rev ? dur - (o.off + o.len) : o.off;
  if (start < 0) start = 0;
  const len = Math.max(0.008, Math.min(o.len, dur - start));

  try {
    src.start(o.time, start, len);
    autoRelease(src, chain, len / src.playbackRate.value);
  } catch (e){
    console.warn('sample playback failed', e);
    chain.release();
  }
}

/* Synth voices run through the same filter/gain chain as a sample, so the
   tone and filter knobs work identically on empty slots. */
function playDrumVoice(slot, ix, ratio, o){
  const chain = makeChain(o.vol, o.cut, o.res);
  const kit = kitOf(slot);
  const key = (((ix + kit.rot) % 16) + 16) % 16;
  if (o.rev){
    const buf = revSynthBuffer('d' + kit.name + ':' + key + ':' + ratio.toFixed(4),
                               dest => SDRUM[key](0, 1, dest, ratio * kit.r, kit.d));
    if (buf) { playRevVoice(buf, chain, o.time); return; }
  }
  try {
    const v = SDRUM[key](o.time, 1, chain.input, ratio * kit.r, kit.d);
    autoRelease(v.src, chain, v.dur);
  } catch (e){
    console.warn('drum playback failed', e);
    chain.release();
  }
}
function playPluck(slot, freq, o){
  const chain = makeChain(o.vol, o.cut, o.res);
  const ix = ((slot % 8) + 8) % 8;
  if (o.rev){
    const buf = revSynthBuffer('m' + ix + ':' + freq.toFixed(2),
                               dest => SMEL[ix](freq, 0, 1, dest));
    if (buf) { playRevVoice(buf, chain, o.time); return; }
  }
  try {
    const v = SMEL[ix](freq, o.time, 1, chain.input);
    autoRelease(v.src, chain, v.dur);
  } catch (e){
    console.warn('synth playback failed', e);
    chain.release();
  }
}
