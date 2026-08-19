/* ======================================================================
   look-ahead scheduler and transport
   ----------------------------------------------------------------------
   A coarse 25 ms timer wakes up, looks 100 ms into the future and places
   every note that falls in that window at an exact AudioContext time.
   The UI never participates in timing; it reads a queue afterwards and
   draws what has already been scheduled.
   ====================================================================== */

const LOOKAHEAD = 25;      // ms between scheduler wake-ups
const AHEAD     = 0.10;    // seconds of audio scheduled in advance
const QUEUE_MAX = 256;     // playhead queue ceiling, for backgrounded tabs

const stepDur = () => (60 / bpm) / 4;

/* --------------------------------------------------------------- firing */
function fireStep(step, time){
  const pat = patterns[curPat];

  // an effect saved into the pattern engages here; held keys still win
  const saved = pat.fx[step];
  if (saved != null) setStepFX(saved === 15 ? null : saved);

  const sub = stutterSub;
  for (let tr = 0; tr < N; tr++){
    const cell = pat.tracks[tr][step];
    if (cell == null) continue;
    if (sub > 1){
      const d = stepDur() / sub;
      for (let k = 0; k < sub; k++) trig(tr, time + k * d, cell);
    } else {
      trig(tr, time, cell);
    }
  }
}

/* Play one hit. `cell` is a pattern cell, or a bare number for live play. */
function trig(idx, time, cell){
  /* A user gesture may have started resume(), but Safari completes it
     asynchronously. Delay the voice until the context is actually running;
     otherwise a first tap can be consumed while the context is suspended. */
  if (actx && actx.state !== 'running'){
    resumeAudio().then(ok => {
      if (!ok || !actx || actx.state !== 'running') return;
      trig(idx, Math.max(time, actx.currentTime + 0.005), cell);
    });
    return;
  }

  const s = slots[idx];
  const isDrum = idx >= 8;
  const v = typeof cell === 'number' ? cell : (cell && cell.v) || 0;
  const c = typeof cell === 'number' ? null : cell;

  const tune = paramFor(s, c, 'tune');
  const vol  = paramFor(s, c, 'vol');
  const cut  = paramFor(s, c, 'cut');
  const res  = paramFor(s, c, 'res');
  const oct  = Math.pow(2, octaveShift / 12);

  if (s.buffer){
    const dur = s.buffer.duration;
    let off, len, rate;
    if (isDrum){
      const sl = sliceOf(s, ((v % 16) + 16) % 16);
      off  = sl.s * dur;
      len  = Math.max(0.008, sl.l * dur);
      rate = Math.pow(2, tune / 12) * oct;
    } else {
      off  = s.start * dur;
      len  = Math.max(0.02, s.length * dur);
      rate = Math.pow(2, (v + tune) / 12) * oct;
    }
    const o = { off, len, rate, vol, cut, res, rev:reverseOn, time };
    playSample(s, o);
    if (unison){
      playSample(s, Object.assign({}, o, {
        rate: unison === 1 ? rate * 1.008 : rate * 0.5,
        vol:  vol * 0.6
      }));
    }
  } else {
    const o = { vol, cut, res, time };
    if (isDrum){
      const ratio = Math.pow(2, tune / 12) * oct;
      playDrumVoice(idx, v, ratio, o);
      if (unison) playDrumVoice(idx, v, ratio * (unison === 1 ? 1.008 : 0.5),
                                Object.assign({}, o, { vol: vol * 0.6 }));
    } else {
      const f = noteFreq(v + tune) * oct;
      playPluck(idx, f, o);
      if (unison) playPluck(idx, f * (unison === 1 ? 1.008 : 0.5),
                            Object.assign({}, o, { vol: vol * 0.6 }));
    }
  }
}

/* ------------------------------------------------------------ scheduling */
function scheduler(){
  const sd = stepDur();
  let guard = 64;   // never spin forever if the clock jumps

  while (nextNoteTime < actx.currentTime + AHEAD && guard-- > 0){
    const sw = quant68 ? 0.34 : swing / 100;
    const playT = nextNoteTime + ((currentStep % 2) ? sd * sw : 0);

    // A throw in here must not skip the advance below, or the transport
    // wedges and the same step is retried every 25 ms forever.
    try { fireStep(currentStep, playT); }
    catch (err){ console.error('step failed', err); }

    // A backgrounded tab freezes requestAnimationFrame, so nothing drains
    // this. Drop the oldest rather than the newest, so the playhead lands
    // on the right step the moment the tab comes back.
    if (queue.length >= QUEUE_MAX) queue.shift();
    queue.push({ step: currentStep, time: playT });

    advanceStep();
    nextNoteTime += sd;
  }
}

function advanceStep(){
  let ns = currentStep + 1;
  if (loopWindow){
    if (ns >= loopWindow[1] || ns < loopWindow[0]) ns = loopWindow[0];
  } else if (ns >= N){
    ns = 0;
    advanceChain();
  }
  currentStep = ns;
}

function advanceChain(){
  if (chain.length <= 1){ curPat = chain[0] || 0; return; }
  chainPos = (chainPos + 1) % chain.length;
  curPat = chain[chainPos];
}

/* Nearest step to right now, for quantized punch-in recording. */
function quantizedStep(){
  if (!playing) return currentStep;
  const sd = stepDur();
  const delta = Math.round((actx.currentTime - nextNoteTime) / sd);
  return ((currentStep + delta) % N + N) % N;
}

/* ------------------------------------------------------------- transport */
function startSeq(){
  ensureAudio();
  playing = true;
  chainPos = 0;
  curPat = chain[0] || 0;
  currentStep = 0;
  nextNoteTime = actx.currentTime + 0.06;
  queue.length = 0;
  clearInterval(timerID);
  timerID = setInterval(scheduler, LOOKAHEAD);
}

function stopSeq(){
  playing = false;
  clearInterval(timerID);
  timerID = null;
  drawStepIx = -1;
  queue.length = 0;
  setStepFX(null);
  // STOP means silence: voices already sounding — including hand-played
  // hits the transport never scheduled — are cut here, not left to run
  // on until their sample ends.
  stopAllVoices();
}
