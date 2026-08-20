/* ======================================================================
   audio diagnostics — open the page with ?diag=1
   ----------------------------------------------------------------------
   The audio faults worth chasing only happen on a phone, and a phone is
   rarely on the end of an inspector cable. So the readout goes on the
   screen: what the context claims about itself, whether its clock is
   actually moving, what the audio session is set to, and three test
   tones that each bypass one more layer than the last.

   Nothing here is loaded into the instrument unless ?diag is in the URL.
   ====================================================================== */

const DIAG_ON = /[?&#]diag/.test(location.search + location.hash);

let diagBox = null, diagOut = null;
let diagNotes = [];
let diagClock = { at: -1, moving: false };
let diagFreshCtx = null;

function diagNote(text){
  diagNotes.push(text.slice(0, 90));
  if (diagNotes.length > 4) diagNotes.shift();
}

/* A bare oscillator, connected to nothing of ours. If this is silent while
   the clock runs, the instrument's graph is not what went wrong. */
function diagTone(ctx, label){
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 440;
    g.gain.value = 0.25;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.25);
    diagNote(label + ': fired at t=' + ctx.currentTime.toFixed(2) +
             ' state=' + ctx.state);
  } catch (err){
    diagNote(label + ': threw ' + err.name);
  }
}

/* Does a context built right now, in this tab, play anything at all? */
function diagFresh(){
  try {
    if (diagFreshCtx){ try { diagFreshCtx.close(); } catch (e) { /* gone */ } }
    const AC = window.AudioContext || window.webkitAudioContext;
    diagFreshCtx = new AC({ latencyHint:'interactive' });
    diagNote('fresh ctx born ' + diagFreshCtx.state);
    Promise.resolve(diagFreshCtx.resume()).then(() => {
      diagNote('fresh ctx after resume ' + diagFreshCtx.state);
      diagTone(diagFreshCtx, 'fresh tone');
    }).catch(err => diagNote('fresh resume ' + err.name));
  } catch (err){
    diagNote('fresh ctx threw ' + err.name);
  }
}

function diagSession(){
  try {
    if (!navigator.audioSession){ diagNote('no audioSession here'); return; }
    const next = navigator.audioSession.type === 'playback' ? 'auto' : 'playback';
    navigator.audioSession.type = next;
    diagNote('session → ' + next);
  } catch (err){
    diagNote('session threw ' + err.name);
  }
}

function diagButton(label, fn){
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'font:11px/1 monospace;margin:3px 3px 0 0;padding:6px 8px;' +
    'background:#222;color:#7f7;border:1px solid #4a4;border-radius:3px;' +
    'pointer-events:auto';
  b.addEventListener('click', e => { e.stopPropagation(); fn(); });
  return b;
}

function diagRefresh(){
  const ctx = typeof actx !== 'undefined' ? actx : null;
  let clock = '—';
  if (ctx){
    const t = ctx.currentTime;
    if (diagClock.at >= 0) diagClock.moving = t > diagClock.at;
    diagClock.at = t;
    clock = t.toFixed(2) + (diagClock.moving ? ' ▶' : ' ■ STUCK');
  } else {
    diagClock.at = -1;
  }

  const sess = navigator.audioSession ? navigator.audioSession.type : 'unsupported';
  const rows = [
    'ctx#' + (typeof ctxGen !== 'undefined' ? ctxGen : '?') + '  ' +
      (ctx ? ctx.state : 'none') + '  ' + (ctx ? (ctx.sampleRate / 1000) + 'k' : ''),
    'clock ' + clock,
    'session ' + sess + '   stale ' +
      (typeof contextStale !== 'undefined' && contextStale ? 'YES' : 'no'),
    'play ' + (typeof playing !== 'undefined' && playing ? 'step ' + currentStep : 'off') +
      '   peak ' + (typeof meterLevel === 'function' ? meterLevel().toFixed(2) : '?'),
    'mic ' + (typeof micActive === 'function' && micActive() ? 'open' : 'closed')
  ].concat(diagNotes.map(n => '· ' + n));

  diagOut.textContent = rows.join('\n');
}

function diagInit(){
  diagBox = document.createElement('div');
  // Top-left, and transparent to touch apart from its own buttons: the
  // instrument has to stay playable underneath the thing watching it.
  diagBox.style.cssText = 'position:fixed;left:6px;top:6px;z-index:9999;' +
    'max-width:min(94vw,420px);padding:7px 9px;border-radius:6px;' +
    'background:rgba(0,0,0,.86);border:1px solid #3a3;color:#8f8;' +
    'pointer-events:none;' +
    'font:11px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap';

  diagOut = document.createElement('div');
  diagBox.appendChild(diagOut);

  const bar = document.createElement('div');
  bar.appendChild(diagButton('tone', () => {
    if (typeof ensureAudio === 'function') ensureAudio();
    if (actx) diagTone(actx, 'tone'); else diagNote('no context');
  }));
  bar.appendChild(diagButton('fresh ctx', diagFresh));
  bar.appendChild(diagButton('revive', () => {
    if (typeof reviveAudio === 'function'){ reviveAudio(); diagNote('revived'); }
  }));
  bar.appendChild(diagButton('release', () => {
    if (typeof releaseAudio === 'function'){ releaseAudio(); diagNote('released'); }
  }));
  bar.appendChild(diagButton('session', diagSession));
  bar.appendChild(diagButton('hide', () => diagBox.remove()));
  diagBox.appendChild(bar);

  document.body.appendChild(diagBox);

  // Warnings are where the audio layer says what went wrong; on a phone
  // they would otherwise land in a console nobody is watching.
  ['warn', 'error'].forEach(level => {
    const was = console[level].bind(console);
    console[level] = (...args) => {
      diagNote(args.map(a => (a && a.name) ? a.name : String(a)).join(' '));
      was(...args);
    };
  });

  setInterval(diagRefresh, 250);
  diagRefresh();
}

if (DIAG_ON){
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', diagInit);
  } else {
    diagInit();
  }
}
