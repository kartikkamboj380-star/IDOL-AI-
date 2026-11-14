/**
 * Knowledge sources for the offline build.
 *
 * There is no GitHub form here on purpose: the device has no network, so a
 * repository URL would be a promise the app cannot keep. Instead the user picks
 * files — or a folder — from the phone, and they are parsed, indexed and stored
 * in IndexedDB on the spot.
 *
 * The dialog is honest about the trade: everything stays on the device, and the
 * app can only answer about what has actually been loaded. A first-run user gets
 * a one-tap way to load the bundled sample so the app is not an empty box.
 */
import { el, clear, formatBytes, formatNumber } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { openDialog, type DialogInstance } from './dialog.js';
import { showToast } from './toast.js';
import type { ApiSurface } from '../lib/local-api.js';
import type { KnowledgeSource } from '../types.js';

export interface DeviceSourcesOptions {
  api: ApiSurface;
  onSourcesChanged: () => void;
  /** Loads the demo corpus that ships inside the app. */
  loadSample: () => Promise<{ files: number; passages: number }>;
}

const TEXT_EXTENSIONS = [
  '.md', '.markdown', '.mdx', '.txt', '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.html',
  '.css', '.scss', '.vue', '.svelte', '.lua', '.r', '.dart', '.ex', '.exs', '.zig',
];

function looksLikeText(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  // Files with no extension are often READMEs, LICENSEs, Makefiles.
  return !lower.includes('.');
}

export function openDeviceSourcesDialog(options: DeviceSourcesOptions): void {
  const dialog = openDialog({
    title: 'Your documents',
    subtitle: 'Everything is indexed and searched on this device. No server, no upload.',
    wide: true,
  });
  void mount(dialog, options);
}

async function mount(dialog: DialogInstance, options: DeviceSourcesOptions): Promise<void> {
  const body = dialog.body;
  clear(body);

  body.append(buildImportPanel(dialog, options));
  body.append(el('div', { class: 'sources-divider' }));

  const list = el('div');
  body.append(list);
  await renderList(list, dialog, options);
}

function buildImportPanel(dialog: DialogInstance, options: DeviceSourcesOptions): HTMLElement {
  const panel = el('div', { class: 'device-import' });

  panel.append(
    el('h3', { class: 'device-import__title', text: 'Add files from this device' }),
    el('p', {
      class: 'device-import__hint',
      text: 'Pick a folder of notes, docs or source code. Text files only — images, PDFs and archives are skipped.',
    }),
  );

  const nameInput = el('input', {
    type: 'text',
    class: 'input',
    placeholder: 'Name for this set, e.g. "My project"',
    value: '',
  }) as HTMLInputElement;

  const status = el('div', { class: 'device-import__status' });

  const fileInput = el('input', {
    type: 'file',
    multiple: 'true',
    accept: TEXT_EXTENSIONS.join(','),
    style: 'display:none',
  }) as HTMLInputElement;

  const folderInput = el('input', {
    type: 'file',
    multiple: 'true',
    style: 'display:none',
  }) as HTMLInputElement;
  // Non-standard but supported by Android WebView and every Chromium browser:
  // a picker that returns a whole folder instead of individual files.
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.setAttribute('directory', '');

  const pickFiles = el('button', { type: 'button', class: 'btn btn--primary' }) as HTMLButtonElement;
  pickFiles.append(el('span', { text: 'Choose files' }));
  const pickFolder = el('button', { type: 'button', class: 'btn btn--ghost' }) as HTMLButtonElement;
  pickFolder.append(el('span', { text: 'Choose folder' }));

  const sampleButton = el('button', { type: 'button', class: 'btn btn--ghost' }) as HTMLButtonElement;
  sampleButton.append(el('span', { text: 'Load the built-in sample' }));

  const ingest = async (fileList: FileList | null): Promise<void> => {
    if (!fileList || fileList.length === 0) return;
    const files = [...fileList].filter((file) => looksLikeText(file.name) || looksLikeText(file.webkitRelativePath || ''));
    if (files.length === 0) {
      showToast('No text files in that selection.', { variant: 'error' });
      return;
    }

    status.textContent = `Reading ${files.length} file(s)…`;
    const docs: Array<{ path: string; text: string }> = [];
    let unreadable = 0;
    for (const file of files) {
      try {
        docs.push({ path: (file.webkitRelativePath || file.name).replace(/^\/+/, ''), text: await file.text() });
      } catch {
        unreadable += 1;
      }
    }
    if (docs.length === 0) {
      status.textContent = '';
      showToast('Those files could not be read.', { variant: 'error' });
      return;
    }

    status.textContent = `Indexing ${docs.length} file(s)…`;
    try {
      const name = nameInput.value.trim() || docs[0]?.path.split('/')[0] || 'My documents';
      const result = await options.api.addDocuments({ name, docs });
      const skipped = result.skipped.length + unreadable;
      showToast(
        skipped > 0
          ? `Indexed ${result.source.filesIndexed} file(s); skipped ${skipped}.`
          : `Indexed ${result.source.filesIndexed} file(s).`,
        { variant: 'success' },
      );
      status.textContent = '';
      options.onSourcesChanged();
      await mount(dialog, options);
    } catch (error) {
      status.textContent = '';
      showToast(error instanceof Error ? error.message : 'Indexing failed.', { variant: 'error' });
    }
  };

  fileInput.addEventListener('change', () => void ingest(fileInput.files));
  folderInput.addEventListener('change', () => void ingest(folderInput.files));
  pickFiles.addEventListener('click', () => fileInput.click());
  pickFolder.addEventListener('click', () => folderInput.click());

  sampleButton.addEventListener('click', () => {
    void (async () => {
      sampleButton.disabled = true;
      status.textContent = 'Loading the built-in sample…';
      try {
        const result = await options.loadSample();
        showToast(`Sample loaded: ${result.files} file(s), ${formatNumber(result.passages)} passages.`, { variant: 'success' });
        options.onSourcesChanged();
        await mount(dialog, options);
      } catch (error) {
        status.textContent = '';
        showToast(error instanceof Error ? error.message : 'Could not load the sample.', { variant: 'error' });
      } finally {
        sampleButton.disabled = false;
      }
    })();
  });

  panel.append(
    el('div', { class: 'device-import__name' }, nameInput),
    el('div', { class: 'device-import__actions' }, pickFiles, pickFolder, sampleButton),
    fileInput,
    folderInput,
    status,
  );

  return panel;
}

async function renderList(list: HTMLElement, dialog: DialogInstance, options: DeviceSourcesOptions): Promise<void> {
  clear(list);
  let sources: KnowledgeSource[] = [];
  try {
    sources = (await options.api.sources()).sources;
  } catch (error) {
    list.append(el('div', { class: 'search-empty', text: error instanceof Error ? error.message : 'Could not read your documents.' }));
    return;
  }

  if (sources.length === 0) {
    list.append(
      el(
        'div',
        { class: 'search-empty' },
        el('p', { text: 'No documents loaded yet. Add files above, or load the built-in sample to try the app.' }),
      ),
    );
    return;
  }

  for (const source of sources) {
    const row = el('div', { class: 'device-source' });
    const meta = el('div', { class: 'device-source__meta' });
    meta.append(
      el('strong', { text: source.name }),
      el(
        'span',
        { class: 'device-source__stats' },
        `${formatNumber(source.filesIndexed ?? 0)} file(s)`,
        ' · ',
        formatNumber(source.passages ?? 0),
        ' passages',
      ),
    );

    const remove = el('button', { type: 'button', class: 'btn btn--ghost btn--danger' }) as HTMLButtonElement;
    remove.innerHTML = `<span>Remove</span>`;
    remove.addEventListener('click', () => {
      void (async () => {
        remove.disabled = true;
        try {
          await options.api.removeSource(source.id);
          showToast('Removed.', { variant: 'success' });
          options.onSourcesChanged();
          await mount(dialog, options);
        } catch (error) {
          remove.disabled = false;
          showToast(error instanceof Error ? error.message : 'Could not remove it.', { variant: 'error' });
        }
      })();
    });

    row.append(meta, remove);
    list.append(row);
  }
}
