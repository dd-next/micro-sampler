# micro sampler

A browser micro-sampler built on the raw Web Audio API. Sample through the
microphone into 16 slots, slice or pitch them, sequence 16 patterns, chain
them into a song, and hold any key for a punch-in effect.

No framework, no bundler, no runtime dependencies. Open `index.html` and it
runs. Works with a mouse, a touchscreen, or the computer keyboard.

**Live demo:** https://dd-next.github.io/micro-sampler/

---

## What this is

An independent, non-commercial reimplementation of the workflow described in
the [Teenage Engineering PO-33 manual](https://teenage.engineering/guides/po-33/en),
written from that public documentation for personal use. No vendor code,
artwork, fonts, samples or trademarks are used — the interface is its own
design, and the name is its own. It is not affiliated with or endorsed by
Teenage Engineering.

Behind the interface it is a study of three things that are genuinely hard
to get right in a browser: sample-accurate timing, low-latency triggering,
and a UI that behaves like an instrument rather than a web page.

## Features

- **16 sound slots** sharing one **40-second memory pool**. 1–8 melodic (one
  sound played chromatically across the keys), 9–16 drum (one sound cut into
  16 slices, one per key).
- **Hold-to-sample.** Hold `REC` and hold a key: the microphone records for
  exactly as long as you hold it, straight into a Float32 buffer. No
  container, no codec, no decode step.
- **Waveform editor.** Drag either edge to trim. Drum slices are drawn
  individually and each one can be nudged on its own.
- **Two knobs, three pages.** `TONE` (tune, volume), `FILTER` (a single knob
  sweeping low-pass → open → high-pass, plus resonance), `TRIM` (start,
  length).
- **Step sequencer.** 16 patterns × 16 tracks × 16 steps, with swing.
- **Pattern chaining** up to 128 bars.
- **Live punch-in**, quantized to the nearest step.
- **Parameter locks.** Hold `WRITE` while playing and turn a knob to pin that
  value to the current step.
- **16 punch-in effects**, holdable several at a time, and saveable into a
  pattern.
- **Everything persists** to IndexedDB on your device, and nothing is ever
  uploaded.
- **Installs as a PWA** and works offline.
- Empty slots play synthesised drum and pluck voices, so the instrument is
  playable before you have sampled anything.

## Controls

Mode buttons work two ways: **tap to latch**, or **hold as a modifier**. The
hardware only does the second; on a touchscreen you often have a hand free,
so both are supported.

| Mode | What the 4×4 grid does |
| --- | --- |
| *(none)* | `KEYS` — plays the selected sound: chromatic notes, or slices |
| `SOUND` | Selects which of the 16 sounds is active |
| `PATTERN` | Selects a pattern. **Hold** and press several keys to chain them |
| `WRITE` | Stopped: keys are the 16 steps, tap to toggle. Playing: keys punch in, quantized |
| `FX` | Hold a key to apply that effect. With `WRITE` also on, it is saved into the pattern |
| `REC` | Hold a key to sample into that slot for as long as you hold it |
| `BPM` | Keys 1–16 set master volume |

Other controls: `PLAY`, `LIVE` (record from `KEYS` without holding `WRITE`),
`CLR` (clear the current sound's track), tempo preset, fine tempo, swing,
master volume, and per-sound `del` / `reverse` / `re-slice` / `copy`.

### Keyboard

```
1 2 3 4     the 16 keys            Space   play / stop
Q W E R                            `       cycle tone / filter / trim
A S D F     5 6 7 8 9 0            ← →     previous / next sound
Z X C V     the six modes          ↑ ↓     knob A   (Shift: knob B)
                                   [ ]     tempo −/+
                                   L       live record
                                   Esc     drop all effects and latches
```

Press `?` for the in-app guide. Every control is also reachable by `Tab` and
operable from the keyboard, knobs included.

### Where this deliberately differs from the hardware

- The instrument is laid out as one screenful: the sound editor sits under
  the title, the display above the pads, and the pads take whatever height is
  left, so nothing scrolls on a phone. Everything explanatory lives in a
  single guide behind the `?` button rather than in the interface.
- Tempo, swing and master volume have their own on-screen sliders rather than
  hiding behind `BPM` + knob. `BPM` + keys still sets volume.
- The parameter page is a visible `TONE / FILTER / TRIM` selector rather than
  a second function of the `FX` button, which on a screen is a guessing game.
- In `WRITE` step mode the note written is the last note you played, shown in
  the LCD, so melodic patterns can be typed in without punching them live.
- An effect saved into a pattern stays engaged until another effect step, or
  a saved `— OFF`. On the hardware it is momentary.

## Architecture

Classic scripts sharing one global scope, loaded in dependency order. The
absence of a build step is deliberate: it keeps the app runnable straight off
the filesystem, which matters for something you want to open and play.

```
index.html          markup and script order
src/styles.css      all styling, themed with CSS custom properties
src/state.js        constants, slot model, pattern model, memory pool
src/audio.js        graph, synth voices, filter, sample playback
src/record.js       microphone capture into the memory pool
src/fx.js           the 16 punch-in effects
src/sequencer.js    look-ahead scheduler, chaining, parameter locks
src/knob.js         the rotary knob widget
src/wave.js         waveform drawing, trimming, slice editing
src/ui.js           grid, modes, LCD, transport
src/keys.js         desktop keyboard
src/persist.js      IndexedDB
src/main.js         boot
sw.js               offline shell
scripts/            icon generation and static checks — never shipped
```

### The one idea worth stealing: the scheduler

UI timers are not accurate enough to drive music — `setInterval` drift is
audible within a couple of bars. The engine uses the standard look-ahead
pattern: a coarse 25 ms timer wakes up, looks 100 ms into the future, and
schedules every note in that window at an exact `AudioContext` time.

```js
while (nextNoteTime < actx.currentTime + AHEAD) {
  try { fireStep(currentStep, playT); }
  catch (err) { console.error('step failed', err); }   // never skip the advance
  advanceStep();
  nextNoteTime += stepDur();
}
```

The `try` matters more than it looks. The advance happens after the step
fires, so anything that throws inside a voice would leave `nextNoteTime`
where it was, and the same step would be retried every 25 ms forever — a
silent, permanently wedged transport. Audio goes on the audio clock; the UI
reads a queue afterwards and draws what has already been scheduled.

### Playback model

A hit is one `AudioBufferSourceNode` started with an explicit offset and
duration, so trims and slices are sample-accurate rather than faded:

```js
src.start(time, offset, length);
```

Pitch is playback rate — `playbackRate = 2 ** (semitones / 12)` — which is
why one recording becomes a whole keyboard in melodic mode. Reverse is a
pre-computed mirrored copy, cached per slot. Every voice builds its own
filter and gain and disconnects them when the source ends, so the master bus
does not accumulate dead nodes.

### Recording

Capture runs in an `AudioWorklet` loaded from a blob URL, falling back to a
`ScriptProcessorNode` where that is unavailable. Samples arrive as raw
Float32 blocks and are concatenated on key-up — but only after the worklet
has acknowledged the stop, because its final partial block is posted
asynchronously and assembling immediately silently truncates the tail.

The microphone stream is opened when you enter `REC` and its tracks are
stopped when you leave, so the browser's recording indicator does not stay
lit for the whole session.

## Running locally

Open `index.html` in a browser. That is the whole setup.

Microphone access needs a secure context. `file://` works in some browsers;
if yours refuses, serve it over localhost:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Tested on Chrome, Firefox and Safari.

## Checks

There is no build, but there are checks — run them before pushing:

```bash
node scripts/check.js && npx eslint src sw.js scripts
```

`scripts/check.js` verifies that every `<script src>` resolves, that the
service worker caches everything the page loads, and that no two files
declare the same global — the one failure mode a shared global scope invites.
It also writes `.eslint-globals.json`, so `no-undef` catches cross-file typos
without anyone maintaining a list of globals by hand. Run it before eslint.

Regenerate the icons after editing `scripts/make-icons.js`:

```bash
node scripts/make-icons.js
```

## Deploying

It is a static site — any web server will do. Ship `index.html`, `sw.js`,
`src/` and `public/`.

```bash
rsync -av --delete index.html sw.js src public user@your-vps:/var/www/sampler/
```

A hardened nginx server block is in [deploy/nginx.conf](deploy/nginx.conf).
Serve it over HTTPS: microphone capture is blocked on plain HTTP for anything
that is not localhost. Pushing to `main` also deploys to GitHub Pages via
[the workflow](.github/workflows/pages.yml).

## Roadmap

- [ ] Export the mixdown to WAV
- [ ] Import a sound from a file, not just the microphone
- [ ] Per-step probability and micro-timing
- [ ] MIDI in, so external keys can play the slots
- [ ] Sound-level undo

## License

MIT — see [LICENSE](LICENSE).
