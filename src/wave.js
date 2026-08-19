/* ======================================================================
   waveform display and trimming
   ----------------------------------------------------------------------
   Melodic slots trim the whole sound. Drum slots trim one slice at a time
   — whichever was played last, exactly as the hardware behaves — so the
   highlighted band follows your finger around the pads.
   ====================================================================== */

const waveCv = document.getElementById('wave');
const MIN_REGION = 0.004;

/* Ink on white, the same four flat colours the skin uses elsewhere. */
const INK    = '#0a0a0a';   // the part of the sound that will play
const REST   = '#c9c4b8';   // everything trimmed away
const DRUM   = '#e88aa5';   // slice grid
const CURSOR = '#ff6b5c';   // trim handles

let peakCache = null;       // { buffer, w, min:Float32Array, max:Float32Array }

/* ------------------------------------------------------------- geometry */
function activeRegion(){
  const s = slots[sel];
  if (s.type === 'drum' && s.buffer){
    const sl = sliceOf(s, lastSlice);
    return { start: sl.s, len: sl.l, isSlice: true };
  }
  return { start: s.start, len: s.length, isSlice: false };
}

function setRegion(start, len){
  const s = slots[sel];
  start = Math.min(1 - MIN_REGION, Math.max(0, start));
  len   = Math.max(MIN_REGION, Math.min(1 - start, len));
  if (s.type === 'drum' && s.buffer){
    const arr = materialiseSlices(s);
    arr[lastSlice] = { s: start, l: len };
  } else {
    s.start = start;
    s.length = len;
  }
}

/* ---------------------------------------------------------------- peaks */
function buildPeaks(buf, w){
  if (peakCache && peakCache.buffer === buf && peakCache.w === w) return peakCache;
  const data = buf.getChannelData(0);
  const min = new Float32Array(w), max = new Float32Array(w);
  const per = data.length / w;
  for (let x = 0; x < w; x++){
    const i0 = Math.floor(x * per), i1 = Math.min(data.length, Math.floor((x + 1) * per));
    let mn = 1, mx = -1;
    for (let i = i0; i < i1; i++){ const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (i1 <= i0){ mn = 0; mx = 0; }
    min[x] = mn; max[x] = mx;
  }
  peakCache = { buffer: buf, w, min, max };
  return peakCache;
}
function invalidatePeaks(){ peakCache = null; }

/* ---------------------------------------------------------------- paint */
function sizeCanvas(cv){
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (cv.width !== w * dpr || cv.height !== h * dpr){
    cv.width = w * dpr; cv.height = h * dpr;
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w, h };
}

function drawWave(){
  const s = slots[sel];
  const { c, w, h } = sizeCanvas(waveCv);
  c.clearRect(0, 0, w, h);

  if (!s.buffer){
    c.fillStyle = INK;
    c.font = '9px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('no sample — playing a synth voice', w / 2, h / 2 - 3);
    c.fillStyle = REST;
    c.fillText('hold REC + a key to sample', w / 2, h / 2 + 10);
    return;
  }

  const isDrum = s.type === 'drum';
  const reg = activeRegion();
  const peaks = buildPeaks(s.buffer, w);
  const mid = h / 2;
  const rs = reg.start * w, re = (reg.start + reg.len) * w;

  // whole-sound region, drawn behind, so drum trims read in context
  const gs = s.start * w, gel = (s.start + s.length) * w;

  // two tones only: the part that will sound is black, the rest is the
  // grey of a printed waveform. Nothing is dimmed or tinted.
  for (let x = 0; x < w; x++){
    const inReg = x >= rs && x <= re && x >= gs && x <= gel;
    c.fillStyle = inReg ? INK : REST;
    const top = mid + peaks.min[x] * mid * 0.94;
    const hgt = Math.max(1, (peaks.max[x] - peaks.min[x]) * mid * 0.94);
    c.fillRect(x, top, 1, hgt);
  }

  // slice grid, in the drum role colour
  if (isDrum){
    c.strokeStyle = DRUM;
    c.lineWidth = 1;
    for (let k = 0; k < 16; k++){
      const sl = sliceOf(s, k);
      const x = Math.round(sl.s * w) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }
    // number the slice being edited
    c.fillStyle = DRUM;
    c.font = '8px ui-monospace, monospace';
    c.textAlign = 'left';
    c.fillText('S' + (lastSlice + 1), Math.min(w - 16, rs + 3), 10);
  }

  // handles: a 3px red rule at each edge of the region, with a grip at
  // the top and bottom of it so it is visible over a dense waveform
  c.fillStyle = CURSOR;
  c.fillRect(Math.round(rs) - 1, 0, 3, h);
  c.fillRect(Math.round(re) - 2, 0, 3, h);
  c.fillRect(Math.max(0, rs - 4), 0, 9, 6);
  c.fillRect(Math.min(w - 9, re - 5), 0, 9, 6);
  c.fillRect(Math.max(0, rs - 4), h - 6, 9, 6);
  c.fillRect(Math.min(w - 9, re - 5), h - 6, 9, 6);
}

/* -------------------------------------------------------------- dragging */
let dragHandle = null;

waveCv.addEventListener('pointerdown', e => {
  const s = slots[sel];
  if (!s.buffer) return;
  e.preventDefault();
  const r = waveCv.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const reg = activeRegion();
  dragHandle = Math.abs(x - reg.start) <= Math.abs(x - (reg.start + reg.len)) ? 'start' : 'end';
  waveCv.setPointerCapture(e.pointerId);
  dragTo(x);
});
waveCv.addEventListener('pointermove', e => {
  if (!dragHandle) return;
  e.preventDefault();
  const r = waveCv.getBoundingClientRect();
  dragTo((e.clientX - r.left) / r.width);
});
const endDrag = e => {
  if (!dragHandle) return;
  dragHandle = null;
  try { waveCv.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
  syncKnobsFromSlot();
  scheduleSave();
};
waveCv.addEventListener('pointerup', endDrag);
waveCv.addEventListener('pointercancel', endDrag);

function dragTo(x){
  x = Math.max(0, Math.min(1, x));
  const reg = activeRegion();
  if (dragHandle === 'start'){
    const end = reg.start + reg.len;
    setRegion(Math.min(x, end - MIN_REGION), end - Math.min(x, end - MIN_REGION));
  } else {
    setRegion(reg.start, x - reg.start);
  }
  drawWave();
  syncKnobsFromSlot();
}

window.addEventListener('resize', () => { invalidatePeaks(); drawWave(); });
