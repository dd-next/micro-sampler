# micro sampler

A browser micro-sampler built with the raw Web Audio API. Sample through the
microphone into 16 slots, slice or pitch them, sequence 16 steps, and hold any
key for a punch-in effect.

No framework, no bundler, no dependencies. Open `index.html` and it runs.

**Live demo:** _(add your URL here)_

---

## Why

A hobby study of three things that are genuinely hard to get right in the
browser: sample-accurate timing, low-latency triggering, and a UI that behaves
like a physical instrument rather than a web page.

Inspired by pocket-sized hardware samplers. This is an independent
reimplementation of well-known sampler concepts — no vendor code, artwork,
fonts, or trademarks are used, and the interface is deliberately its own design.

## Features

- **16 slots.** 1–8 melodic (one sample played chromatically across the keys),
  9–16 drum (one sample auto-sliced into 16 pieces, one per key).
- **Mic sampling.** `getUserMedia` → `MediaRecorder` → `decodeAudioData`.
- **Waveform editor.** Drag either edge to set start point and length.
  Slice boundaries are drawn for drum slots.
- **Per-slot parameters.** Tune (±12 semitones), low-pass filter, volume.
- **Step sequencer.** 16 patterns × 16 tracks × 16 steps, with swing.
- **Live recording.** Punch notes and slices in while the pattern plays.
- **16 punch-in effects.** Loop 16/12/¼/⅛, unison, unison low, octave up/down,
  stutter 4/3, scratch, scratch fast, 6/8 quantize, retrigger, reverse, off.
- **Tempo presets** (80 / 120 / 140 BPM) plus fine tempo from 60–240.
- Empty slots fall back to synthesized drum and pluck voices, so the app is
  playable before you have sampled anything.

## Controls

| Mode | What the 4×4 grid does |
| --- | --- |
| `KEYS` | Plays the selected slot — chromatic notes (melodic) or slices (drum) |
| `SOUND` | Selects which of the 16 slots is active |
| `PATTERN` | Selects which of the 16 patterns is playing |
| `WRITE` | Toggles the 16 steps for the selected slot |
| `FX` | Hold a key to apply that punch-in effect |
| `REC` | Tap a slot to sample into it (auto-stops after 4 s) |

`LIVE` + `PLAY` records key presses into the pattern in real time.

## Architecture

Classic scripts sharing one global scope, loaded in dependency order. No build
step is used deliberately — it keeps the app runnable straight from the
filesystem, which matters for a tool you want to open and play immediately.

```
index.html          markup + script order
src/styles.css      all styling, themed with CSS custom properties
src/state.js        constants, slot model, pattern model, mutable state
src/audio.js        AudioContext graph, synth fallback voices, sample playback
src/sequencer.js    look-ahead scheduler and transport
src/fx.js           the 16 punch-in effects
src/ui.js           grid rendering, modes, waveform, recording, controls
src/main.js         starter pattern and boot
public/             web app manifest
```

### The one idea worth stealing: the scheduler

UI timers are not accurate enough to drive music — `setInterval` drift is
audible within a couple of bars. The engine instead uses the standard
look-ahead pattern: a coarse 25 ms timer wakes up, looks 100 ms into the
future, and schedules every note that falls in that window at an exact
`AudioContext.currentTime` offset.

```js
function scheduler(){
  while (nextNoteTime < actx.currentTime + AHEAD) {
    fireStep(currentStep, nextNoteTime);
    nextNoteTime += (60 / bpm) / 4;
    currentStep = (currentStep + 1) % 16;
  }
}
```

Audio is placed on the audio clock; the UI reads a queue afterwards and merely
draws what has already been scheduled. Sound never waits for a repaint.

### Playback model

A hit is one `AudioBufferSourceNode` started with an explicit offset and
duration, so trimming and slicing are sample-accurate rather than faded:

```js
src.start(time, offset, length);
```

Pitch is playback rate — `playbackRate = 2 ** (semitones / 12)` — which is why
one recording becomes a whole keyboard in melodic mode. Reverse is a
pre-computed mirrored copy of the buffer, cached per slot.

## Running locally

Open `index.html` in a browser. That is the whole setup.

Microphone access needs a secure context. `file://` works in most browsers, but
if yours refuses, serve it over localhost:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Tested on Chrome, Firefox, and Safari 14.1+.

## Deploying

It is a static site — any web server will do.

```bash
# copy to a VPS
rsync -av --delete ./ user@your-vps:/var/www/sampler/
```

A minimal nginx server block is included in `deploy/nginx.conf`. Serve it over
HTTPS: microphone capture is blocked on plain HTTP for anything that is not
localhost.

## Roadmap

- [ ] Persist patterns and samples to IndexedDB
- [ ] Pattern chaining into songs
- [ ] Export the mixdown to WAV
- [ ] Parameter locks per step
- [ ] Keyboard mapping for desktop play
- [ ] Service worker so it installs as a PWA

## License

MIT — see [LICENSE](LICENSE).
