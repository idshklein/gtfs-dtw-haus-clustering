import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSupportError, installClientErrorHandlers } from '../public/browser-support.mjs';

test('accepts a browser with all required client capabilities', () => {
  const environment = {
    fetch() {},
    Worker() {},
    WebAssembly: { instantiate() {} },
    indexedDB: {},
    caches: {},
  };

  assert.equal(browserSupportError(environment), null);
});

test('reports missing capabilities before data initialization', () => {
  const error = browserSupportError({
    fetch() {},
    Worker: undefined,
    WebAssembly: undefined,
    indexedDB: {},
    caches: undefined,
  });

  assert.match(error, /הדפדפן אינו נתמך/);
  assert.match(error, /Web Workers, WebAssembly, Cache Storage/);
});

test('keeps unhandled client diagnostics local and removable', () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const statuses = [];
  const errors = [];
  const statusElement = { set textContent(value) { statuses.push(value); } };
  const consoleObject = { error: (...args) => errors.push(args) };
  const removeHandlers = installClientErrorHandlers({ target, statusElement, consoleObject });

  listeners.get('error')({ message: 'failure', error: new Error('failure') });
  listeners.get('unhandledrejection')({ reason: new Error('rejected') });

  assert.equal(statuses.length, 2);
  assert.match(statuses[0], /פרטים מקומיים/);
  assert.equal(errors.length, 2);
  assert.equal(errors[0][0], 'Unhandled client error');
  assert.equal(errors[1][0], 'Unhandled promise rejection');

  removeHandlers();
  assert.equal(listeners.size, 0);
});
