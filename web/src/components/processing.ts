/**
 * Inline pipeline indicator. The server streams each engine stage, so the UI
 * shows exactly which step is running instead of an anonymous spinner.
 */
import type { Stage } from '../types.js';
import { el } from '../lib/dom.js';
import { icons } from '../lib/icons.js';

const STAGE_ORDER: Stage[] = ['understanding', 'gathering', 'evidence', 'writing', 'verifying'];

const STAGE_LABELS: Record<Stage, string> = {
  understanding: 'Understand',
  gathering: 'Search GitHub',
  evidence: 'Collect evidence',
  writing: 'Write answer',
  verifying: 'Verify citations',
  complete: 'Done',
};

const STAGE_TITLES: Record<Stage, string> = {
  understanding: 'Knowledge engine: turning your question into search terms and intent',
  gathering: 'Knowledge engine: searching the connected GitHub sources',
  evidence: 'Knowledge engine: keeping only passages that can support a claim',
  writing: 'Answer engine: writing from that evidence',
  verifying: 'Answer engine: checking every citation against a real passage',
  complete: 'Complete',
};

export class ProcessingIndicator {
  readonly element: HTMLElement;
  private readonly stagesRow: HTMLElement;
  private readonly detail: HTMLElement;
  private currentStage: Stage = 'understanding';
  private readonly detailByStage = new Map<Stage, string>();
  private readonly stageNodes = new Map<Stage, HTMLElement>();

  constructor() {
    this.element = el('div', { class: 'processing', role: 'status', 'aria-live': 'polite' });
    this.stagesRow = el('div', { class: 'processing__stages' });
    for (const [index, stage] of STAGE_ORDER.entries()) {
      if (index > 0) this.stagesRow.append(el('span', { text: '›', style: 'opacity:.4' }));
      const node = el('span', { class: 'processing__stage', 'data-state': 'pending', title: STAGE_TITLES[stage] });
      node.append(el('span', { class: 'processing__spinner' }), el('span', { text: STAGE_LABELS[stage] }));
      this.stageNodes.set(stage, node);
      this.stagesRow.append(node);
    }
    this.detail = el('div', { class: 'processing__detail' });
    this.element.append(this.stagesRow, this.detail);
    this.setStage('understanding');
  }

  setStage(stage: Stage, detail?: string): void {
    if (detail) this.detailByStage.set(stage, detail);
    this.currentStage = stage;
    const currentIndex = STAGE_ORDER.indexOf(stage);
    for (const [name, node] of this.stageNodes) {
      const index = STAGE_ORDER.indexOf(name);
      if (stage === 'complete') {
        node.dataset.state = 'done';
        node.querySelector('.processing__spinner')?.remove();
        const check = el('span');
        check.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.check}</svg>`;
        node.prepend(check);
        continue;
      }
      if (index < currentIndex) {
        node.dataset.state = 'done';
        const spinner = node.querySelector('.processing__spinner');
        if (spinner) {
          const check = el('span');
          check.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.check}</svg>`;
          spinner.replaceWith(check);
        }
      } else if (index === currentIndex) {
        node.dataset.state = 'active';
      } else {
        node.dataset.state = 'pending';
      }
    }
    this.detail.textContent = this.detailByStage.get(stage) ?? '';
  }

  /** Replaces the stage strip with a typing shimmer once tokens start. */
  switchToStreaming(): void {
    this.element.replaceChildren();
    const shimmer = el('div', { class: 'shimmer' });
    shimmer.append(el('div', { class: 'shimmer__line' }), el('div', { class: 'shimmer__line' }), el('div', { class: 'shimmer__line' }));
    this.element.append(shimmer);
  }

  get stage(): Stage {
    return this.currentStage;
  }
}

/** Streaming text container with a blinking caret. */
export class StreamingText {
  readonly element: HTMLElement;
  private buffer = '';

  constructor() {
    this.element = el('div', { class: 'message__body md' });
    this.element.append(el('span', { class: 'streaming-caret' }));
  }

  append(text: string): void {
    this.buffer += text;
    // Render as plain text while streaming; the final answer is re-rendered
    // through the sanitising markdown pipeline.
    this.element.textContent = this.buffer;
    this.element.append(el('span', { class: 'streaming-caret' }));
  }

  get text(): string {
    return this.buffer;
  }
}
