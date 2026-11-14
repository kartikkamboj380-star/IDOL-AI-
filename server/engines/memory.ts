/**
 * Conversation Memory Engine.
 *
 * Stateless server: the client sends the recent turns, and this engine decides
 * whether the current question needs earlier context and how to expand the
 * retrieval query. It also produces a short, honest note shown in the UI
 * ("expanded using 6 terms from 2 earlier turns").
 */
import type { MemoryState, MemoryTurn, QuestionAnalysis } from '../../shared/types.js';
import { contentTerms, stem } from '../knowledge/text.js';
import { memoryTermsFrom } from './question-analyzer.js';

export interface MemoryInput {
  history: MemoryTurn[];
  current: QuestionAnalysis;
  maxTurns: number;
}

export interface MemoryResult {
  state: MemoryState;
  retrievalQuery: string;
  focusTerms: string[];
}

const REFERRING = /\b(it|that|this|those|these|they|them|there|its|their|same|above|previous)\b/i;

export function buildMemory(input: MemoryInput): MemoryResult {
  const history = input.history.slice(-Math.max(0, input.maxTurns));
  const userTurns = history.filter((turn) => turn.role === 'user');
  const turnCount = userTurns.length;

  if (turnCount === 0) {
    return {
      state: {
        topic: null,
        focusTerms: [],
        turnCount: 0,
        expanded: false,
        note: 'New conversation — retrieved directly from the knowledge index.',
      },
      retrievalQuery: input.current.raw,
      focusTerms: [],
    };
  }

  const focusTerms = memoryTermsFrom(history, 4);
  const lastUserTurn = userTurns[userTurns.length - 1];
  const lastAssistant = [...history].reverse().find((turn) => turn.role === 'assistant');
  const topic = lastUserTurn ? summarizeTopic(lastUserTurn.content) : null;

  const currentTerms = new Set(input.current.terms);
  const overlap = focusTerms.filter((term) => currentTerms.has(term)).length;
  const refers = REFERRING.test(input.current.raw);
  const tooVague = input.current.terms.length <= 2;
  const shouldExpand = tooVague || (refers && overlap < 2);

  if (!shouldExpand) {
    return {
      state: {
        topic,
        focusTerms,
        turnCount,
        expanded: false,
        note: `Turn ${turnCount + 1}; the question stands on its own, so retrieval used it directly.`,
      },
      retrievalQuery: input.current.raw,
      focusTerms,
    };
  }

  // Pull terms from the most recent user question first, then the assistant's
  // last answer (which names the files that were actually relevant).
  const assistantTerms = lastAssistant ? contentTerms(lastAssistant.content).terms.slice(0, 10) : [];
  const weighted = [...new Set([...focusTerms, ...assistantTerms.map((term) => stem(term))])].slice(0, 14);
  const retrievalQuery = `${input.current.raw} ${weighted.join(' ')}`.trim();

  const noteParts: string[] = [];
  if (tooVague) noteParts.push('short follow-up');
  if (refers) noteParts.push('pronoun reference to earlier turns');
  return {
    state: {
      topic,
      focusTerms: weighted,
      turnCount,
      expanded: true,
      note: `Expanded with ${weighted.length} term(s) from ${Math.min(turnCount, 4)} earlier turn(s) (${noteParts.join(', ') || 'context needed'}).`,
    },
    retrievalQuery,
    focusTerms: weighted,
  };
}

function summarizeTopic(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const firstSentence = cleaned.split(/[.?!]/)[0] ?? cleaned;
  return firstSentence.length > 90 ? `${firstSentence.slice(0, 87)}…` : firstSentence;
}
