/**
 * Knowledge source manager: add a GitHub repository, watch indexing progress,
 * re-index, remove, and open the file browser. Also hosts the GitHub
 * connection panel (token is posted to the server and never stored client-side).
 */
import { api, ApiError } from '../lib/api.js';
import { el, formatBytes, formatNumber, relativeTime, clear } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { openDialog, type DialogInstance } from './dialog.js';
import { openFileBrowser } from './file-browser.js';
import { showToast } from './toast.js';
import type { GitHubConnection, KnowledgeSource } from '../types.js';

export interface SourcesDialogOptions {
  onSourcesChanged: () => void;
  initialRepo?: string;
}

export function openSourcesDialog(options: SourcesDialogOptions): void {
  const dialog = openDialog({
    title: 'Knowledge sources',
    subtitle: 'Repositories that IDOL AI is allowed to search. Indexing happens on the server.',
    wide: true,
  });

  void mountSources(dialog, options);
}

async function mountSources(dialog: DialogInstance, options: SourcesDialogOptions): Promise<void> {
  const body = dialog.body;
  clear(body);

  const addForm = buildAddForm(dialog, options);
  body.append(addForm);

  const connection = el('div');
  body.append(connection);
  void mountConnection(connection, dialog, options);

  const listSection = el('div');
  body.append(listSection);

  const loading = el('div', { class: 'search-empty', text: 'Loading sources…' });
  listSection.append(loading);

  async function refresh(): Promise<void> {
    try {
      const { sources } = await api.sources();
      renderSources(listSection, sources, {
        onChanged: () => {
          options.onSourcesChanged();
          void refresh();
        },
        onBrowse: (source) => openFileBrowser(source),
      });
    } catch (error) {
      clear(listSection);
      listSection.append(errorNotice(error, () => void refresh()));
    }
  }

  await refresh();
  // Poll while any source is still indexing so progress updates live.
  const poll = window.setInterval(() => {
    if (!document.body.contains(dialog.root)) {
      window.clearInterval(poll);
      return;
    }
    const indexing = listSection.querySelector('[data-indexing="true"]');
    if (indexing) void refresh();
  }, 2500);

  if (options.initialRepo) {
    const input = addForm.querySelector<HTMLInputElement>('input[name="repository"]');
    if (input) input.value = options.initialRepo;
  }
}

function buildAddForm(dialog: DialogInstance, options: SourcesDialogOptions): HTMLElement {
  const form = el('form', { class: 'field', style: 'gap:8px' });
  form.append(el('label', { class: 'field__label', for: 'repo-input', text: 'Add a GitHub repository' }));

  const row = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  const input = el('input', {
    class: 'input',
    id: 'repo-input',
    name: 'repository',
    type: 'text',
    placeholder: 'owner/repo or https://github.com/owner/repo',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'repo-hint',
  }) as HTMLInputElement;
  input.style.flex = '1 1 240px';

  const refInput = el('input', {
    class: 'input input--mono',
    name: 'ref',
    type: 'text',
    placeholder: 'branch (optional)',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  refInput.style.flex = '0 1 150px';

  const submit = el('button', { type: 'submit', class: 'button button--primary' });
  submit.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.plus}</svg><span>Add &amp; index</span>`;

  row.append(input, refInput, submit);
  const hint = el('p', {
    class: 'field__hint',
    id: 'repo-hint',
    text: 'Public repositories work without a token within GitHub’s anonymous rate limit. A token raises limits and unlocks private repositories.',
  });
  const error = el('p', { class: 'field__error' });
  error.hidden = true;

  form.append(row, hint, error);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const repository = input.value.trim();
    if (!repository) {
      error.textContent = 'Enter a repository as "owner/repo".';
      error.hidden = false;
      input.focus();
      return;
    }
    submit.disabled = true;
    const original = submit.innerHTML;
    submit.replaceChildren(el('span', { class: 'button__spinner' }), el('span', { text: 'Indexing…' }));
    try {
      const { source } = await api.addSource({
        kind: 'github',
        repository,
        ref: refInput.value.trim() || undefined,
      });
      showToast(`Indexed ${source.filesIndexed ?? 0} files from ${source.name}`, { variant: 'success' });
      input.value = '';
      refInput.value = '';
      options.onSourcesChanged();
      // Re-render this dialog's list.
      dialog.close();
      openSourcesDialog(options);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not add that repository.';
      error.textContent = message;
      error.hidden = false;
      submit.disabled = false;
      submit.innerHTML = original;
    }
  });

  return form;
}

async function mountConnection(container: HTMLElement, dialog: DialogInstance, options: SourcesDialogOptions): Promise<void> {
  let connection: GitHubConnection | null = null;
  try {
    connection = await api.github();
  } catch {
    connection = null;
  }

  const section = el('div', { class: 'field' });
  const header = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
  const stateDot = el('span', {
    class: 'status-dot',
    'data-status': connection?.authenticated ? 'ok' : 'warn',
  });
  header.append(
    stateDot,
    el('span', { class: 'field__label', text: connection?.authenticated ? 'GitHub connected' : 'GitHub not connected' }),
  );
  if (connection?.login) {
    header.append(el('span', { class: 'pill', text: connection.login }));
  }
  if (connection?.tokenSource === 'env') {
    header.append(el('span', { class: 'pill', text: 'env var' }));
  }
  if (connection?.rateLimit) {
    header.append(
      el('span', {
        class: 'pill',
        text: `${formatNumber(connection.rateLimit.remaining)}/${formatNumber(connection.rateLimit.limit)} API left`,
      }),
    );
  }
  section.append(header);

  section.append(
    el('p', {
      class: 'field__hint',
      text: connection?.authenticated
        ? 'The token is stored server-side (encrypted at rest) and is never sent to the browser. It is only used for repository indexing.'
        : 'Without a token, indexing works for public repositories within GitHub’s 60 requests/hour anonymous limit. Add a fine-grained token with read-only Contents access for reliability and private repos.',
    }),
  );

  if (!connection?.envManaged) {
    if (!connection?.authenticated) {
      const form = el('form', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px' });
      const tokenInput = el('input', {
        class: 'input input--mono',
        type: 'password',
        placeholder: 'github_pat_… or ghp_…',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'GitHub personal access token',
      }) as HTMLInputElement;
      tokenInput.style.flex = '1 1 220px';
      const save = el('button', { type: 'submit', class: 'button button--secondary', text: 'Connect' });
      const error = el('p', { class: 'field__error' });
      error.hidden = true;
      form.append(tokenInput, save, error);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        const token = tokenInput.value.trim();
        if (!token) return;
        save.disabled = true;
        save.replaceChildren(el('span', { class: 'button__spinner' }), el('span', { text: 'Verifying…' }));
        try {
          const result = await api.saveToken(token);
          tokenInput.value = '';
          showToast(`Connected as ${result.login}`, { variant: 'success' });
          options.onSourcesChanged();
          dialog.close();
          openSourcesDialog(options);
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : 'Token rejected.';
          error.hidden = false;
          save.disabled = false;
          save.textContent = 'Connect';
        }
      });
      section.append(form);
    } else {
      const disconnect = el('button', { type: 'button', class: 'button button--danger button--small', text: 'Disconnect token' });
      disconnect.style.marginTop = '4px';
      disconnect.style.alignSelf = 'flex-start';
      disconnect.addEventListener('click', async () => {
        disconnect.disabled = true;
        try {
          await api.removeToken();
          showToast('GitHub token removed');
          options.onSourcesChanged();
          dialog.close();
          openSourcesDialog(options);
        } catch (caught) {
          showToast(caught instanceof ApiError ? caught.message : 'Could not remove the token.', { variant: 'error' });
          disconnect.disabled = false;
        }
      });
      section.append(disconnect);
    }
  } else {
    section.append(
      el('p', {
        class: 'field__hint',
        text: 'The token is provided by a server environment variable (GITHUB_TOKEN). Remove it and restart the server to disconnect.',
      }),
    );
  }

  container.append(section);
}

interface RenderOptions {
  onChanged: () => void;
  onBrowse: (source: KnowledgeSource) => void;
}

function renderSources(container: HTMLElement, sources: KnowledgeSource[], options: RenderOptions): void {
  clear(container);
  container.append(el('h3', { class: 'section-title', text: `Indexed sources (${sources.length})` }));

  if (sources.length === 0) {
    container.append(
      el('div', {
        class: 'search-empty',
        text: 'No sources yet. Add a repository above and it will be indexed in a few seconds.',
      }),
    );
    return;
  }

  const cards = el('div', { class: 'source-cards' });
  for (const source of sources) {
    cards.append(renderSourceCard(source, options));
  }
  container.append(cards);
}

function renderSourceCard(source: KnowledgeSource, options: RenderOptions): HTMLElement {
  const card = el('div', { class: 'source-card', 'data-status': source.status, 'data-indexing': String(source.status === 'indexing') });

  const top = el('div', { class: 'source-card__top' });
  const identity = el('div', { class: 'source-card__identity' });

  const name = el('div', { class: 'source-card__name' });
  name.append(statusDot(source.status), el('span', { text: source.name }));
  identity.append(name);

  const refText =
    source.kind === 'github'
      ? `${source.owner}/${source.repo}${source.resolvedRef ? ` @ ${source.resolvedRef.slice(0, 7)}` : ''}`
      : 'local checkout';
  identity.append(el('div', { class: 'source-card__ref', text: refText }));
  top.append(identity);
  card.append(top);

  if (source.status === 'indexing') {
    const progress = el('div', { class: 'source-card__progress' });
    progress.append(el('div', { class: 'source-card__progress-bar' }));
    card.append(progress);
  }

  const stats = el('div', { class: 'source-card__stats' });
  if (source.filesIndexed !== undefined) {
    stats.append(el('span', {}, el('strong', { text: formatNumber(source.filesIndexed) }), ' files'));
  }
  if (source.passages !== undefined) {
    stats.append(el('span', {}, el('strong', { text: formatNumber(source.passages) }), ' passages'));
  }
  if (source.bytesIndexed) stats.append(el('span', { text: formatBytes(source.bytesIndexed) }));
  if (source.skippedFiles) stats.append(el('span', { text: `${formatNumber(source.skippedFiles)} skipped` }));
  stats.append(el('span', { text: `indexed ${relativeTime(source.lastIndexedAt)}` }));
  card.append(stats);

  if (source.truncatedTree) {
    card.append(
      el('p', {
        class: 'field__hint',
        text: 'This repository is very large; indexing covered the most relevant documentation and source files within the configured cap.',
      }),
    );
  }

  if (source.lastError) {
    card.append(el('div', { class: 'source-card__error', text: source.lastError }));
  }

  const actions = el('div', { class: 'source-card__actions' });

  const browse = el('button', { type: 'button', class: 'button button--ghost button--small' });
  browse.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.folder}</svg><span>Browse</span>`;
  browse.addEventListener('click', () => options.onBrowse(source));
  actions.append(browse);

  const reindex = el('button', {
    type: 'button',
    class: 'button button--ghost button--small',
    disabled: source.status === 'indexing',
  });
  reindex.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.refresh}</svg><span>Re-index</span>`;
  reindex.addEventListener('click', async () => {
    reindex.disabled = true;
    try {
      await api.reindexSource(source.id, true);
      showToast(`Re-indexed ${source.name}`, { variant: 'success' });
      options.onChanged();
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Re-index failed.', { variant: 'error' });
      reindex.disabled = false;
    }
  });
  actions.append(reindex);

  if (source.htmlUrl) {
    const link = el('a', {
      class: 'button button--ghost button--small',
      href: source.htmlUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    link.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.github}</svg><span>GitHub</span>`;
    actions.append(link);
  }

  const remove = el('button', { type: 'button', class: 'button button--danger button--small' });
  remove.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.trash}</svg><span>Remove</span>`;
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Remove "${source.name}" from the knowledge index?`)) return;
    remove.disabled = true;
    try {
      await api.removeSource(source.id);
      showToast(`Removed ${source.name}`);
      options.onChanged();
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Could not remove source.', { variant: 'error' });
      remove.disabled = false;
    }
  });
  actions.append(remove);

  card.append(actions);
  return card;
}

function statusDot(status: KnowledgeSource['status']): HTMLElement {
  const map: Record<KnowledgeSource['status'], 'ok' | 'warn' | 'error'> = {
    ready: 'ok',
    indexing: 'warn',
    unconfigured: 'warn',
    stale: 'warn',
    rate_limited: 'error',
    error: 'error',
  };
  return el('span', { class: 'status-dot', 'data-status': map[status] });
}

function errorNotice(error: unknown, retry: () => void): HTMLElement {
  const notice = el('div', { class: 'notice notice--error' });
  const body = el('div', { class: 'notice__body' }, el('div', {
    text: error instanceof ApiError ? error.message : 'Could not load sources.',
  }));
  const button = el('button', { type: 'button', class: 'notice__button', text: 'Retry' });
  button.addEventListener('click', retry);
  body.append(el('div', { class: 'notice__actions' }, button));
  notice.append(body);
  return notice;
}
