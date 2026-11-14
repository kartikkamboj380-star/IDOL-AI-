/**
 * The two screens that only make sense with a server behind them.
 *
 * Loading a repository from GitHub, and reading a file out of it, are server
 * operations. The offline build offers neither, so this module is the single
 * place the rest of the app reaches for them. Vite's `__IDOL_DEVICE__` guard is
 * constant-folded: the device build keeps only the `throw`, and the imports
 * disappear with it — which is why the APK carries no fetch code at all.
 */

export async function openServerSources(options: { onSourcesChanged: () => void }): Promise<void> {
  if (__IDOL_DEVICE__) {
    throw new Error('The offline build loads files from the device, not from a repository.');
  }
  const { openSourcesDialog } = await import('../components/sources-dialog.js');
  openSourcesDialog(options);
}

export async function openServerFile(
  source: Parameters<typeof import('../components/file-browser.js')['openFileBrowser']>[0],
  options: Parameters<typeof import('../components/file-browser.js')['openFileBrowser']>[1],
): Promise<void> {
  if (__IDOL_DEVICE__) {
    throw new Error('The offline build has no repository files to browse.');
  }
  const { openFileBrowser } = await import('../components/file-browser.js');
  openFileBrowser(source, options);
}
