// ======== 16 punch-in effects ========
function fxDown(i,k){ ensureAudio(); activeFX=i; k.classList.add('act');
  switch(i){
    case 0: loopWindow=[0,16]; break;
    case 1: loopWindow=[0,12]; break;
    case 2:{ const lo=Math.floor(currentStep/4)*4; loopWindow=[lo,lo+4]; break; }
    case 3:{ const lo=Math.floor(currentStep/2)*2; loopWindow=[lo,lo+2]; break; }
    case 4: unison=1; break;
    case 5: unison=2; break;
    case 6: octaveShift=12; break;
    case 7: octaveShift=-12; break;
    case 8: stutterSub=4; break;
    case 9: stutterSub=3; break;
    case 10: startScratch(false); break;
    case 11: startScratch(true); break;
    case 12: quant68=true; break;
    case 13: loopWindow=[0,2]; currentStep=0; break;
    case 14: reverseOn=true; break;
    case 15: break;
  }
}
function fxUp(i,k){ if(activeFX===i){ clearFX(); } k.classList.remove('act'); }
function fxUpAll(){ clearFX(); document.querySelectorAll('.key.act').forEach(el=>el.classList.remove('act')); }
function clearFX(){ activeFX=null; loopWindow=null; stutterSub=0; octaveShift=0; unison=0; reverseOn=false; quant68=false; stopScratch(); }
function startScratch(fast){ ensureAudio(); const s=slots[sel];
  if(s.buffer){ const src=actx.createBufferSource(); src.buffer=s.buffer; src.loop=true;
    src.loopStart=s.start*s.buffer.duration; src.loopEnd=(s.start+s.length)*s.buffer.duration;
    const g=actx.createGain(); g.gain.value=0.9; const lfo=actx.createOscillator(),ld=actx.createGain();
    lfo.type='triangle'; lfo.frequency.value=fast?8:4; ld.gain.value=0.85; lfo.connect(ld); ld.connect(src.playbackRate); src.playbackRate.value=1;
    src.connect(g).connect(master); src.start(); lfo.start(); scratchNodes={src,lfo}; }
  else { const o=actx.createOscillator(),g=actx.createGain(),lfo=actx.createOscillator(),ld=actx.createGain();
    o.type='sawtooth'; o.frequency.value=200; g.gain.value=0.22; lfo.frequency.value=fast?9:5; ld.gain.value=170; lfo.connect(ld); ld.connect(o.frequency);
    o.connect(g).connect(master); o.start(); lfo.start(); scratchNodes={src:o,lfo}; }
}
function stopScratch(){ if(!scratchNodes)return; try{ scratchNodes.src.stop(); scratchNodes.lfo.stop(); }catch(e){} scratchNodes=null; }
