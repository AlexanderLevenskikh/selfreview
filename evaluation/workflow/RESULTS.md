# Workflow acceptance results

## Recorded outcome

The final integration snapshot, [current-02.json](results/current-02.json), meets **17/17 declared cases**: no failed cases, unavailable features, or unexpected runner errors. Its 19-file implementation manifest remained unchanged during the run. This run uses SelfReview 0.2.0 after the lifecycle, Git, context, and CLI integration changes.

The first improved-implementation run, [current-01.json](results/current-01.json), also met 17/17 cases. It is retained as the earlier source snapshot rather than overwritten by the final replay.

The directly comparable historical run is [historical-03.json](results/historical-03.json), using commit `67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4` and the same amended 17-case inputs: **5 PASS, 3 FAIL, 9 NOT_AVAILABLE, 0 unexpected errors**.

These are workflow acceptance outcomes on declared synthetic inputs. They are not a percentage estimate of real-world review accuracy.

## Protocol history

| Recorded run | Protocol | PASS | FAIL | NOT_AVAILABLE | Unexpected errors |
|---|---|---:|---:|---:|---:|
| historical-01 | Original 16 cases | 4 | 3 | 9 | 0 |
| historical-02 | 16 cases with disclosed input-precondition correction | 4 | 3 | 9 | 0 |
| historical-03 | Corrected 16 plus original-input negative control: 17 cases | 5 | 3 | 9 | 0 |
| current-01 | Same amended 17 cases as historical-03 | 17 | 0 | 0 | 0 |
| current-02 | Same amended 17 cases; final integration source snapshot | 17 | 0 | 0 | 0 |

The original small-sample setup accidentally used 20 const + 4 var, below its 90% aggregate threshold. This was found by reading the fixture arithmetic **before the first upgraded run**. The intended small-project coverage case now uses 200 + 4; the original 20 + 4 input is retained as an additional control requiring no aggregate proposal. Expected outcomes of the original cases were not changed. The original files, hashes, runner, and results remain available; see [ADJUDICATION.md](ADJUDICATION.md) and [ADJUDICATION-02.md](ADJUDICATION-02.md).

The protocol was therefore explicitly amended and extended. It must not be described as an unchanged 16-case replay.

## Observed cases

| Case | Historical main, amended protocol | Improved runs current-01 / current-02 | Observed meaning |
|---|---|---|---|
| Scoped syntax and exceptions | PASS | PASS | Five expected findings across A, B/C/D, and E; no additional findings in declared negative files |
| Candidate never autoapproved | PASS | PASS | One candidate, zero approvals, zero enforced findings |
| Repeated MR evidence | FAIL | PASS | One logical no-var policy instead of two; two source records; original approved object and approval remain unchanged |
| Unrelated document edit | FAIL | PASS | Unchanged no-var clause retains its original policy ID and approved snapshot |
| Authoritative document changed | NOT_AVAILABLE | PASS | Source state is changed; check is read-only; approval is not silently rewritten |
| Authoritative document missing | NOT_AVAILABLE | PASS | Source state is missing; check is read-only; approval is retained |
| Distinct conditional/manual requirements | PASS | PASS | Two distinct manual candidates remain separate and unapproved |
| Unsampled project coverage | NOT_AVAILABLE | PASS | Sampled project supported; omitted project unobserved |
| Sparse contradictory project coverage | NOT_AVAILABLE | PASS | Large project supported; four-opportunity project insufficient at minSamples 5 |
| Documentation-only diff | FAIL | PASS | NOT_APPLICABLE, exit 0, no selected JS/TS files |
| Selected source parse failure | PASS | PASS | INCOMPLETE, exit 2, explicit parse error |
| Existing finding moved by comment/line insertion | NOT_AVAILABLE | PASS | new 0, existing 1, resolved 0; new-only exit 0 |
| Extra identical occurrence | NOT_AVAILABLE | PASS | new 1, existing 1, resolved 0; new-only exit 1 |
| Removed occurrence | NOT_AVAILABLE | PASS | new 0, existing 0, resolved 1 |
| Invalid base source | NOT_AVAILABLE | PASS | Baseline and review INCOMPLETE, exit 2 |
| Approved policy changed | NOT_AVAILABLE | PASS | POLICY_CHANGED_FULL_REVIEW; current violation remains visible, exit 1 |
| Original below-threshold aggregate | PASS | PASS | 20/24 support at threshold 0.9 yields no no-var proposal or approval |

The document-edit case does not assert that an entire document produces no new candidates: an added unrelated paragraph can correctly become a separate manual question. It asserts that the unchanged existing requirement does not become another competing policy.

Baseline matching here is syntactic and occurrence-count based. It does not prove semantic equivalence, runtime correctness, or that a reviewer would consider a change acceptable. Cases with an invalid baseline or changed policy preserve an explicit non-clean or full-review outcome.

## ESLint comparison

Only the scoped syntax case has an ESLint comparator. Both historical and improved SelfReview runs match native ESLint configured with equivalent `no-var`, `no-console` with allowed warn, and `eqeqeq` with null ignored. Both report the same five `[project, path, checker, line]` tuples.

The negative inputs include a local console parameter, text/comments resembling forbidden code, a test helper outside rule applicability, an allowed console.warn, and an allowed null comparison. Message wording and columns are not compared.

**No improvement over ESLint syntax detection is claimed.** The measured changes are the separately reported lifecycle, source freshness, coverage, applicability, and baseline workflows. ESLint is not assigned artificial failures for the absence of SelfReview-specific lifecycle APIs.

## Reproducibility and scope

- Original registration: [preregistered.json](preregistered.json); source data and expectations: [cases.json](cases.json).
- Amendment registrations: [preregistered-amendment-01.json](preregistered-amendment-01.json) and [preregistered-amendment-02.json](preregistered-amendment-02.json).
- Every result records environment, runner SHA-256, and hashes of the implementation files used.
- current-01 and current-02: Linux x64, Node.js 24.22.1, ESLint 10.14.0; each records 19 implementation files, stable during its execution.
- current-02 was recorded at `2026-11-08T10:41:38.868Z`, after the final source freeze; its per-file hashes identify the exact implementation tested. Any subsequent source change requires its own validation and must not be attributed to this snapshot.
- `runner-historical-03.mjs` contains the exact runner bytes used by historical-03, current-01, and current-02: SHA-256 `4dd5b8ded3fa4983ffa701ac6541e09283156903f428e62395fdc245156d89e3`.
- The automated `test/workflow-acceptance.test.mjs` rechecks the same 17 cases against its working tree without overwriting these records. Native Windows results and the full test suite are separate validation outcomes; this pilot records Linux execution only.
- Git setup, configuration changes, and project files are confined to disposable fixtures. Fixture project code is never executed. No AI API is called.
- The author knew the implementation and proposed API contracts. This is not a blind external evaluation.
- Existing synthetic/public corpora and their historical outcomes are preserved.

Developer time saved, prevented reviewer comments, agent output quality, inference cost, real-team precision/recall, architectural correctness, and adoption remain **NOT_MEASURED**. Diagnostic elapsed times in JSON are not a performance benchmark.

