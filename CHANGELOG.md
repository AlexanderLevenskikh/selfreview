# Changelog

## 0.2.0 — rule lifecycle and daily review

### Added

- Stable, scoped logical rule identities with separate evidence observations.
- Source registry, freshness status, explicit refresh, rule history and read-only
  candidate impact preview.
- Decision history and potential revision links without automatic approval or
  replacement of established policies.
- Per-project supported/contradicted/insufficient/unobserved discovery coverage.
- File-specific task context, planned-file support, checked examples, exact CLI
  invocations and saved-context consistency checks.
- Git merge-base and index review, trusted baseline occurrence comparison,
  existing/resolved findings and explicit worsened metric findings.
- An independent frozen workflow protocol with historical results, disclosed
  evaluator corrections and equivalent ESLint syntax controls.

### Changed

- Equivalent repeated MR comments and unrelated document edits no longer create
  competing copies of the same agreement.
- Agent packs resolve rules for selected files and bind the report to policy and
  source snapshots. Saved Git reports are rechecked against snapshot metadata,
  including index changes that leave the working file unchanged.
- Empty selections do not produce commands that widen review to the full
  project. Context and review share excluded/generated/dependency boundaries.
- Manual review items identify applicable files. README-only and deletion-only
  changes can return NOT_APPLICABLE rather than an analysis error.
- Policy changes or missing historical policy cause explicit full-review
  fallback. Staged/loaded policy mismatches remain incomplete.

### Compatibility and limits

- Catalog schema v1 and existing approval hashes remain valid. New lifecycle
  metadata is additive; existing decisions are not reset during import.
- Ordinary touched-node diff review remains available. New-only classification
  is opt-in, syntactic and restricted to a trusted local baseline.
- Git operations require support for `--no-lazy-fetch`; missing objects fail
  instead of fetching from a promisor remote. Source-only review does not use Git.
- Binary patches remain unsupported and explicitly incomplete, including
  binary-only asset changes. No project code or examples are executed.
- Human time savings, agent effectiveness and fewer real MR comments remain
  unmeasured. No new AI API, registry publication or automatic Skill installation
  is part of this change.

## 0.1.0 — initial public core

Scoped JS/TS policy catalog, conservative document/MR ingestion, bounded AST
checks, ESLint and agent exports, bilingual guides, preserved synthetic/public
evaluation evidence and the Ubuntu/Windows × Node 22/24 CI matrix.
