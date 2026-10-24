const REQUIRED_CAPABILITIES = [
  ['Fetch API', (environment) => typeof environment.fetch === 'function'],
  ['Web Workers', (environment) => typeof environment.Worker === 'function'],
  ['WebAssembly', (environment) => typeof environment.WebAssembly?.instantiate === 'function'],
  ['IndexedDB', (environment) => Boolean(environment.indexedDB)],
  ['Cache Storage', (environment) => Boolean(environment.caches)],
];

export function browserSupportError(environment = globalThis) {
  const missing = REQUIRED_CAPABILITIES
    .filter(([, isAvailable]) => !isAvailable(environment))
    .map(([name]) => name);

  return missing.length
    ? `הדפדפן אינו נתמך: חסרות בו תכונות נדרשות (${missing.join(', ')}). יש לפתוח את האתר ב-Chrome עדכני דרך HTTPS.`
    : null;
}

export function installClientErrorHandlers({
  target = globalThis.window,
  statusElement = null,
  consoleObject = globalThis.console,
} = {}) {
  if (typeof target?.addEventListener !== 'function') {
    throw new TypeError('A window-like event target is required');
  }

  const report = (status, label, detail) => {
    if (statusElement) statusElement.textContent = status;
    consoleObject.error(label, detail);
  };
  const onError = (event) => report(
    'שגיאת JavaScript לא צפויה. פרטים מקומיים זמינים ב-Console.',
    'Unhandled client error',
    event.error || event.message,
  );
  const onRejection = (event) => report(
    'פעולה נכשלה באופן לא צפוי. פרטים מקומיים זמינים ב-Console.',
    'Unhandled promise rejection',
    event.reason,
  );

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);

  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
