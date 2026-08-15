// ======== grid, modes, LCD ========
const gridEl=document.getElementById('grid'), dotsEl=document.getElementById('dots');
const modeLbl=document.getElementById('modeLbl'), sndLbl=document.getElementById('sndLbl'), patLbl=document.getElementById('patLbl');
const slotLbl=document.getElementById('slotLbl'), slotType=document.getElementById('slotType');
const waveCv=document.getElementById('wave'), micWarn=document.getElementById('micWarn'), clrSamp=document.getElementById('clrSamp');
const playBtn=document.getElementById('play'), liveBtn=document.getElementById('live'), clrBtn=document.getElementById('clr');
const tuneS=document.getElementById('tune'), filtS=document.getElementById('filt'), volS=document.getElementById('vol');
const tuneV=document.getElementById('tuneV'), filtV=document.getElementById('filtV'), volV=document.getElementById('volV');
const bpmS=document.getElementById('bpm'), swingS=document.getElementById('swing'), tempoBtn=document.getElementById('tempo');
const keyEls=[], dotEls=[];

for(let i=0;i<N;i++){
  const k=document.createElement('button'); k.className='key';
  k.innerHTML=`<span class="kidx">${i+1}</span><span class="kdot"></span><span class="klabel"></span>`;
  const onDown=e=>{ e.preventDefault(); keyDown(i,k); };
  const onUp=e=>{ e.preventDefault(); keyUp(i,k); };
  k.addEventListener('pointerdown',onDown); k.addEventListener('pointerup',onUp);
  k.addEventListener('pointerleave',onUp); k.addEventListener('pointercancel',onUp);
  gridEl.appendChild(k); keyEls.push(k);
  const d=document.createElement('div'); d.className='dot'+([0,4,8,12].includes(i)?' beat':''); dotsEl.appendChild(d); dotEls.push(d);
}

function keyDown(i,k){
  ensureAudio();
  if(mode==='keys'){
    const val=i; trig(sel,actx.currentTime+0.01,val);
    flash(k);
    if(live && playing){ const st=(drawStepIx>=0?drawStepIx:currentStep); patterns[curPat].tracks[sel][st]=val; }
  }
  else if(mode==='sound'){ selectSlot(i); setMode('keys'); }
  else if(mode==='pattern'){ curPat=i; patLbl.textContent=i+1; renderGrid(); setMode('keys'); }
  else if(mode==='write'){ const cur=patterns[curPat].tracks[sel][i]; patterns[curPat].tracks[sel][i]= cur==null?0:null; renderGrid(); }
  else if(mode==='fx'){ fxDown(i,k); }
  else if(mode==='rec'){ recToggle(i); }
}
function keyUp(i,k){ if(mode==='fx') fxUp(i,k); }
function flash(k){ k.classList.add('hit'); setTimeout(()=>k.classList.remove('hit'),90); }

function selectSlot(i){ sel=i;
  slotLbl.textContent=(i<8?'M':'D')+(i+1); slotType.textContent=i<8?'melodic':'drum';
  sndLbl.textContent=(i<8?'M':'D')+(i+1)+' · '+(i<8?'chromatic':'16 slices');
  tuneS.value=slots[i].tune; tuneV.textContent=(slots[i].tune>0?'+':'')+slots[i].tune;
  volS.value=Math.round(slots[i].vol*100); volV.textContent=Math.round(slots[i].vol*100);
  filtS.value=Math.round(slots[i].cut*100); filtV.textContent=slots[i].cut>=1?'open':Math.round(200*Math.pow(90,slots[i].cut))+'Hz';
  drawWave(); renderGrid();
}
function setMode(m){ mode=m; modeLbl.textContent=m.toUpperCase();
  document.querySelectorAll('.mbtn').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
  if(m!=='fx'){ fxUpAll(); } renderGrid(); }
document.querySelectorAll('.mbtn').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));

function patternHasContent(p){ return patterns[p].tracks.some(tr=>tr.some(c=>c!=null)); }
function renderGrid(){
  keyEls.forEach((el,i)=>{
    el.classList.remove('sel','on','head','loaded','act','mel','drum','recing','fxkey');
    const lab=el.querySelector('.klabel'); let t='';
    if(mode==='keys'){ t=sel<8?NOTE_NAMES[i]:'S'+(i+1); }
    else if(mode==='sound'){ t=(i<8?'M':'D')+(i+1); el.classList.add(i<8?'mel':'drum'); if(slots[i].buffer)el.classList.add('loaded'); if(i===sel)el.classList.add('sel'); }
    else if(mode==='pattern'){ t='P'+(i+1); if(patternHasContent(i))el.classList.add('loaded'); if(i===curPat)el.classList.add('sel'); }
    else if(mode==='write'){ t=String(i+1); if(patterns[curPat].tracks[sel][i]!=null)el.classList.add('on'); if(i===drawStepIx&&playing)el.classList.add('head'); }
    else if(mode==='fx'){ t=FX_NAMES[i]; el.classList.add('fxkey'); if(activeFX===i)el.classList.add('act'); }
    else if(mode==='rec'){ t=(i<8?'M':'D')+(i+1); if(slots[i].buffer)el.classList.add('loaded'); if(recActive===i)el.classList.add('recing'); }
    lab.textContent=t;
  });
  paintHeads();
}
function paintHeads(){
  for(let i=0;i<N;i++){ dotEls[i].classList.remove('set','head');
    if(patterns[curPat].tracks[sel][i]!=null) dotEls[i].classList.add('set');
    if(i===drawStepIx) dotEls[i].classList.add('head');
    if(mode==='write'){ keyEls[i].classList.toggle('head',i===drawStepIx&&playing); }
  }
}
function drawLoop(){ if(!playing)return; while(queue.length&&queue[0].time<actx.currentTime){ drawStepIx=queue[0].step; queue.shift(); } paintHeads(); requestAnimationFrame(drawLoop); }

// ======== waveform + trim ========
function sizeCv(cv){ const r=cv.getBoundingClientRect(),dpr=window.devicePixelRatio||1; cv.width=r.width*dpr; cv.height=r.height*dpr;
  const c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); return {c,w:r.width,h:r.height}; }
function drawWave(){
  const s=slots[sel], {c,w,h}=sizeCv(waveCv); c.clearRect(0,0,w,h);
  if(!s.buffer){ c.fillStyle='#3a3a4a'; c.font='9px monospace'; c.textAlign='center';
    c.fillText('no sample · synth voice · use REC to sample', w/2, h/2+3); return; }
  const data=s.buffer.getChannelData(0), mid=h/2, step=Math.max(1,Math.floor(data.length/w));
  const sx=s.start*w, ex=(s.start+s.length)*w;
  for(let x=0;x<w;x++){ let mn=1,mx=-1; const i0=x*step; for(let j=0;j<step;j++){ const v=data[i0+j]||0; if(v<mn)mn=v; if(v>mx)mx=v; }
    c.fillStyle=(x>=sx&&x<=ex)?(sel<8?'#9b6cff':'#4fd4c4'):'#3f3f52'; c.fillRect(x,mid+mn*mid,1,Math.max(1,(mx-mn)*mid)); }
  c.fillStyle='rgba(0,0,0,.45)'; c.fillRect(0,0,sx,h); c.fillRect(ex,0,w-ex,h);
  if(sel>=8){ c.strokeStyle='rgba(79,212,196,.35)'; c.lineWidth=1; for(let k=1;k<16;k++){ const x=sx+(ex-sx)*(k/16); c.beginPath(); c.moveTo(x,0); c.lineTo(x,h); c.stroke(); } }
  c.fillStyle='#f0a53c'; c.fillRect(sx-1,0,2,h); c.fillRect(ex-1,0,2,h); c.fillRect(sx-4,0,8,6); c.fillRect(ex-4,0,8,6);
}
let dragH=null;
waveCv.addEventListener('pointerdown',e=>{ const s=slots[sel]; if(!s.buffer)return; const r=waveCv.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;
  dragH=Math.abs(x-s.start)<Math.abs(x-(s.start+s.length))?'start':'end'; waveCv.setPointerCapture(e.pointerId); moveTrim(x); });
waveCv.addEventListener('pointermove',e=>{ if(!dragH)return; const r=waveCv.getBoundingClientRect(); moveTrim((e.clientX-r.left)/r.width); });
waveCv.addEventListener('pointerup',()=>dragH=null); waveCv.addEventListener('pointercancel',()=>dragH=null);
function moveTrim(x){ const s=slots[sel]; x=Math.max(0,Math.min(1,x));
  if(dragH==='start'){ const end=s.start+s.length; s.start=Math.min(x,end-0.02); s.length=end-s.start; }
  else { s.length=Math.max(0.02,x-s.start); if(s.start+s.length>1)s.length=1-s.start; } drawWave(); }
window.addEventListener('resize',drawWave);

// ======== mic recording ========
let micStream=null, recorder=null, chunks=[], recActive=null, recTimer=null;
async function armMic(){ if(micStream)return micStream; micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}); return micStream; }
async function recToggle(i){
  if(recActive!=null){ stopRec(); return; }
  ensureAudio(); try{ await armMic(); }catch(err){ micWarn.classList.add('show'); return; }
  micWarn.classList.remove('show'); chunks=[]; recorder=new MediaRecorder(micStream);
  recorder.ondataavailable=e=>{ if(e.data&&e.data.size)chunks.push(e.data); };
  recorder.onstop=async()=>{ const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});
    try{ const arr=await blob.arrayBuffer(); const audio=await actx.decodeAudioData(arr);
      const s=slots[recActive]; s.buffer=audio; s.rev=null; s.start=0; s.length=1;
      const done=recActive; recActive=null; sel=done; selectSlot(done); setMode('keys');
    }catch(err){ micWarn.textContent='Could not decode the recording in this browser.'; micWarn.classList.add('show'); recActive=null; renderGrid(); } };
  recorder.start(); recActive=i; renderGrid(); recTimer=setTimeout(stopRec,4000);
}
function stopRec(){ clearTimeout(recTimer); if(recorder&&recorder.state==='recording') recorder.stop(); }
clrSamp.addEventListener('click',()=>{ const s=slots[sel]; s.buffer=null; s.rev=null; s.start=0; s.length=1; drawWave(); renderGrid(); });

// ======== params / transport ========
tuneS.addEventListener('input',e=>{ slots[sel].tune=+e.target.value; tuneV.textContent=(slots[sel].tune>0?'+':'')+slots[sel].tune; });
volS.addEventListener('input',e=>{ slots[sel].vol=e.target.value/100; volV.textContent=e.target.value; });
filtS.addEventListener('input',e=>{ slots[sel].cut=e.target.value/100; filtV.textContent=slots[sel].cut>=1?'open':Math.round(200*Math.pow(90,slots[sel].cut))+'Hz'; drawWave(); });
playBtn.addEventListener('click',()=> playing?stopSeq():startSeq());
liveBtn.addEventListener('click',()=>{ live=!live; liveBtn.classList.toggle('on',live); });
clrBtn.addEventListener('click',()=>{ patterns[curPat].tracks[sel].fill(null); renderGrid(); });
bpmS.addEventListener('input',e=>{ bpm=+e.target.value; syncTempoLabels(); });
swingS.addEventListener('input',e=>{ swing=+e.target.value; document.getElementById('swingV').textContent=swing; });
tempoBtn.addEventListener('click',()=>{ tempoIx=(tempoIx+1)%TEMPOS.length; bpm=TEMPOS[tempoIx].b; bpmS.value=bpm; syncTempoLabels(); });
function syncTempoLabels(){ document.getElementById('bpmVal').textContent=bpm; document.getElementById('bpmV2').textContent=bpm;
  document.getElementById('tempoBpm').textContent=bpm; const m=TEMPOS.find(x=>x.b===bpm); document.getElementById('tempoName').textContent=m?m.n:'CUSTOM'; }
