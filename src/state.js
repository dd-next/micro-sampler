/* ======================================================================
   constants + the whole mutable model
   ----------------------------------------------------------------------
   Sixteen sound slots share one 40 second memory pool, like the hardware.
   Slots 0-7 are melodic (one sound played chromatically across the keys),
   slots 8-15 are drum (one sound cut into 16 slices, one per key).
   ====================================================================== */

const N = 16;
const MEM_SECONDS = 40;          // total sampling memory shared by all slots
const MAX_CHAIN   = 128;         // patterns that can be chained into a song

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B',
                    'C↑','C#↑','D↑','D#↑'];

const FX_NAMES = ['LOOP 8','LOOP 12','LOOP ¼','LOOP ⅛','UNISON','UNI LOW',
                  'OCT +','OCT −','STUT 4','STUT 3','SCRATCH','SCR FAST',
                  '6 / 8','RETRIG','REVERSE','— OFF'];

const FX_HINTS = [
  'loop the current half-bar (8 steps)',
  'loop the first 12 steps — drops a beat',
  'loop the current quarter (4 steps)',
  'loop the current eighth (2 steps)',
  'double every voice, slightly detuned',
  'double every voice an octave down',
  'everything up one octave',
  'everything down one octave',
  'each step retriggered four times',
  'each step retriggered three times',
  'sweep the selected sound back and forth',
  'the same, twice as fast',
  'force a fixed 6/8 shuffle',
  'lock the transport to the first two steps',
  'play every sound backwards',
  'no effect — release to clear'
];

const TEMPOS = [{ n:'HIP HOP', b:80 }, { n:'DISCO', b:120 }, { n:'TECHNO', b:140 }];

const PAGES = ['tone', 'filter', 'trim'];

/* Which two parameters knob A and knob B drive on each page.
   `lock` marks the pages whose values can be written per step. */
const PAGE_SPEC = {
  tone:   { a:'tune',  b:'vol', lock:true  },
  filter: { a:'cut',   b:'res', lock:true  },
  trim:   { a:'start', b:'len', lock:false }
};

/* ------------------------------------------------------------ the slots */
function makeSlot(i){
  return {
    type:   i < 8 ? 'mel' : 'drum',
    buffer: null,
    rev:    null,      // cached reversed copy, built on demand
    name:   '',
    start:  0,         // 0..1 of the buffer
    length: 1,         // 0..1 of the buffer
    slices: null,      // drum: 16 × {s,l}, materialised only once edited
    tune:   0,         // -12..+12 semitones
    vol:    0.9,       // 0..1
    cut:    0.5,       // 0 = low-pass shut, 0.5 = open, 1 = high-pass shut
    res:    0          // 0..1 → Q
  };
}
const slots = Array.from({ length:N }, (_, i) => makeSlot(i));

/* ---------------------------------------------------------- the patterns
   A cell is null, or { v, tune?, vol?, cut?, res? } where `v` is a note
   (melodic) or a slice index (drum) and the optional keys are parameter
   locks that override the slot value for that step only.
   `fx` holds one punch-in effect index per step, or null.            */
function makePattern(){
  return {
    tracks: Array.from({ length:N }, () => new Array(N).fill(null)),
    fx:     new Array(N).fill(null)
  };
}
const patterns = Array.from({ length:N }, makePattern);

/* ------------------------------------------------------------ transport */
let mode      = 'keys';   // keys | sound | pattern | write | fx | rec | bpm
let sel       = 0;        // selected slot
let page      = 'tone';   // parameter page driving knobs A and B
let bpm       = 120;
let tempoIx   = 1;
let swing     = 0;        // 0..60 %
let master    = 0.9;
let playing   = false;
let live      = false;
let lastNote  = 0;        // last key played, written by WRITE in step mode
let lastSlice = 0;        // last drum slice triggered, the one TRIM edits

let chain    = [0];       // pattern chain; always at least one entry
let chainPos = 0;
let curPat   = 0;

let currentStep = 0, nextNoteTime = 0, drawStepIx = -1, timerID = null;
const queue = [];         // {step, time} handed from audio clock to the UI

/* ------------------------------------------------------- memory pool */
/* Copying a sound shares the buffer by reference, so count each one once. */
function memUsed(){
  const seen = new Set();
  let t = 0;
  for (const s of slots){
    if (s.buffer && !seen.has(s.buffer)){ seen.add(s.buffer); t += s.buffer.duration; }
  }
  return t;
}
function memFree(){ return Math.max(0, MEM_SECONDS - memUsed()); }

/* What recording into slot `i` actually has to work with. Its current sound
   is handed back the moment the new take lands, so it should not count
   against the take — unless a copy in another slot shares the same buffer,
   in which case the pool keeps paying for it either way. */
function memFreeFor(i){
  const b = slots[i].buffer;
  if (!b) return memFree();
  const shared = slots.some((s, j) => j !== i && s.buffer === b);
  return shared ? memFree() : Math.max(0, MEM_SECONDS - (memUsed() - b.duration));
}

/* ---------------------------------------------------------- slice model
   Drum slices divide the trimmed region into 16 equal pieces until the
   user nudges one, at which point all 16 are frozen as explicit values. */
function sliceOf(s, i){
  if (s.slices) return s.slices[i];
  const w = s.length / 16;
  return { s: s.start + i * w, l: w };
}
function materialiseSlices(s){
  if (!s.slices){
    const w = s.length / 16;
    s.slices = Array.from({ length:16 }, (_, i) => ({ s: s.start + i * w, l: w }));
  }
  return s.slices;
}
function resetSlices(s){ s.slices = null; }

/* --------------------------------------------------------------- cells */
function cellAt(pat, track, step){ return patterns[pat].tracks[track][step]; }
function hasLock(cell){
  return !!cell && (cell.tune !== undefined || cell.vol !== undefined ||
                    cell.cut  !== undefined || cell.res !== undefined);
}
/* A pattern is copied cell by cell: a cell may carry parameter locks, so a
   shallow row copy would leave the two patterns sharing lock objects and
   editing one would silently edit the other. */
function copyPatternInto(srcIx, dstIx){
  const src = patterns[srcIx], dst = patterns[dstIx];
  dst.tracks = src.tracks.map(tr => tr.map(c => (c ? { ...c } : null)));
  dst.fx     = src.fx.slice();
}
function patternHasContent(p){
  const pt = patterns[p];
  return pt.tracks.some(tr => tr.some(c => c != null)) || pt.fx.some(f => f != null);
}

/* Effective parameter for a step: the lock if present, else the slot. */
function paramFor(slot, cell, key){
  if (cell && cell[key] !== undefined) return cell[key];
  return slot[key];
}
