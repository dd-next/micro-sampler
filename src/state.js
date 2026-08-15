// ======== constants + mutable state ========
// ============ constants ============
const N=16;
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B','C+','C#+','D+','D#+'];
const FX_NAMES=['LOOP 16','LOOP 12','LOOP ¼','LOOP ⅛','UNISON','UNI LOW','OCT +','OCT −','STUT 4','STUT 3','SCRATCH','SCR FAST','6 / 8','RETRIG','REVERSE','— OFF'];
const TEMPOS=[{n:'HIP HOP',b:80},{n:'DISCO',b:120},{n:'TECHNO',b:140}];

// slots: 0-7 melodic, 8-15 drum
const slots=Array.from({length:N},(_,i)=>({type:i<8?'mel':'drum',buffer:null,rev:null,start:0,length:1,tune:0,vol:0.9,cut:1}));
// patterns: 16 patterns, each 16 tracks x 16 steps; cell = null | note(mel) | slice(drum)
const patterns=Array.from({length:N},()=>({tracks:Array.from({length:N},()=>new Array(N).fill(null))}));

let mode='keys', sel=0, curPat=0, bpm=120, tempoIx=1, swing=0;
let playing=false, live=false;
let currentStep=0, nextNoteTime=0, drawStepIx=-1, timerID=null;
const queue=[];

// fx state
let activeFX=null, loopWindow=null, stutterSub=0, octaveShift=0, unison=0, reverseOn=false, quant68=false, scratchNodes=null;
