# Daily workflow contracts

This document describes the lifecycle/context/change-review iteration. See
[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) for acceptance criteria and
the [English](../USERGUIDE.md) / [Russian](../USERGUIDE.ru.md) guides for commands.

## Catalog compatibility and identity

Catalog `schemaVersion: 1` remains supported. Optional `lifecycle` metadata
records source observations, rule observations, potential revisions and explicit
decisions. The rule object approved under the original behavior hash is not
rewritten merely to add corroborating evidence. Existing catalogs need no bulk
approval reset.

Logical identity is scoped and conservative. Differences in checker behavior,
applicability, mode/severity, conditions and overrides are not discarded.
Arbitrary natural-language descriptions are not treated as semantically
equivalent. A source update cannot automatically supersede an approved version.

The source registry is an import history, not a background watcher. A byte
comparison answers whether a registered file changed; `lastRuleIds` also answers
whether an approved clause was reobserved. Neither answer authenticates the
source or decides whether the team has revoked an agreement. Source edits are
review input, not permission to approve or delete rules.

## Read-only preview and examples

`previewRule` uses an in-memory hypothetical catalog and returns impact reports.
The saved catalog and source files remain unchanged. Overlaps are still reported
unless the actual proposed rule declares a valid explicit override.

`evaluateRuleExamples` supports an opt-in array of `{code, expect, filename?,
description?}`. `expect` is `valid` or `violation`. It checks the selected syntax
checker in isolation; it does not execute code, type-check it, or prove project
applicability. Results distinguish PASS, FAIL, INCOMPLETE, INVALID_EXAMPLES,
UNVERIFIED_MANUAL, UNVERIFIED_LEGACY and NOT_PROVIDED.

## Context before editing

`createTaskContext(context, catalog, projectId, {files?})` resolves effective
rules for exact project-relative paths. Planned files are allowed. Absolute
paths, escapes, symlinks and unreadable sources cannot be treated as available
source. Disabled/overridden rules are listed separately from effective IDs.

The JSON includes project/config/catalog locations, source and policy hashes,
bounded evidence excerpts, checked examples, per-file manual questions and
structured CLI invocations. Source texts and examples stay untrusted data.

`checkTaskContext(context, catalog, saved)` reconstructs the current context from
trusted config/catalog arguments and current files. A matching self-reported hash
alone is insufficient. Callers of the library API must supply freshly loaded
config and catalog; the CLI does so. Source edits make a saved context stale by
design. Regenerate it after implementation and fresh verification.

Context describes the working tree. An agent pack may also contain a review of
the Git index. `reportBinding` explicitly identifies any source-hash mismatch;
neither result should be attributed to the other snapshot.

Binding also compares config/catalog hashes and project/scope. Checking a saved
agent pack re-reads Git snapshot metadata, including index-only changes while
working files stay unchanged. It preserves incomplete reports and does not
authenticate or re-execute their findings. An empty/excluded selection provides
no review command that could implicitly widen the task.

## Review modes and limits

- Default full/file review applies the current effective policy to selected files.
- Ordinary `--base` keeps the prior touched-node workflow.
- `--merge-base` uses and records a resolved common ancestor.
- `--staged` analyzes index blobs rather than unstaged working-tree bytes.
- `--new-only` requires a trusted local baseline and compares findings on both
  source versions. Additional occurrences must not be consumed by one old finding.

An increased violated size/parameter metric is a new finding with
`baselineChange: "worsened"` and its `previousMetric`. Named metric subjects include
their lexical owners. Ambiguous identities do not get free fallback matches.
Git reads use `--no-lazy-fetch` and require a Git version supporting it; missing
promisor objects fail without network access. Binary patches remain unsupported
and explicitly incomplete, even when the binary asset is outside JS/TS coverage.

Changed policy triggers full review. Historical policy that cannot be established
also triggers an explicit conservative fallback. Existing technical debt remains
visible in the baseline report. Renames/moves and metric changes are bounded
matching decisions, not a proof that two arbitrary programs are equivalent.

No-applicable changes are distinct from analysis failures. `NOT_APPLICABLE` and
`NO_CHANGES` do not imply complete code approval. Parse/read errors and conflicting
rules remain INCOMPLETE. Manual questions, project type/build/tests and semantic
review are never silently counted as completed.

## Evaluation boundaries

The independent [workflow protocol](../evaluation/workflow/PLAN.md) freezes
small expected cases before the improved implementation is run. Historical
results, evaluator amendments and current results are separate artifacts.
Supported syntax is compared with equivalent ESLint configuration; lifecycle
outcomes are reported separately. Human time, agent effectiveness, real MR
comment reduction and commercial demand remain **NOT_MEASURED**.
