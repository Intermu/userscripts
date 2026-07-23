// Flat ESLint config for the BWN userscripts repo (GOAL B of the phase-2 tooling plan).
//
// Deliberately MINIMAL. It targets real defects (duplicate keys, unreachable code,
// bad regexes, undefined globals) — NOT code style. These scripts predate any linter
// and ship as-is; this config must never demand a style rewrite.
//
// No package.json / node_modules in this repo: CI runs `npx eslint`, so this file
// imports nothing. It uses only the parser + core rules bundled with eslint, and
// declares its globals inline (rather than importing the `globals` package).
//
// ES5-friendly: sourceType 'script' (these are @require/@resource userscripts, not ES
// modules). ecmaVersion is set to 2021 rather than literally 5 so an incidental modern
// token can never turn a lint run into a false PARSE failure; the code itself is ES5.

function readonly(names) {
  const out = {};
  for (const n of names) out[n] = 'readonly';
  return out;
}

// Core ECMAScript built-ins (not auto-provided in flat config without the globals pkg).
const ES = readonly([
  'globalThis', 'Object', 'Array', 'Function', 'Boolean', 'Number', 'String', 'Symbol',
  'BigInt', 'Math', 'Date', 'RegExp', 'JSON', 'Error', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'ArrayBuffer', 'DataView', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'Intl', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'NaN', 'Infinity', 'undefined', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape', 'eval',
]);

// Browser / DOM host environment.
const BROWSER = readonly([
  'window', 'document', 'console', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'FormData', 'Headers',
  'Request', 'Response', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
  'atob', 'btoa', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent',
  'EventTarget', 'Node', 'NodeList', 'Element', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement', 'HTMLButtonElement',
  'DocumentFragment', 'DOMParser', 'XMLSerializer', 'XPathResult', 'getComputedStyle',
  'alert', 'confirm', 'prompt', 'performance', 'crypto', 'WebSocket', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone', 'Image', 'CSS',
  'self', 'top', 'parent', 'frames', 'FileList', 'DataTransfer', 'ClipboardEvent',
  // libraries commonly injected alongside userscripts
  'jQuery', '$',
]);

// Greasemonkey / Tampermonkey APIs granted via @grant.
const GM = readonly([
  'unsafeWindow', 'GM', 'GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue',
  'GM_listValues', 'GM_addValueChangeListener', 'GM_removeValueChangeListener',
  'GM_getResourceText', 'GM_getResourceURL', 'GM_addStyle', 'GM_addElement',
  'GM_xmlhttpRequest', 'GM_download', 'GM_openInTab', 'GM_registerMenuCommand',
  'GM_unregisterMenuCommand', 'GM_notification', 'GM_setClipboard', 'GM_getTab',
  'GM_saveTab', 'GM_getTabs', 'GM_log', 'GM_cookie', 'GM_webRequest',
]);

// Node.js environment for the scripts/ test harnesses.
const NODE = readonly([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer',
  'global', 'globalThis', 'console', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'queueMicrotask', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder',
]);

// Correctness rules only — every one flags a probable bug, none enforce style.
const correctness = {
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': ['error', 'always'],
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-func-assign': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unexpected-multiline': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',
  'no-invalid-regexp': 'error',
  'no-misleading-character-class': 'error',
  'no-empty-pattern': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-debugger': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
  // userscripts legitimately match control chars in scraped DOM text
  'no-control-regex': 'off',
};

export default [
  { ignores: ['browser-use/**', '.git/**', '.github/**'] },

  {
    files: ['**/*.user.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: { ...ES, ...BROWSER, ...GM },
    },
    rules: {
      ...correctness,
      // Reports references to globals not in the list above (undefined-global check).
      // Advisory today (the CI lint job is non-blocking) because Umbrava/app globals are
      // not yet fully enumerated; extend the BROWSER list or add /* global X */ as they
      // surface, then promote the lint job to a hard gate.
      'no-undef': 'error',
      // The scripts carry intentional scaffolding; unused-var churn is out of scope here.
      'no-unused-vars': 'off',
    },
  },

  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: { ...ES, ...NODE },
    },
    rules: {
      ...correctness,
      'no-undef': 'error',
      'no-unused-vars': 'off',
    },
  },
];
