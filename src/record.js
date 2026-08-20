/* ======================================================================
   microphone sampling
   ----------------------------------------------------------------------
   Records for exactly as long as the key is held, straight into a
   Float32 buffer — no container, no codec, no decode step, so a sample is
   playable the instant the key comes up.

   Capture runs in an AudioWorklet where available and falls back to a
   ScriptProcessorNode, which is deprecated but works everywhere including
   pages opened straight off the filesystem.
   ====================================================================== */

const CAP_CHUNK = 2048;
const MIN_SAMPLE = 0.06;      // shorter than this and it was a mis-tap

/* Levelling a take. The synth voices are written to peak at full scale, so
   a microphone held at arm's length — with autoGainControl off, which is
   what keeps the room from pumping between hits — lands some 20 dB under
   the sound it just replaced. Every take is lifted to one target instead. */
const NORM_TARGET = 0.89;     // peak a finished take is scaled to
const NORM_MAX    = 16;       // +24 dB ceiling; past this it is only room
const NORM_FLOOR  = 0.003;    // under this nothing came in at all

const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  constructor(){
    super();
    this.on = false;
    this.buf = new Float32Array(${CAP_CHUNK});
    this.n = 0;
    this.peak = 0;
    this.port.onmessage = e => {
      const was = this.on;
      this.on = e.data.on;
      if (was && !e.data.on) this.flush(true);
    };
  }
  flush(done){
    this.port.postMessage({
      pcm: this.n ? this.buf.slice(0, this.n) : null,
      peak: this.peak,
      done: !!done
    });
    this.n = 0; this.peak = 0;
  }
  process(inputs, outputs){
    // Keep the worklet in the rendered graph. Safari may stop pulling an
    // input-only node with no downstream connection, which means no PCM ever
    // reaches the main thread. The output is routed through a zero-gain sink.
    const out = outputs[0];
    if (out){
      for (let c = 0; c < out.length; c++){
        for (let i = 0; i < out[c].length; i++) out[c][i] = 0;
      }
    }
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch){
      for (let i = 0; i < ch.length; i++){
        const v = ch[i];
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        this.buf[this.n++] = v;
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

let micStream = null, micSource = null, capNode = null, capSink = null, capIsWorklet = false;
let micGeneration = 0;      // bumped by every release, so a stale arm can tell
let arming = null;          // in-flight armMic promise, shared by all callers
let lastMicError = null;
let recState = 'idle';            // idle | recording | stopping
let recSlot = null, recChunks = [], recCount = 0, recLimit = 0;
let recPeak = 0, recTakeMax = 0, recCapTimer = null;
let lastNormGain = 1;
let stopResolve = null, stopTimer = null, stopDiscard = false;

function micActive(){ return !!micStream; }
function recActiveSlot(){ return recState === 'idle' ? null : recSlot; }
function recSeconds(){
  return actx && recCount ? recCount / actx.sampleRate : 0;
}
function recPeakLevel(){ const p = recPeak; recPeak = 0; return p; }
/* The loudest thing in the take so far. Unlike recPeakLevel it is not
   drained by the meter, so the UI can say "this is clipping" or "nothing is
   reaching the microphone" about the whole take rather than one frame. */
function recTakePeak(){ return recTakeMax; }
/* How much the last finished take was lifted by, in dB. */
function recLastGainDb(){
  return lastNormGain > 0 ? 20 * Math.log10(lastNormGain) : 0;
}

/* ------------------------------------------------------------ mic setup */
/* Safari is fussy about capture constraints and will reject the whole
   request rather than relax one it cannot meet, so ask for the ideal shape
   first and step down to plain `audio: true`. A refusal is final — retrying
   would only re-prompt. */
const MIC_CONSTRAINTS = [
  { audio: { echoCancellation:false, noiseSuppression:false,
             autoGainControl:false, channelCount:1 } },
  { audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false } },
  { audio: true }
];

function isFinalRefusal(err){
  return !!err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
}

async function getMicStream(){
  let last = null;
  for (const constraints of MIC_CONSTRAINTS){
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err){
      last = err;
      if (isFinalRefusal(err)) throw err;
      console.warn('getUserMedia rejected', err && err.name, constraints);
    }
  }
  throw last || new Error('getUserMedia failed');
}

/* Arming is shared and cancellable. `releaseMic` bumps the generation, so a
   request still waiting on the permission prompt when the user leaves REC
   cannot come back later and quietly reopen the microphone. */
function armMic(){
  if (micStream) return Promise.resolve(true);
  if (arming) return arming;

  const gen = ++micGeneration;
  arming = (async () => {
    // Ask for a session that permits input *before* opening the microphone.
    // Under the output-only `playback` session, createMediaStreamSource
    // fails with InvalidStateError.
    const sessionChanged = setAudioSession('play-and-record');
    ensureAudio();
    if (sessionChanged) await resumeAudio();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      const e = new Error('getUserMedia is not available');
      e.name = window.isSecureContext ? 'NotSupportedError' : 'InsecureContextError';
      throw e;
    }

    const stream = await stage('permission', () => getMicStream());
    if (gen !== micGeneration){
      stream.getTracks().forEach(t => t.stop());
      throw cancelled();
    }
    micStream = stream;

    // the permission prompt suspends the context on iOS
    await resumeAudio();
    try {
      await wireCapture();
    } catch (err){
      // Opening the microphone can move the hardware sample rate, which
      // leaves the existing context unusable. One clean retry.
      if (err && err.name === 'InvalidStateError'){
        console.warn('capture graph rejected the context; rebuilding', err);
        rebuildAudio();
        await resumeAudio();
        await wireCapture();
      } else {
        throw err;
      }
    }
    if (gen !== micGeneration) throw cancelled();

    lastMicError = null;
    return true;
  })();

  const settle = () => { if (gen === micGeneration) arming = null; };
  arming.then(settle, err => { settle(); lastMicError = err; });
  return arming;
}

function cancelled(){
  const e = new Error('cancelled'); e.name = 'AbortError'; return e;
}

/* Label which step failed, so a report from a device we cannot debug says
   more than just the error name. */
async function stage(name, fn){
  try {
    return await fn();
  } catch (err){
    if (err && !err.stage) err.stage = name;
    throw err;
  }
}

/* Everything that binds the live stream into the audio graph, as one unit so
   it can be retried on a freshly built context. */
async function wireCapture(){
  micSource = await stage('media-source', async () => actx.createMediaStreamSource(micStream));
  await stage('capture-node', () => buildCapture());
  await stage('connect', async () => micSource.connect(capNode));
}

function micArming(){ return !!arming; }
function micLastError(){ return lastMicError; }

async function buildCapture(){
  // AudioWorklet first — off the main thread, so UI work cannot drop samples
  if (actx.audioWorklet){
    let url = null, workletNode = null, workletSink = null;
    try {
      url = URL.createObjectURL(new Blob([WORKLET_SRC], { type:'application/javascript' }));
      await actx.audioWorklet.addModule(url);
      workletNode = new AudioWorkletNode(actx, 'cap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      workletNode.onprocessorerror = () => {
        console.warn('AudioWorklet capture processor failed');
      };
      workletNode.port.onmessage = e => onCaptured(e.data.pcm, e.data.peak, e.data.done);
      // A silent downstream connection keeps the worklet rendered without
      // feeding microphone audio back to the user.
      workletSink = actx.createGain();
      workletSink.gain.value = 0;
      workletNode.connect(workletSink);
      workletSink.connect(actx.destination);
      workletNode.port.postMessage({ on:false });
      capNode = workletNode;
      capSink = workletSink;
      capIsWorklet = true;
      return;
    } catch (e){
      if (workletNode){ try { workletNode.disconnect(); } catch (err) { /* gone */ } }
      if (workletSink){ try { workletSink.disconnect(); } catch (err) { /* gone */ } }
      console.warn('AudioWorklet capture unavailable; using ScriptProcessor', e);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  // ScriptProcessor fallback
  const sp = actx.createScriptProcessor(4096, 1, 1);
  sp.onaudioprocess = ev => {
    if (recState === 'idle') return;
    const ch = ev.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++){ const a = Math.abs(ch[i]); if (a > peak) peak = a; }
    onCaptured(new Float32Array(ch), peak, false);
  };
  // a ScriptProcessor only runs while connected to a destination
  capSink = actx.createGain();
  capSink.gain.value = 0;
  sp.connect(capSink);
  capSink.connect(actx.destination);
  capNode = sp;
  capIsWorklet = false;
}

function releaseMic(){
  micGeneration++;            // invalidates an arm that is still in flight
  arming = null;
  // Only a take still being captured is worth throwing away. One that is
  // already stopping has all its audio; nothing is outstanding but the
  // flush, which finishes without the microphone. Discarding here lost the
  // sample whenever REC was released in the same moment as the key -- which
  // is exactly how the instrument is meant to be played.
  if (recState === 'recording') stopRec(true);
  if (micSource){ try { micSource.disconnect(); } catch (e) { /* gone */ } micSource = null; }
  if (micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (capNode){
    if (capIsWorklet) { try { capNode.port.postMessage({ on:false }); } catch (e) { /* gone */ } }
    try { capNode.disconnect(); } catch (e) { /* gone */ }
    capNode = null;
  }
  if (capSink){
    try { capSink.disconnect(); } catch (e) { /* gone */ }
    capSink = null;
  }
  capIsWorklet = false;
  // back to an output-only session, so the silent switch stays overridden
  setAudioSession('playback');
}

/* ------------------------------------------------------------- capturing */
/* Chunks keep arriving after the stop is signalled — the worklet posts its
   partial buffer asynchronously — so keep accepting them until the `done`
   sentinel lands. Assembling straight away used to lose the tail. */
function onCaptured(pcm, peak, done){
  if (peak > recPeak) recPeak = peak;
  if (recState !== 'idle' && peak > recTakeMax) recTakeMax = peak;

  if (recState !== 'idle' && pcm && pcm.length && recCount < recLimit){
    let block = pcm;
    if (recCount + block.length > recLimit) block = block.subarray(0, recLimit - recCount);
    recChunks.push(block);
    recCount += block.length;
  }

  if (done && recState === 'stopping'){ finishStop(); return; }
  if (recState === 'recording' && recCount >= recLimit) stopRec();  // pool spent
}

function startRec(slotIx){
  if (recState !== 'idle') return false;
  const free = memFreeFor(slotIx);
  if (free < MIN_SAMPLE) return false;

  recState  = 'recording';
  recSlot   = slotIx;
  recChunks = [];
  recCount  = 0;
  recPeak   = 0;
  recTakeMax = 0;
  recLimit  = Math.floor(free * actx.sampleRate);

  if (capIsWorklet) capNode.port.postMessage({ on:true });
  // hard ceiling in case a pointerup never arrives
  clearTimeout(recCapTimer);
  recCapTimer = setTimeout(() => { if (recState === 'recording') stopRec(); },
                           (free + 0.5) * 1000);
  return true;
}

/* Resolves to 'ok' | 'short' | 'quiet' | 'none'. `discard` throws the take
   away; 'quiet' means the microphone heard nothing worth keeping. */
function stopRec(discard){
  if (recState === 'idle') return Promise.resolve('none');
  if (recState === 'stopping'){
    if (discard) stopDiscard = true;
    return Promise.resolve('none');
  }

  recState = 'stopping';
  stopDiscard = !!discard;
  clearTimeout(recCapTimer);
  if (capIsWorklet && capNode) capNode.port.postMessage({ on:false });

  return new Promise(resolve => {
    stopResolve = resolve;
    // the ScriptProcessor path has no sentinel, and a message can be lost
    stopTimer = setTimeout(finishStop, capIsWorklet ? 250 : 120);
  });
}

function finishStop(){
  if (recState !== 'stopping') return;
  clearTimeout(stopTimer);
  recState = 'idle';

  const ix = recSlot, chunks = recChunks, n = recCount, discard = stopDiscard;
  recSlot = null; recChunks = []; recCount = 0; stopDiscard = false;

  const done = stopResolve;
  stopResolve = null;
  const finish = r => { if (done) done(r); };

  if (discard || ix == null){ finish('none'); return; }
  if (n < actx.sampleRate * MIN_SAMPLE){ finish('short'); return; }

  const flat = new Float32Array(n);
  let at = 0;
  for (const c of chunks){ flat.set(c, at); at += c.length; }

  const gain = normalise(flat, n);
  if (!gain){ finish('quiet'); return; }
  lastNormGain = gain;

  const keep = silentTailAt(flat, actx.sampleRate);
  const buf = actx.createBuffer(1, keep, actx.sampleRate);
  buf.getChannelData(0).set(flat.subarray(0, keep));

  const s = slots[ix];
  s.buffer = buf;
  s.rev    = null;
  s.start  = 0;
  s.length = 1;
  resetSlices(s);
  finish('ok');
}

/* Scale a take to NORM_TARGET, in place. Returns the gain applied, or 0 if
   the take is silence — a slot is worth keeping only for something that was
   actually played, and lifting a room by 24 dB is not that.

   Runs before silentTailAt on purpose: that threshold is an absolute
   amplitude, so on a quiet take it would trim live audio as dead air. */
function normalise(d, n){
  let peak = 0;
  for (let i = 0; i < n; i++){ const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
  if (peak < NORM_FLOOR) return 0;

  const gain = Math.min(NORM_TARGET / peak, NORM_MAX);
  if (Math.abs(gain - 1) < 0.01) return 1;       // already sitting on target
  for (let i = 0; i < n; i++) d[i] *= gain;
  return gain;
}

/* Length to keep once the dead air at the end is dropped, so slices land on
   sound rather than silence and the memory pool is not spent on nothing. */
function silentTailAt(d, rate){
  let end = d.length - 1;
  while (end > 0 && Math.abs(d[end]) < 0.002) end--;
  const withRoom = Math.min(d.length, end + Math.floor(rate * 0.01));
  return Math.max(Math.floor(rate * MIN_SAMPLE), withRoom);
}
