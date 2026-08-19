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

  try {
    const attempt = Promise.resolve(actx.resume()).then(() => true);
    const timeout = new Promise(resolve => {
      setTimeout(() => resolve(false), 1200);
    });
    resumePromise = Promise.race([attempt, timeout]).then(ok => {
      if (!ok) console.warn('AudioContext resume timed out', actx.state);
      resumePromise = null;
      return ok;
    }).catch(err => {
      console.warn('AudioContext resume failed', err);
      resumePromise = null;
      return false;
    });
  } catch (err){
    console.warn('AudioContext resume failed', err);
    return Promise.resolve(false);
  }
  return resumePromise;
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

/* Switching session type can change the hardware sample rate underneath a
   live AudioContext, which leaves it unusable. Start a clean one and rebuild
   the graph. AudioBuffers survive: they are not bound to a context. */
function rebuildAudio(){
  const old = actx;
  const wasPlaying = typeof playing !== 'undefined' && playing;
  if (wasPlaying && typeof stopSeq === 'function') stopSeq();
  if (typeof stopScratch === 'function') stopScratch();

  actx = null; masterGain = null; comp = null; analyser = null; noiseBuf = null;
  if (typeof slots !== 'undefined') slots.forEach(s => { s.rev = null; });
  if (old){ try { old.close(); } catch (e) { /* already gone */ } }

  const next = ensureAudio();
  if (wasPlaying && typeof startSeq === 'function') startSeq();
  return next;
}

function ensureAudio(){
  if (actx){
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

  const len = actx.sampleRate * 2;
  noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

  watchContextState();
  unlockIOS();
  resumeAudio();
  if (typeof startUiLoop === 'function') startUiLoop();
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
   and do not always resume it on return. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && actx){
    resumeAudio();
  }
});

/* On iOS, pointerdown/touchstart has not been a reliable Web Audio unlock
   event across Safari versions. The compatibility click/touchend path gives
   a suspended context another trusted user gesture without changing the
   low-latency pointer path used by the pads. */
['touchend', 'click'].forEach(type => {
  document.addEventListener(type, () => {
    if (!actx) ensureAudio();
    else if (actx.state !== 'running') resumeAudio();
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

/* Percussive envelope.
   `pk` is clamped away from zero: exponentialRampToValueAtTime(0) throws a
   RangeError, and a throw inside the scheduler stalls the transport. */
function env(g, t, pk, decay){
  const peak = Math.max(0.0002, pk);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
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

/* Tear the chain down once the source that feeds it has finished. */
function autoRelease(src, chain, fallbackSeconds){
  let done = false;
  const kill = () => { if (done) return; done = true; chain.release(); };
  src.onended = kill;
  // onended is not guaranteed to fire if the context is closed mid-flight
  setTimeout(kill, Math.max(0.2, fallbackSeconds) * 1000 + 400);
}

/* ------------------------------------------------- synth fallback voices
   Used by any slot that has no sample yet, so the instrument is playable
   the moment it loads. `r` is the tuning ratio.                        */
function sKick(t, v, into, r){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(150 * r, t);
  o.frequency.exponentialRampToValueAtTime(48 * r, t + 0.11);
  env(g, t, v, 0.35);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.4);
  return { src:o, dur:0.4 };
}
function sSnare(t, v, into, r){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1800 * r;
  env(g, t, v * 0.8, 0.18);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.2);
  return { src:s, dur:0.2 };
}
function sHatC(t, v, into, r){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 7000 * r;
  env(g, t, v * 0.5, 0.05);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.06);
  return { src:s, dur:0.06 };
}
function sHatO(t, v, into, r){
  const s = noise(), hp = actx.createBiquadFilter(), g = actx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 7000 * r;
  env(g, t, v * 0.5, 0.3);
  s.connect(hp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.32);
  return { src:s, dur:0.32 };
}
function sClap(t, v, into, r){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1200 * r;
  env(g, t, v * 0.7, 0.16);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.18);
  return { src:s, dur:0.18 };
}
function sTom(t, v, into, r){
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(160 * r, t);
  o.frequency.exponentialRampToValueAtTime(90 * r, t + 0.15);
  env(g, t, v * 0.7, 0.25);
  o.connect(g).connect(into);
  o.start(t); o.stop(t + 0.3);
  return { src:o, dur:0.3 };
}
function sRim(t, v, into, r){
  const s = noise(), bp = actx.createBiquadFilter(), g = actx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1700 * r; bp.Q.value = 3;
  env(g, t, v * 0.5, 0.04);
  s.connect(bp).connect(g).connect(into);
  s.start(t); s.stop(t + 0.05);
  return { src:s, dur:0.05 };
}
function sCow(t, v, into, r){
  let last = null;
  [540, 800].forEach(f => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = f * r;
    env(g, t, v * 0.25, 0.2);
    o.connect(g).connect(into);
    o.start(t); o.stop(t + 0.22);
    last = o;
  });
  return { src:last, dur:0.22 };
}
const SDRUM = [sKick, sSnare, sHatC, sHatO, sClap, sTom, sRim, sCow];

function synthPluck(freq, t, v, into){
  const o = actx.createOscillator(), lp = actx.createBiquadFilter(), g = actx.createGain();
  o.type = 'triangle'; o.frequency.value = freq;
  lp.type = 'lowpass'; lp.frequency.value = 3200;
  env(g, t, v * 0.7, 0.3);
  o.connect(lp).connect(g).connect(into);
  o.start(t); o.stop(t + 0.35);
  return { src:o, dur:0.35 };
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
function playDrumVoice(ix, ratio, o){
  const chain = makeChain(o.vol, o.cut, o.res);
  try {
    const v = SDRUM[((ix % 8) + 8) % 8](o.time, 1, chain.input, ratio);
    autoRelease(v.src, chain, v.dur);
  } catch (e){
    console.warn('drum playback failed', e);
    chain.release();
  }
}
function playPluck(freq, o){
  const chain = makeChain(o.vol, o.cut, o.res);
  try {
    const v = synthPluck(freq, o.time, 1, chain.input);
    autoRelease(v.src, chain, v.dur);
  } catch (e){
    console.warn('synth playback failed', e);
    chain.release();
  }
}
