/**
 * Repository browser: a lazy, directory-at-a-time tree over the *indexed*
 * files (so it never claims to show files that were not processed), plus a
 * reader with line numbers and syntax highlighting.
 */
import { api, ApiError } from '../lib/api.js';
import { clear, copyText, el, formatBytes } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { openDialog, type DialogInstance } from './dialog.js';
import { showToast } from './toast.js';
import type { FileResponse, KnowledgeSource, RepoTreeEntry } from '../types.js';

export interface FileBrowserOptions {
  initialPath?: string;
  highlightLines?: { start: number; end: number } | null;
}

export function openFileBrowser(source: KnowledgeSource, options: FileBrowserOptions = {}): void {
  const dialog = openDialog({
    title: source.name,
    subtitle: 'Files in this source that were indexed and can be searched.',
    wide: true,
    bodyClass: 'file-browser-body',
  });
  void mount(dialog, source, options);
}

async function mount(dialog: DialogInstance, source: KnowledgeSource, options: FileBrowserOptions): Promise<void> {
  const body = dialog.body;
  const browser = el('div', { class: 'file-browser' });

  const treePane = el('div', { class: 'file-browser__tree' });
  const contentPane = el('div', { class: 'file-browser__content' });
  contentPane.append(el('div', { class: 'search-empty', text: 'Select a file to read it.' }));

  browser.append(treePane, contentPane);
  body.append(browser);

  let currentDir = '';
  const contents = new Map<string, RepoTreeEntry[]>();

  const openFile = async (path: string): Promise<void> => {
    clear(contentPane);
    const header = el('div', { class: 'file-browser__content-header' });
    header.append(el('span', { class: 'file-browser__path', text: path }));
    contentPane.append(header);
    const loading = el('div', { class: 'search-empty', text: 'Loading file…' });
    contentPane.append(loading);

    try {
      const file = await api.file(source.id, path);
      renderFile(contentPane, header, file, options);
      // Mark the active row.
      for (const row of treePane.querySelectorAll<HTMLElement>('.tree-row')) {
        row.setAttribute('aria-current', String(row.dataset.path === path));
      }
    } catch (error) {
      clear(contentPane);
      contentPane.append(header);
      contentPane.append(
        el('div', {
          class: 'search-empty',
          text: error instanceof ApiError ? error.message : 'Could not load that file.',
        }),
      );
    }
  };

  const renderDir = async (path: string): Promise<void> => {
    currentDir = path;
    clear(treePane);

    const crumbs = el('div', { class: 'breadcrumb' });
    const rootButton = el('button', { type: 'button', class: 'breadcrumb__item', text: source.name });
    rootButton.addEventListener('click', () => void renderDir(''));
    crumbs.append(rootButton);
    const segments = path.split('/').filter(Boolean);
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const target = accumulated;
      crumbs.append(el('span', { class: 'breadcrumb__sep', text: '/' }));
      const button = el('button', { type: 'button', class: 'breadcrumb__item', text: segment });
      button.addEventListener('click', () => void renderDir(target));
      crumbs.append(button);
    }
    treePane.append(crumbs);

    let entries = contents.get(path);
    if (!entries) {
      const listing = el('div', { class: 'search-empty', text: 'Loading…' });
      treePane.append(listing);
      try {
        const response = await api.tree(source.id, path);
        entries = response.entries;
        contents.set(path, entries);
        listing.remove();
      } catch (error) {
        listing.textContent = error instanceof ApiError ? error.message : 'Could not list that directory.';
        return;
      }
    }

    if (path) {
      const up = el('button', { type: 'button', class: 'tree-row' });
      up.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.chevronLeft}</svg><span class="tree-row__name">..</span>`;
      up.addEventListener('click', () => {
        const parent = path.split('/').slice(0, -1).join('/');
        void renderDir(parent);
      });
      treePane.append(up);
    }

    if (entries.length === 0) {
      treePane.append(el('div', { class: 'search-empty', text: 'No indexed files in this directory.' }));
      return;
    }

    for (const entry of entries) {
      const row = el('button', {
        type: 'button',
        class: 'tree-row',
        'data-path': entry.path,
        title: entry.path,
      });
      const icon = entry.type === 'dir' ? icons.folder : icons.file;
      row.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span class="tree-row__name"></span>`;
      const nameNode = row.querySelector('.tree-row__name');
      if (nameNode) nameNode.textContent = entry.path.split('/').pop() ?? entry.path;
      if (entry.type === 'file' && entry.size) {
        const size = el('span', { class: 'tree-row__size', text: formatBytes(entry.size) });
        row.append(size);
      }
      row.addEventListener('click', () => {
        if (entry.type === 'dir') void renderDir(entry.path);
        else void openFile(entry.path);
      });
      treePane.append(row);
    }
  };

  const initial = options.initialPath ?? '';
  const initialDir = initial.includes('/') ? initial.split('/').slice(0, -1).join('/') : '';
  await renderDir(initialDir);
  if (initial) void openFile(initial);
}

function renderFile(
  contentPane: HTMLElement,
  header: HTMLElement,
  file: FileResponse,
  options: FileBrowserOptions,
): void {
  clear(contentPane);
  header.replaceChildren();
  const pathNode = el('span', { class: 'file-browser__path', text: file.path });
  header.append(pathNode);

  const actions = el('div', { class: 'code-block__actions' });

  const copy = el('button', { type: 'button', class: 'code-block__copy', 'aria-label': 'Copy file contents' });
  copy.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.copy}</svg><span>Copy</span>`;
  copy.addEventListener('click', async () => {
    const ok = await copyText(file.content);
    showToast(ok ? 'File copied' : 'Copy failed', { variant: ok ? 'success' : 'error' });
  });
  actions.append(copy);

  if (file.htmlUrl) {
    const link = el('a', {
      class: 'code-block__copy',
      href: file.htmlUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    link.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.external}</svg><span>GitHub</span>`;
    actions.append(link);
  }

  header.append(actions);
  contentPane.append(header);

  const pre = el('pre', { class: 'file-browser__pre' });
  const code = el('code');
  const lines = file.content.split('\n');
  const fragment = document.createDocumentFragment();
  const highlight = options.highlightLines;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const numberSpan = el('span', { class: 'line-number', text: String(lineNumber) });
    if (highlight && lineNumber >= highlight.start && lineNumber <= highlight.end) {
      numberSpan.style.color = 'var(--accent)';
      numberSpan.style.opacity = '1';
    }
    fragment.append(numberSpan, document.createTextNode(`${line}\n`));
  });
  code.append(fragment);
  pre.append(code);
  contentPane.append(pre);

  if (file.truncated) {
    contentPane.append(
      el('div', {
        class: 'file-browser__notice',
        text: `This file is larger than the configured limit and is shown truncated (${formatBytes(file.size)} total).`,
      }),
    );
  }
  if (file.citations > 0) {
    contentPane.append(
      el('div', {
        class: 'file-browser__notice',
        text: `Indexed as ${file.citations} searchable passage${file.citations === 1 ? '' : 's'} (${file.language}).`,
      }),
    );
  }
}
