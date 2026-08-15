// ======== boot ========
[0,4,8,12].forEach(s=>patterns[0].tracks[8][s]=0);   // slot 9 (drum) kick-ish slice0
[4,12].forEach(s=>patterns[0].tracks[9][s]=0);        // slot 10 snare
[0,2,4,6,8,10,12,14].forEach(s=>patterns[0].tracks[10][s]=0); // slot 11 hat
selectSlot(0); syncTempoLabels(); renderGrid();
