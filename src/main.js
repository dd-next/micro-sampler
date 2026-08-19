/* ======================================================================
   boot
   ====================================================================== */

function starterPattern(){
  const p = patterns[0];
  [0, 4, 8, 12].forEach(s => p.tracks[8][s]  = { v:0 });   // D9  kick
  [4, 12].forEach(s      => p.tracks[9][s]  = { v:0 });    // D10 snare
  [0, 2, 4, 6, 8, 10, 12, 14].forEach(s => p.tracks[10][s] = { v:0 }); // D11 hat
  [0, 6].forEach(s       => p.tracks[0][s]  = { v:0 });    // M1  root
  p.tracks[0][10] = { v:7 };
}

function renderFxList(){
  const host = document.getElementById('fxlist');
  if (!host) return;
  host.innerHTML = FX_NAMES
    .map((n, i) => `<li><b>${n}</b> <i>— ${FX_HINTS[i]}</i></li>`)
    .join('');
}

function refreshAll(){
  syncTempoLabels();
  bpmS.value = bpm;
  swingS.value = swing;
  document.getElementById('swingV').textContent = swing;
  masterS.value = Math.round(master * 100);
  document.getElementById('masterV').textContent = Math.round(master * 100);
  paintRanges();
  setPage(page);
  selectSlot(sel);
  updateMem();
  updateChainLabel();
  paintModeButtons();
  renderGrid();
}

function boot(){
  renderKbMap();
  renderFxList();
  buildKnobs();

  loadSaved().then(loaded => {
    if (!loaded) starterPattern();
    refreshAll();
    if (loaded) msg('restored from this device', 2600);
  }).catch(() => {
    starterPattern();
    refreshAll();
  });

  // Save whatever is in flight if the tab goes away.
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  const reset = document.getElementById('resetLnk');
  if (reset){
    reset.addEventListener('click', e => {
      e.preventDefault();
      if (confirm('Delete all saved sounds and patterns on this device?')) wipeSaved();
    });
  }

  // Service worker, so the instrument opens offline once it has been visited.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
    });
  }
}

boot();
