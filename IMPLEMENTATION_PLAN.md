# SelfReview improvement plan

Baseline: `67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4` (the published main branch).

## Goal

Make the daily loop practical: import agreements and review feedback, curate a
small stable policy, give an agent the effective rules for its actual files,
and review the selected change with explicit evidence and coverage.

This iteration implements the gaps found in the repository assessment. It does
not promise exhaustive convention inference or measured developer time savings.

## Delivery and acceptance

| Stage | Deliverable | Required acceptance |
| --- | --- | --- |
| 1. Rule lifecycle | Stable logical identity, evidence accumulation, linked revisions and history | Repeated identical MR comments produce one candidate; unrelated document edits do not resurrect approved/rejected rules; different scopes, applicability, conditions and behavior remain distinct; existing approvals remain valid without being rewritten. |
| 2. Source maintenance and preview | Registered inputs, source status, explicit refresh and candidate impact preview | Changed/missing/unavailable sources stay visible; refresh creates candidates without approving or replacing active rules; preview leaves catalog bytes unchanged and shows affected files/conflicts. |
| 3. Task context | File-specific agent context, exact local invocation, examples and freshness check | Disabled/overridden/out-of-scope rules cannot appear as effective requirements; selected files and config/catalog/source hashes are bound to the context; stale context fails validation; unverified manual work stays explicit. |
| 4. Change review | Working-tree/staged selection, merge-base support, baseline comparison and explicit no-applicable status | Existing versus introduced/resolved findings are distinguished without hiding additional occurrences; baseline errors remain incomplete; policy changes invalidate narrow review; README-only changes are not confused with parse failures; manual questions identify applicable files. |
| 5. Acceptance and documentation | Frozen workflow cases, equivalent ESLint comparison, bilingual guides and complete CI | Existing tests and historical evidence remain intact; the full Ubuntu/Windows × Node 22/24 matrix runs; deterministic workflow outcomes are separated from unmeasured human/agent savings. |

## Invariants

- Imported documents, review comments and examples are data. They do not run commands.
- Candidates never become approved because of repetition, frequency or confidence.
- Source drift does not silently rewrite or revoke an approved historical snapshot.
- Catalog schema v1 and existing approvals remain readable; lifecycle metadata is additive.
- Exact equivalence includes scope, applicability, checker options, severity, mode,
  overrides and conditions. Ambiguous natural-language rules are not silently merged.
- Project conventions take precedence over advisory best practices.
- No inspected project code is executed and no project dependencies are installed.
- Configuration conflicts, stale approvals, unreadable input and parse errors cannot
  be reported as a clean review.
- Existing evaluation failures are retained. Tests and platform coverage are not
  removed to obtain a passing result.
- No paid model calls, credentials or global configuration changes are required.

## Verification strategy

1. Add focused regression tests for the actual lifecycle and review failures.
2. Freeze independent workflow cases before evaluating the new implementation.
3. Compare supported syntax checks against equivalent ESLint settings; report
   lifecycle capabilities separately instead of giving SelfReview more input.
4. Run the full existing test suite, public corpus replay and new workflow runner.
5. Review integration and generated examples; update English and Russian guides.
6. Publish a reviewable change and verify the complete hosted CI matrix before merge.

## Follow-up that requires additional evidence or an owner decision

- A real MR pilot: derive policies from older material, evaluate later unseen
  changes, and record setup/maintenance/triage time as well as residual comments.
- Additional checker kinds or type/import-graph analysis, selected from repeated
  misses in that pilot rather than arbitrary rule-count growth.
- Licensing and package publication policy, followed by a versioned installable
  release. Public repository visibility alone is not a licensing decision.
- Desktop, hosted service and additional languages after the daily loop is useful.

## Outcome record

All five implementation stages are delivered in version 0.2.0. The final local
gate passed 163 tests without failures/skips; the unchanged public corpus replay
parsed 229 files and matched its observations. The final frozen workflow replay
passed 17/17 cases on a stable source manifest. Its original fixture mistake,
preregistered correction, additional negative control and earlier results remain
available; they were not removed to improve the score.

See [CHANGELOG.md](CHANGELOG.md), the [verification record](verification/workflow-v0.2/README.md),
and [workflow results](evaluation/workflow/RESULTS.md). Hosted Ubuntu/Windows ×
Node 22/24 acceptance is recorded on the published commit by
[GitHub Actions](https://github.com/levencode-labs/selfreview/actions/workflows/ci.yml).
Merge requires that full matrix. Real MR/agent/human productivity measurements,
licensing and registry publication remain follow-up items rather than completed
claims.
