/**
 * IDOL AI — shared API contracts.
 *
 * These types are the single source of truth for the HTTP/SSE surface exposed by
 * the server. The browser client mirrors the shapes it consumes in
 * `web/src/types.ts`.
 */

/* ------------------------------------------------------------------ */
/* Knowledge sources                                                   */
/* ------------------------------------------------------------------ */

export type SourceKind = 'github' | 'local';

export type SourceStatus =
  | 'unconfigured'
  | 'indexing'
  | 'ready'
  | 'stale'
  | 'error'
  | 'rate_limited';

export interface KnowledgeSource {
  id: string;
  kind: SourceKind;
  /** Display name, e.g. "IDOL-AI-". */
  name: string;
  /** For GitHub sources. */
  owner?: string;
  repo?: string;
  /** Branch, tag or commit that was indexed. */
  ref?: string;
  /** Commit SHA the snapshot was built from. */
  resolvedRef?: string;
  /** Filesystem path for local sources (never exposed verbatim to clients). */
  localPath?: string;
  status: SourceStatus;
  lastIndexedAt?: string;
  lastError?: string;
  filesIndexed?: number;
  passages?: number;
  bytesIndexed?: number;
  skippedFiles?: number;
  truncatedTree?: boolean;
  htmlUrl?: string;
  addedAt: string;
}

export interface SourceStatsSummary {
  totalSources: number;
  readySources: number;
  totalFiles: number;
  totalPassages: number;
  totalBytes: number;
  lastIndexedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Repository browse                                                   */
/* ------------------------------------------------------------------ */

export interface RepoTreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface RepoTreeResponse {
  sourceId: string;
  path: string;
  entries: RepoTreeEntry[];
  truncated: boolean;
}

export interface FileResponse {
  sourceId: string;
  path: string;
  language: string;
  lineCount: number;
  kind: string;
  size: number;
  content: string;
  truncated: boolean;
  htmlUrl: string | null;
  citations: number;
}

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

export interface SourceRef {
  /** Stable citation id, 1-based within an answer. */
  id: number;
  sourceId: string;
  sourceName: string;
  path: string;
  heading: string | null;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  htmlUrl: string | null;
  /** Short verbatim excerpt used for grounding. */
  excerpt: string;
  kind: ChunkKind;
}

export type ChunkKind = 'markdown' | 'code' | 'data' | 'text';

export interface SearchHit {
  chunkId: string;
  sourceId: string;
  path: string;
  heading: string | null;
  startLine: number;
  endLine: number;
  score: number;
  signals: Record<string, number>;
  excerpt: string;
  kind: ChunkKind;
  language: string;
  htmlUrl: string | null;
}

export interface SearchResponse {
  query: string;
  normalizedQuery: string;
  totalPassages: number;
  elapsedMs: number;
  hits: SearchHit[];
}

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

export type Intent =
  | 'greeting'
  | 'capabilities'
  | 'repo_overview'
  | 'documentation_search'
  | 'how_to'
  | 'factual_lookup'
  | 'code_explanation'
  | 'bug_analysis'
  | 'summarization'
  | 'comparison'
  | 'troubleshooting'
  | 'out_of_scope';

export interface QuestionAnalysis {
  raw: string;
  normalized: string;
  /** Content-bearing terms after stop-word removal and stemming. */
  terms: string[];
  /** Bigrams that appear verbatim in the query. */
  phrases: string[];
  /** File paths or identifiers the user mentioned explicitly. */
  explicitPaths: string[];
  identifiers: string[];
  isFollowUp: boolean;
  /** Query used for retrieval (may include memory expansion). */
  retrievalQuery: string;
  /** Domain words that hint at a source area, e.g. "benchmark", "install". */
  facets: string[];
  language: 'en' | 'unknown';
}

export interface IntentResult {
  intent: Intent;
  confidence: number;
  /** Keywords that triggered the intent. */
  evidence: string[];
  /** Expected answer shape. */
  shape: 'prose' | 'steps' | 'code' | 'bullets' | 'table' | 'refusal';
  wantsCode: boolean;
  wantsSources: boolean;
}

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryState {
  /** Resolved topic from previous turns. */
  topic: string | null;
  /** Keywords carried over from the conversation. */
  focusTerms: string[];
  /** Number of user turns seen. */
  turnCount: number;
  /** True when the current question was expanded using earlier context. */
  expanded: boolean;
  /** Human-readable note about what memory did. */
  note: string;
}

export interface CitationValidation {
  marker: number;
  sourceId: string | null;
  path: string;
  status: 'verified' | 'unverified' | 'missing';
  detail?: string;
}

export interface ValidationReport {
  passed: boolean;
  citations: CitationValidation[];
  citationCoverage: number;
  unsupportedClaims: string[];
  removedMarkers: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Answer                                                              */
/* ------------------------------------------------------------------ */

export type AnswerMode = 'knowledge' | 'inference';

export interface AnswerPayload {
  id: string;
  conversationId: string;
  createdAt: string;
  text: string;
  mode: AnswerMode;
  intent: Intent;
  intentConfidence: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  sources: SourceRef[];
  memory: MemoryState;
  validation: ValidationReport;
  analysis: QuestionAnalysis;
  /** Static code observations, when the answer involved code. */
  codeFindings: CodeFinding[];
  timings: Record<string, number>;
  model: string | null;
  /** Honest statement about how this answer was produced. */
  provenance: string;
}

export interface CodeFinding {
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  category: 'symbol' | 'complexity' | 'risk' | 'pattern' | 'dependency';
  severity: 'info' | 'low' | 'medium' | 'high';
  message: string;
  excerpt: string;
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export interface ChatRequest {
  conversationId: string;
  message: string;
  history?: MemoryTurn[];
  regenerate?: boolean;
  sourceIds?: string[];
}

/**
 * Streamed progress. The names describe the two engines at work rather than
 * internal steps: the knowledge engine understands and gathers, the answer
 * engine writes and verifies.
 */
export type Stage =
  | 'understanding'
  | 'gathering'
  | 'evidence'
  | 'writing'
  | 'verifying'
  | 'complete';

export type StreamEvent =
  | { type: 'stage'; stage: Stage; detail?: string; elapsedMs?: number }
  | {
      type: 'meta';
      mode: AnswerMode;
      intent: Intent;
      inference: InferenceStatus;
      memory: MemoryState;
      analysis: QuestionAnalysis;
      intentConfidence: number;
    }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: AnswerPayload }
  | { type: 'error'; message: string; code: string; retryable: boolean };

/* ------------------------------------------------------------------ */
/* Inference provider                                                  */
/* ------------------------------------------------------------------ */

export interface InferenceStatus {
  available: boolean;
  /** "knowledge" when no model is configured. */
  mode: AnswerMode;
  provider: string | null;
  model: string | null;
  /** Honest explanation of the current mode. */
  reason: string;
}

/* ------------------------------------------------------------------ */
/* App status                                                          */
/* ------------------------------------------------------------------ */

export interface AppStatus {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  inference: InferenceStatus;
  knowledge: SourceStatsSummary;
  github: {
    authenticated: boolean;
    note: string;
  };
  limits: {
    maxMessageChars: number;
    maxFilesPerSource: number;
    maxFileBytes: number;
    maxContextChars: number;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
