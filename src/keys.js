/* ======================================================================
   desktop keyboard
   ----------------------------------------------------------------------
   Physical key positions (e.code) rather than characters, so the 4x4 grid
   lands in the same place on any layout. Held keys map onto the same
   pointer path the pads use, so FX and REC hold correctly.
   ====================================================================== */

const GRID_CODES = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'KeyQ',   'KeyW',   'KeyE',   'KeyR',
  'KeyA',   'KeyS',   'KeyD',   'KeyF',
  'KeyZ',   'KeyX',   'KeyC',   'KeyV'
];
const GRID_GLYPHS = ['1','2','3','4','Q','W','E','R','A','S','D','F','Z','X','C','V'];

const MOD_CODES = {
  Digit5:'sound', Digit6:'pattern', Digit7:'write',
  Digit8:'fx',    Digit9:'rec',     Digit0:'bpm'
};

const pressed = new Set();

/* Typing into a control should never also play the instrument. */
function typingTarget(){
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
         a.isContentEditable || a.classList.contains('knob');
}

window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '?'){ e.preventDefault(); openGuide(); return; }
  // the dialog handles its own Escape; nothing else should reach the pads
  if (guideOpen()) return;

  if (typingTarget() && e.key !== 'Escape') return;
  if (pressed.has(e.code)) return;          // ignore auto-repeat

  const gi = GRID_CODES.indexOf(e.code);
  if (gi >= 0){
    pressed.add(e.code);
    e.preventDefault();
    keyDown(gi, keyEls[gi]);
    keyEls[gi].classList.add('kb');
    return;
  }

  const mod = MOD_CODES[e.code];
  if (mod){
    pressed.add(e.code);
    e.preventDefault();
    modDown(mod);
    return;
  }

  switch (e.code){
    case 'Space': {
      // a focused button already turns Space into a click of its own
      const a = document.activeElement;
      if (a && (a.tagName === 'BUTTON' || a.tagName === 'A')) break;
      e.preventDefault();
      playBtn.click();
      break;
    }
    case 'Backquote':
      e.preventDefault();
      setPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length]);
      msg(page + ' — knobs A and B');
      break;
    case 'ArrowLeft':
      e.preventDefault();
      selectSlot((sel + N - 1) % N);
      msg(slotName(sel));
      break;
    case 'ArrowRight':
      e.preventDefault();
      selectSlot((sel + 1) % N);
      msg(slotName(sel));
      break;
    case 'ArrowUp': case 'ArrowDown': {
      e.preventDefault();
      const k = e.shiftKey ? knobB : knobA;
      const d = KNOB_DEFS[page][e.shiftKey ? 'b' : 'a'];
      const dir = e.code === 'ArrowUp' ? 1 : -1;
      const nv = k.value + dir * d.step * (e.repeat ? 2 : 1);
      k.set(nv);
      knobChanged(d, k.value);
      break;
    }
    case 'BracketLeft':
      e.preventDefault();
      bpmS.value = Math.max(60, bpm - 1);
      bpmS.dispatchEvent(new Event('input'));
      break;
    case 'BracketRight':
      e.preventDefault();
      bpmS.value = Math.min(240, bpm + 1);
      bpmS.dispatchEvent(new Event('input'));
      break;
    case 'KeyL':
      e.preventDefault();
      liveBtn.click();
      break;
    case 'Escape':
      e.preventDefault();
      fxAllOff();
      cancelCopy(null);
      latchedMod = null;
      applyMode();
      msg('back to keys');
      break;
  }
});

window.addEventListener('keyup', e => {
  if (!pressed.delete(e.code)) return;

  const gi = GRID_CODES.indexOf(e.code);
  if (gi >= 0){
    keyEls[gi].classList.remove('kb');
    keyUp(gi, keyEls[gi]);
    return;
  }
  const mod = MOD_CODES[e.code];
  if (mod) modUp(mod);
});

/* Losing focus must not leave a key or modifier stuck down. */
window.addEventListener('blur', () => {
  for (const code of [...pressed]){
    pressed.delete(code);
    const gi = GRID_CODES.indexOf(code);
    if (gi >= 0){ keyEls[gi].classList.remove('kb'); keyUp(gi, keyEls[gi]); }
    else if (MOD_CODES[code]) modUp(MOD_CODES[code]);
  }
});

/* The little keycap diagram in the side panel. */
function renderKbMap(){
  const host = document.getElementById('kbmap');
  if (!host) return;
  host.innerHTML = GRID_GLYPHS.map(g => `<span>${g}</span>`).join('');
}
