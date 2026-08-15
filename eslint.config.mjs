/* Flat config. The project globals come from scripts/check.js, which reads
   them out of the sources, so no-undef stays useful without anyone having
   to maintain a list by hand. Run `node scripts/check.js` first.         */
import fs from 'node:fs';

const projectGlobals = Object.fromEntries(
  JSON.parse(fs.readFileSync(new URL('./.eslint-globals.json', import.meta.url), 'utf8'))
    .map(name => [name, 'writable'])
);

const browserGlobals = [
  'window', 'document', 'navigator', 'location', 'console', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'AudioContext', 'AudioWorkletNode', 'MediaRecorder', 'Blob', 'URL',
  'Float32Array', 'Uint8Array', 'Event', 'KeyboardEvent', 'indexedDB',
  'confirm', 'fetch', 'Request', 'Response', 'caches', 'self', 'clients', 'registerProcessor',
  'AudioWorkletProcessor', 'Promise', 'Set', 'Map', 'Math', 'JSON',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Error', 'isFinite'
];

export default [
  {
    files: ['src/**/*.js', 'sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...Object.fromEntries(browserGlobals.map(g => [g, 'readonly'])),
        ...projectGlobals
      }
    },
    rules: {
      'no-undef': 'error',
      // Top-level names are the shared global scope and are used across
      // files by design, so only check bindings inside functions.
      'no-unused-vars': ['warn', { vars:'local', args:'none', caughtErrors:'none' }],
      // Declaring a project global is not a redeclaration of it.
      'no-redeclare': ['error', { builtinGlobals:false }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'eqeqeq': ['warn', 'smart']
    }
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require:'readonly', module:'readonly', process:'readonly',
        __dirname:'readonly', console:'readonly', Buffer:'readonly'
      }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' }
  }
];
