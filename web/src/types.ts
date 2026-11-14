/**
 * Client-side mirrors of the server contracts in `shared/types.ts`.
 * Duplicated deliberately: the browser bundle must not import server code.
 */

export type ChunkKind = 'markdown' | 'code' | 'data' | 'text';
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
export type AnswerMode = 'knowledge' | 'inference';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface SourceRef {
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
  excerpt: string;
  kind: ChunkKind;
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

export interface MemoryState {
  topic: string | null;
  focusTerms: string[];
  turnCount: number;
  expanded: boolean;
  note: string;
}

export interface QuestionAnalysis {
  raw: string;
  normalized: string;
  terms: string[];
  phrases: string[];
  explicitPaths: string[];
  identifiers: string[];
  isFollowUp: boolean;
  retrievalQuery: string;
  facets: string[];
  language: 'en' | 'unknown';
}

export interface InferenceStatus {
  available: boolean;
  mode: AnswerMode;
  provider: string | null;
  model: string | null;
  reason: string;
}

export interface AnswerPayload {
  id: string;
  conversationId: string;
  createdAt: string;
  text: string;
  mode: AnswerMode;
  intent: Intent;
  intentConfidence: number;
  confidence: Confidence;
  sources: SourceRef[];
  memory: MemoryState;
  validation: ValidationReport;
  analysis: QuestionAnalysis;
  codeFindings: CodeFinding[];
  timings: Record<string, number>;
  model: string | null;
  provenance: string;
}

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

export interface KnowledgeSource {
  id: string;
  kind: 'github' | 'local';
  name: string;
  owner?: string;
  repo?: string;
  ref?: string;
  resolvedRef?: string;
  localPath?: string;
  status: 'unconfigured' | 'indexing' | 'ready' | 'stale' | 'error' | 'rate_limited';
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

export interface AppStatus {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  inference: InferenceStatus;
  knowledge: SourceStatsSummary;
  github: { authenticated: boolean; note: string };
  limits: {
    maxMessageChars: number;
    maxFilesPerSource: number;
    maxFileBytes: number;
    maxContextChars: number;
  };
}

export interface GitHubConnection {
  authenticated: boolean;
  tokenSource: 'env' | 'runtime' | 'none';
  login: string | null;
  scopes: string | null;
  envManaged: boolean;
  rateLimit: { limit: number; remaining: number; reset: string | null } | null;
}

export interface RepoTreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface FileResponse {
  sourceId: string;
  path: string;
  language: string;
  kind: ChunkKind;
  size: number;
  content: string;
  truncated: boolean;
  htmlUrl: string | null;
  citations: number;
}

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

export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

/* ------------------------------------------------------------------ */
/* Client-only models                                                  */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Present on assistant messages. */
  answer?: AnswerPayload;
  /** Local error state for failed sends. */
  error?: { message: string; code: string; retryable: boolean };
  /** The user message text this assistant turn answered (for regenerate). */
  prompt?: string;
  /** Runtime UI state. */
  streaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Source restriction persisted with the conversation. */
  sourceIds?: string[];
}

export interface Preferences {
  theme: 'dark' | 'light' | 'system';
  sidebarCollapsed: boolean;
}
