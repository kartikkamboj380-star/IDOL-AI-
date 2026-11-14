/**
 * Resolves the theme before first paint.
 *
 * This is a separate file, not an inline script, because the production CSP is
 * `script-src 'self'` with no `unsafe-inline`: an inline block would be blocked
 * and every load would flash the wrong background.
 */
(function () {
  try {
    // Must match PREFERENCES_KEY in web/src/lib/storage.ts.
    var raw = window.localStorage.getItem('idol.preferences.v1');
    var saved = raw ? JSON.parse(raw) : null;
    var choice = (saved && saved.theme) || 'system';
    var dark =
      choice === 'dark' ||
      (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = dark ? '#171715' : '#faf9f5';
    document.head.appendChild(meta);
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
