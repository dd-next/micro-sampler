// ======== look-ahead scheduler ========
const LOOKAHEAD=25, AHEAD=0.10;
function fireStep(step,time){
  const sd=(60/bpm)/4;
  for(let tr=0;tr<N;tr++){ const cell=patterns[curPat].tracks[tr][step]; if(cell!=null){
    if(stutterSub>1){ for(let k=0;k<stutterSub;k++) trig(tr,time+k*(sd/stutterSub),cell); }
    else trig(tr,time,cell); } }
}
// unified trigger using explicit-time buffer playback
function trig(idx,time,val){
  const s=slots[idx], isDrum=idx>=8, oct=Math.pow(2,octaveShift/12), vol=s.vol;
  if(s.buffer){
    const dur=s.buffer.duration, regStart=s.start*dur, regLen=Math.max(0.02,s.length*dur);
    let off,len,rate;
    if(isDrum){ const sl=(val||0),slLen=regLen/16; off=regStart+sl*slLen; len=slLen; rate=Math.pow(2,s.tune/12)*oct; }
    else { const note=(val||0); off=regStart; len=regLen; rate=Math.pow(2,(note+s.tune)/12)*oct; }
    playBufT(s,reverseOn,off,len,rate,vol,time);
    if(unison) playBufT(s,reverseOn,off,len,unison===1?rate*1.008:rate*0.5,vol*0.6,time);
  } else {
    if(isDrum){ SDRUM[(val||0)%8](time,vol); if(unison) SDRUM[(val||0)%8](time,vol*0.5); }
    else { synthPluck(noteFreq((val||0)+s.tune)*oct,time,vol); if(unison) synthPluck(noteFreq((val||0)+s.tune)*oct*(unison===1?1.008:0.5),time,vol*0.6); }
  }
}
function scheduler(){
  const sd=(60/bpm)/4;
  while(nextNoteTime < actx.currentTime + AHEAD){
    const sw=(quant68?0.34:swing/100);
    const playT=nextNoteTime + ((currentStep%2)? sd*sw : 0);
    fireStep(currentStep,playT);
    queue.push({step:currentStep,time:nextNoteTime});
    // advance
    let ns=currentStep+1;
    if(loopWindow){ if(ns>=loopWindow[1]) ns=loopWindow[0]; }
    else if(ns>=N) ns=0;
    currentStep=ns; nextNoteTime+=sd;
  }
}
function startSeq(){ ensureAudio(); playing=true; currentStep=0; nextNoteTime=actx.currentTime+0.06; timerID=setInterval(scheduler,LOOKAHEAD); requestAnimationFrame(drawLoop);
  playBtn.classList.add('on'); playBtn.innerHTML='&#9632; STOP'; }
function stopSeq(){ playing=false; clearInterval(timerID); drawStepIx=-1; queue.length=0; paintHeads();
  playBtn.classList.remove('on'); playBtn.innerHTML='&#9654; PLAY'; }
