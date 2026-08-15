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
  process(inputs){
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

let micStream = null, micSource = null, capNode = null, capIsWorklet = false;
let recState = 'idle';            // idle | recording | stopping
let recSlot = null, recChunks = [], recCount = 0, recLimit = 0;
let recPeak = 0, recCapTimer = null;
let stopResolve = null, stopTimer = null, stopDiscard = false;

function micActive(){ return !!micStream; }
function recActiveSlot(){ return recState === 'idle' ? null : recSlot; }
function recSeconds(){
  return actx && recCount ? recCount / actx.sampleRate : 0;
}
function recPeakLevel(){ const p = recPeak; recPeak = 0; return p; }

/* ------------------------------------------------------------ mic setup */
async function armMic(){
  if (micStream) return true;
  ensureAudio();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('no-getusermedia');
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation:false,
      noiseSuppression:false,
      autoGainControl:false,
      channelCount:1
    }
  });
  micSource = actx.createMediaStreamSource(micStream);
  await buildCapture();
  micSource.connect(capNode);
  return true;
}

async function buildCapture(){
  // AudioWorklet first — off the main thread, so UI work cannot drop samples
  if (actx.audioWorklet){
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type:'application/javascript' }));
      await actx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      capNode = new AudioWorkletNode(actx, 'cap', { numberOfOutputs:0 });
      capNode.port.onmessage = e => onCaptured(e.data.pcm, e.data.peak, e.data.done);
      capNode.port.postMessage({ on:false });
      capIsWorklet = true;
      return;
    } catch (e){ /* fall through */ }
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
  const sink = actx.createGain();
  sink.gain.value = 0;
  sp.connect(sink);
  sink.connect(actx.destination);
  capNode = sp;
  capIsWorklet = false;
}

function releaseMic(){
  if (recSlot != null) stopRec(true);
  if (micSource){ try { micSource.disconnect(); } catch (e) { /* gone */ } micSource = null; }
  if (micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (capNode){
    if (capIsWorklet) { try { capNode.port.postMessage({ on:false }); } catch (e) { /* gone */ } }
    try { capNode.disconnect(); } catch (e) { /* gone */ }
    capNode = null;
  }
}

/* ------------------------------------------------------------- capturing */
/* Chunks keep arriving after the stop is signalled — the worklet posts its
   partial buffer asynchronously — so keep accepting them until the `done`
   sentinel lands. Assembling straight away used to lose the tail. */
function onCaptured(pcm, peak, done){
  if (peak > recPeak) recPeak = peak;

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
  const free = memFree();
  if (free < MIN_SAMPLE) return false;

  recState  = 'recording';
  recSlot   = slotIx;
  recChunks = [];
  recCount  = 0;
  recPeak   = 0;
  recLimit  = Math.floor(free * actx.sampleRate);

  if (capIsWorklet) capNode.port.postMessage({ on:true });
  // hard ceiling in case a pointerup never arrives
  clearTimeout(recCapTimer);
  recCapTimer = setTimeout(() => { if (recState === 'recording') stopRec(); },
                           (free + 0.5) * 1000);
  return true;
}

/* Resolves to 'ok' | 'short' | 'none'. `discard` throws the take away. */
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

/* Length to keep once the dead air at the end is dropped, so slices land on
   sound rather than silence and the memory pool is not spent on nothing. */
function silentTailAt(d, rate){
  let end = d.length - 1;
  while (end > 0 && Math.abs(d[end]) < 0.002) end--;
  const withRoom = Math.min(d.length, end + Math.floor(rate * 0.01));
  return Math.max(Math.floor(rate * MIN_SAMPLE), withRoom);
}
