/* Static checks for a project with no build step.
   Run: node scripts/check.js

   The app is classic scripts sharing one global scope, so the two things
   that actually break it are a script tag that points at nothing and two
   files declaring the same name. Both are checked here. The script also
   writes the list of project globals that eslint uses for no-undef, so
   that list never has to be maintained by hand.                          */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const fail = m => { console.error('  ✗ ' + m); failed++; };
const pass = m => console.log('  ✓ ' + m);

/* ---- 1. every script tag resolves, and load order is what we think ---- */
const html = read('index.html');
const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

if (!srcs.length) fail('index.html has no script tags');
for (const s of srcs){
  if (!fs.existsSync(path.join(ROOT, s))) fail(`index.html loads ${s}, which does not exist`);
}
const onDisk = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).sort();
const loaded = srcs.filter(s => s.startsWith('src/')).map(s => s.slice(4)).sort();
for (const f of onDisk){
  if (!loaded.includes(f)) fail(`src/${f} exists but index.html never loads it`);
}
if (!failed) pass(`${srcs.length} scripts load in order: ${srcs.map(s => path.basename(s)).join(' → ')}`);

/* ---- 2. the service worker caches exactly what the page needs --------- */
const sw = read('sw.js');
const shell = [...sw.matchAll(/^\s*'([^']+)',?$/gm)].map(m => m[1]);
const missingFromShell = srcs.filter(s => !shell.includes(s));
if (missingFromShell.length) fail(`sw.js does not cache: ${missingFromShell.join(', ')}`);
for (const f of shell){
  if (f === './') continue;
  if (!fs.existsSync(path.join(ROOT, f))) fail(`sw.js caches ${f}, which does not exist`);
}
if (!missingFromShell.length) pass(`service worker shell covers all ${shell.length} assets`);

/* ---- 3. concatenate in load order: catches cross-file redeclaration --- */
const bundle = srcs
  .filter(s => s.startsWith('src/'))
  .map(s => read(s))
  .join('\n;\n');
const tmp = path.join(require('os').tmpdir(), 'sampler-bundle-check.js');
fs.writeFileSync(tmp, bundle);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio:'pipe' });
  pass('all sources share one global scope without a name collision');
} catch (e){
  fail('concatenated sources do not parse — most likely two files declare the same name:\n' +
       String(e.stderr || e.message).split('\n').slice(0, 6).map(l => '      ' + l).join('\n'));
}
fs.unlinkSync(tmp);

/* ---- 4. export the project's globals for eslint ---------------------- */
/* Split a declarator list on the commas that separate bindings, ignoring
   commas nested inside an initialiser. `a = 1, b = f(x, y), c` → 3 parts. */
function splitDeclarators(text){
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0){ parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

const globals = new Set();
for (const s of srcs.filter(x => x.startsWith('src/'))){
  const text = read(s);
  for (const m of text.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) globals.add(m[1]);
  // top-level `const`/`let`/`var`, including `let a = 1, b = 2, c;`
  for (const m of text.matchAll(/^(?:const|let|var)\s+(.+?);?\s*$/gm)){
    for (const part of splitDeclarators(m[1])){
      const name = part.split('=')[0].trim().replace(/^[{[]|[}\]]$/g, '').split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) globals.add(name);
    }
  }
}
fs.writeFileSync(
  path.join(ROOT, '.eslint-globals.json'),
  JSON.stringify([...globals].sort(), null, 2) + '\n'
);
pass(`${globals.size} project globals exported for lint`);

if (failed){
  console.error(`\n${failed} problem${failed > 1 ? 's' : ''} found.`);
  process.exit(1);
}
console.log('\nall checks passed.');
