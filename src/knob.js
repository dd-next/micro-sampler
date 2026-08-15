/* ======================================================================
   rotary knob widget
   ----------------------------------------------------------------------
   Drag vertically, roll the wheel, or focus it and use the arrow keys.
   Double-click (or Delete) returns it to its default. Bipolar knobs draw
   their arc out from the centre instead of up from the minimum.
   ====================================================================== */

const KNOB_SWEEP = 270;                       // degrees of travel
const KNOB_A0    = -135;                      // angle at the minimum
const KNOB_DRAG  = 190;                       // px of drag for the full range

function polar(cx, cy, r, deg){
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1){
  if (Math.abs(a1 - a0) < 0.15) return '';
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const big = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const dir = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${big} ${dir} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function makeKnob(el, opts){
  const o = Object.assign({
    name:'A', min:0, max:1, step:0.01, def:0,
    center:false,             // draw the arc out from the middle
    format:v => v.toFixed(2),
    tag:() => '',
    onInput:() => {},
    onGesture:() => {}        // fired on press/release, for parameter locks
  }, opts);

  el.innerHTML = `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path class="kn-trk" fill="none" stroke-linecap="round" stroke-width="7"></path>
      <path class="kn-arc" fill="none" stroke-linecap="round" stroke-width="7"></path>
      <circle class="kn-cap" cx="50" cy="50" r="27"></circle>
      <circle class="kn-rim" cx="50" cy="50" r="27" fill="none" stroke-width="1.5"></circle>
      <line class="kn-ptr" stroke-linecap="round" stroke-width="4"></line>
    </svg>
    <div class="kn-val"></div>
    <div class="kn-tag"></div>
    <div class="kn-name"></div>`;

  const trk = el.querySelector('.kn-trk');
  const arc = el.querySelector('.kn-arc');
  const ptr = el.querySelector('.kn-ptr');
  const valEl = el.querySelector('.kn-val');
  const tagEl = el.querySelector('.kn-tag');
  const nameEl = el.querySelector('.kn-name');

  trk.setAttribute('d', arcPath(50, 50, 40, KNOB_A0, KNOB_A0 + KNOB_SWEEP));

  el.tabIndex = 0;
  el.setAttribute('role', 'slider');

  let value = o.def;
  let dragging = false, startY = 0, startVal = 0;

  const clamp = v => Math.min(o.max, Math.max(o.min, v));
  const quant = v => {
    const n = Math.round((v - o.min) / o.step) * o.step + o.min;
    // step can be fractional — kill float drift
    return clamp(Math.round(n * 1e6) / 1e6);
  };
  const frac = v => (v - o.min) / (o.max - o.min || 1);

  function paint(){
    const f = frac(value);
    const a = KNOB_A0 + f * KNOB_SWEEP;
    const from = o.center ? KNOB_A0 + 0.5 * KNOB_SWEEP : KNOB_A0;
    arc.setAttribute('d', arcPath(50, 50, 40, Math.min(from, a), Math.max(from, a)));
    const [px, py] = polar(50, 50, 25, a);
    const [ix, iy] = polar(50, 50, 11, a);
    ptr.setAttribute('x1', ix.toFixed(2)); ptr.setAttribute('y1', iy.toFixed(2));
    ptr.setAttribute('x2', px.toFixed(2)); ptr.setAttribute('y2', py.toFixed(2));
    valEl.textContent = o.format(value);
    tagEl.textContent = o.tag(value);
    nameEl.textContent = o.name;
    el.setAttribute('aria-label', o.name);
    el.setAttribute('aria-valuemin', o.min);
    el.setAttribute('aria-valuemax', o.max);
    el.setAttribute('aria-valuenow', value);
    el.setAttribute('aria-valuetext', `${o.format(value)} ${o.tag(value)}`.trim());
  }

  function commit(v, fromUser){
    const nv = quant(v);
    if (nv === value && fromUser !== 'force') { paint(); return; }
    value = nv;
    paint();
    o.onInput(value);
  }

  /* ------------------------------------------------------------ pointer */
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    dragging = true; startY = e.clientY; startVal = value;
    el.setPointerCapture(e.pointerId);
    el.classList.add('grabbing');
    o.onGesture(true);
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();
    const fine = e.shiftKey ? 0.25 : 1;
    const dy = (startY - e.clientY) * fine;
    commit(startVal + (dy / KNOB_DRAG) * (o.max - o.min));
  });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('grabbing');
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    o.onGesture(false);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('dblclick', e => { e.preventDefault(); commit(o.def); });

  el.addEventListener('wheel', e => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const mult = e.shiftKey ? 1 : 4;
    commit(value + dir * o.step * mult);
  }, { passive:false });

  /* ----------------------------------------------------------- keyboard */
  el.addEventListener('keydown', e => {
    const big = (o.max - o.min) / 10;
    let handled = true;
    switch (e.key){
      case 'ArrowUp': case 'ArrowRight': commit(value + o.step); break;
      case 'ArrowDown': case 'ArrowLeft': commit(value - o.step); break;
      case 'PageUp':   commit(value + big); break;
      case 'PageDown': commit(value - big); break;
      case 'Home':     commit(o.min); break;
      case 'End':      commit(o.max); break;
      case 'Delete': case 'Backspace': commit(o.def); break;
      default: handled = false;
    }
    if (handled){ e.preventDefault(); e.stopPropagation(); }
  });

  paint();

  return {
    el,
    get value(){ return value; },
    set(v){ value = quant(v); paint(); },
    reconfigure(next){
      Object.assign(o, next);
      value = quant(next.value !== undefined ? next.value : value);
      paint();
    },
    setLocked(on){ el.classList.toggle('locked', !!on); }
  };
}
