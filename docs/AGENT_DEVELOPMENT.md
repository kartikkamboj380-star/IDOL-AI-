# Agent development

The agent schema records owner, instructions, selected provider/model, legacy enabled-engine metadata, visibility, and a bounded step limit. The current UI intentionally does not expose engine toggles: standard agents make one provider-backed model turn and do not invoke engines or external tools. Run history is recorded. Repository analysis accepts an owned agent and authorized GitHub repository, uses indexed source as untrusted input, and returns analysis/diff suggestions without applying them.

GitHub writes are separate proposed actions. A user must explicitly approve a queued action before the backend obtains write-scoped credentials and attempts a branch, commit/file change, or draft pull request. External App permissions and writes have not been live-tested. Never let an agent call the approval endpoint on a user's behalf or treat a generated recommendation as approval.

## Safety requirements for future tools

- Declare a narrow permission scope and validate it server-side for every invocation.
- Treat tool output, source files, retrieved documents, web results, and project memory as untrusted reference data; never let them override system policy.
- Add explicit call budgets, timeouts, input/output bounds, audit records, cancellation, idempotency, and tenant/project ownership checks.
- Require user confirmation before external writes, purchases, publication, or repository changes.
- Scope all knowledge and private agents by user/project. Never make private sources globally searchable.
- Never run code in the API process; use an isolated ephemeral sandbox with no default network, resource quotas, and cleanup if execution is added.
- Include mocked integration tests for success, timeout, denial, malformed tool output, failed external actions, and cross-tenant access.

Versioning, collaborative multi-agent runs, tool permission editing, performance analytics, and sandboxed execution remain incomplete. See `docs/FEATURE_MATRIX.md`.
