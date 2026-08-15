// ======== audio graph + synth fallback voices ========
let actx=null, master, comp, noiseBuf;
function ensureAudio(){
  if(actx){ if(actx.state==='suspended') actx.resume(); return; }
  const AC=window.AudioContext||window.webkitAudioContext; actx=new AC();
  master=actx.createGain(); master.gain.value=0.9;
  comp=actx.createDynamicsCompressor(); comp.threshold.value=-12; comp.knee.value=20; comp.ratio.value=4; comp.attack.value=.003; comp.release.value=.15;
  master.connect(comp); comp.connect(actx.destination);
  const len=actx.sampleRate*2; noiseBuf=actx.createBuffer(1,len,actx.sampleRate); const d=noiseBuf.getChannelData(0);
  for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
}
function noise(){ const s=actx.createBufferSource(); s.buffer=noiseBuf; return s; }
function ge(g,t,pk,dc){ g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(pk,t+0.005); g.gain.exponentialRampToValueAtTime(0.0001,t+dc); }

// synth fallback voices (drums)
function sKick(t,v){ const o=actx.createOscillator(),g=actx.createGain(); o.frequency.setValueAtTime(150,t); o.frequency.exponentialRampToValueAtTime(48,t+0.11); ge(g,t,v,0.35); o.connect(g).connect(master); o.start(t); o.stop(t+0.4); }
function sSnare(t,v){ const s=noise(),bp=actx.createBiquadFilter(),g=actx.createGain(); bp.type='bandpass'; bp.frequency.value=1800; ge(g,t,v*0.8,0.18); s.connect(bp).connect(g).connect(master); s.start(t); s.stop(t+0.2); }
function sHatC(t,v){ const s=noise(),hp=actx.createBiquadFilter(),g=actx.createGain(); hp.type='highpass'; hp.frequency.value=7000; ge(g,t,v*0.5,0.05); s.connect(hp).connect(g).connect(master); s.start(t); s.stop(t+0.06); }
function sHatO(t,v){ const s=noise(),hp=actx.createBiquadFilter(),g=actx.createGain(); hp.type='highpass'; hp.frequency.value=7000; ge(g,t,v*0.5,0.3); s.connect(hp).connect(g).connect(master); s.start(t); s.stop(t+0.32); }
function sClap(t,v){ const s=noise(),bp=actx.createBiquadFilter(),g=actx.createGain(); bp.type='bandpass'; bp.frequency.value=1200; ge(g,t,v*0.7,0.16); s.connect(bp).connect(g).connect(master); s.start(t); s.stop(t+0.18); }
function sTom(t,v){ const o=actx.createOscillator(),g=actx.createGain(); o.frequency.setValueAtTime(160,t); o.frequency.exponentialRampToValueAtTime(90,t+0.15); ge(g,t,v*0.7,0.25); o.connect(g).connect(master); o.start(t); o.stop(t+0.3); }
function sRim(t,v){ const s=noise(),bp=actx.createBiquadFilter(),g=actx.createGain(); bp.type='bandpass'; bp.frequency.value=1700; bp.Q.value=3; ge(g,t,v*0.5,0.04); s.connect(bp).connect(g).connect(master); s.start(t); s.stop(t+0.05); }
function sCow(t,v){ [540,800].forEach(f=>{ const o=actx.createOscillator(),g=actx.createGain(); o.type='square'; o.frequency.value=f; ge(g,t,v*0.25,0.2); o.connect(g).connect(master); o.start(t); o.stop(t+0.22); }); }
const SDRUM=[sKick,sSnare,sHatC,sHatO,sClap,sTom,sRim,sCow];
function synthPluck(freq,t,v){ const o=actx.createOscillator(),lp=actx.createBiquadFilter(),g=actx.createGain(); o.type='triangle'; o.frequency.value=freq; lp.type='lowpass'; lp.frequency.value=3200; ge(g,t,v*0.7,0.3); o.connect(lp).connect(g).connect(master); o.start(t); o.stop(t+0.35); }
const noteFreq=n=>261.63*Math.pow(2,n/12);

// reversed buffer cache
function makeRev(buf){ const ch=buf.numberOfChannels, rb=actx.createBuffer(ch,buf.length,buf.sampleRate);
  for(let c=0;c<ch;c++){ const s=buf.getChannelData(c),d=rb.getChannelData(c),n=buf.length; for(let i=0;i<n;i++) d[i]=s[n-1-i]; } return rb; }
function getRev(s){ if(!s.rev) s.rev=makeRev(s.buffer); return s.rev; }

// ======== sample playback (explicit audio-clock time) ========
function playBufT(s,useRev,off,len,rate,vol,time){
  const buf=useRev?getRev(s):s.buffer, dur=s.buffer.duration;
  const src=actx.createBufferSource(); src.buffer=buf; src.playbackRate.value=rate;
  const g=actx.createGain(); g.gain.value=vol;
  const bq=actx.createBiquadFilter(); bq.type='lowpass'; bq.Q.value=0.9; bq.frequency.value=200*Math.pow(90,s.cut);
  src.connect(bq).connect(g).connect(master);
  let o=useRev?(dur-(off+len)):off; if(o<0)o=0;
  try{ src.start(time,o,Math.max(0.01,len)); }catch(e){}
}
