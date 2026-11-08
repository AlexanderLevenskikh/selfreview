# Workflow acceptance pilot — preregistered plan

## Purpose and scope

This is a small deterministic engineering acceptance pilot for the next SelfReview revision. It tests a declared set of workflow behaviors, syntax checks, source provenance, scope boundaries, and Git baseline comparison. It is not a blind evaluation: its author has read the existing implementation and knows the planned API contracts.

The expected cases and source strings in `cases.json` are fixed before the improved implementation is executed. A later runner may adapt to the documented API shape, but must not change the cases, expected semantic outcomes, or source fixture bytes to obtain a passing result. If a case was specified incorrectly, preserve its original result and add an explicit adjudication instead of rewriting it.

Historical implementation reference: `67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4`. It may be extracted to a temporary directory from Git using only `src/`, `bin/`, and `package.json`; existing evaluation corpora and historical snapshots must remain untouched. A missing historical feature is recorded as `NOT_AVAILABLE`, not as a successful check.

## Fixed acceptance families

1. **Scoped syntax and negative exceptions.** Projects A, B/C/D, and E use different approved conventions over identical JavaScript. The comparison includes allowed `console.warn`, a shadowed `console`, a string/comment containing forbidden-looking text, a file outside rule applicability, and an allowed `== null` check.
2. **Rule lifecycle.** Imports never approve themselves. Equivalent comments from different MRs and an unchanged clause in an edited document keep one logical policy. Corroborating evidence must not silently rewrite a previously approved rule or invalidate its stored approval. Distinct conditional/manual requirements must remain distinct.
3. **Source freshness.** Changed and missing authoritative documents are reported explicitly. Detection alone must not pretend that the stored policy was reviewed again or erase its approval.
4. **Sampling coverage.** A sampled project is distinguished from an unobserved project. A contradictory project with fewer than `minSamples` opportunities is labelled insufficient rather than supported. The previously fixed veto for sufficiently sampled contradictory projects is not re-labelled as an outstanding bug.
5. **Diff applicability and parsing.** A documentation-only change is explicitly not applicable to the configured JS/TS checks; an invalid selected source is incomplete and cannot appear clean.
6. **Baseline comparison.** A retained finding moved by whitespace/comment lines stays existing; an extra identical occurrence is new; removed occurrences are resolved. An invalid base source is incomplete. A changed approved policy prevents reusing an old-policy baseline as a clean new-only result.

The exact expected normalized fields and all source fixture bytes are in `cases.json`. The plan intentionally measures a small set of supported syntactic rules rather than arbitrary architecture, business logic, or all possible project conventions.

## ESLint comparator

Only the scoped JavaScript syntax case has a meaningful ESLint comparator. Use the already pinned ESLint dependency with equivalent `no-var`, `no-console` / `allow`, and `eqeqeq` / `null: ignore` configurations, the same selected files, and the same rule applicability.

Compare normalized tuples `[project, path, check, startLine]`, not message wording, source columns, or unrelated default ESLint recommendations. The source puts distinct findings on separate lines. Report these syntax outcomes separately from lifecycle/baseline outcomes. Do not claim that SelfReview improves on ESLint at these already covered checks.

## Isolation and authority

- Create disposable fixture directories. Git commits and configuration writes are confined to those directories.
- Never execute fixture project code, install fixture dependencies, use paid APIs, or call an AI model.
- Use synthetic reviewer identity and explicit approval only where the case requires it.
- Disable repository hooks, signing, and ambient Git configuration for fixture setup; do not edit global Git configuration.
- Source freshness checks are read-only. Imported comments and document text remain data.
- Baseline fixtures commit their configuration, catalog, and sources together so that policy identity has a real historical reference.
- Preserve original plans, first results, failures, source hashes, and the implementation manifest for each recorded run. Do not overwrite earlier result files.

## Reporting and limits

Every case records its expected values, observed normalized facts, feature availability, diagnostics, and PASS/FAIL/NOT_AVAILABLE. Unexpected exceptions are recorded as errors; they must not disappear from the denominator. A later fix may produce another run, with the original failure retained.

Record environment and implementation hashes for provenance. Wall-clock duration, if captured, is diagnostic only and is not compared as a performance benchmark.

The following outcomes remain **NOT_MEASURED**: developer time saved, reviewer comments prevented, agent output quality, inference cost, false-positive rate on real team MRs, overall recall, architecture correctness, and team adoption. This pilot cannot support claims about those outcomes.

## Execution order

1. Write this plan and `cases.json`; record their SHA-256 digests in `preregistered.json`.
2. Implement the adapter/runner against the published API contracts.
3. Execute the unchanged cases against the historical and current implementations where the feature exists.
4. Save distinct result files and a readable report with both successes and remaining gaps.

