# Deterministic workflow acceptance pilot

This directory contains a bounded, preregistered engineering pilot. It keeps syntax parity, rule lifecycle, source freshness, sampling coverage, diff applicability, and baseline comparison as separate outcomes. The current protocol has 17 cases: the original 16, one disclosed input-precondition correction, and an additional negative boundary control.

The first improved implementation and the final integration snapshot each meet all 17 declared cases. See [RESULTS.md](RESULTS.md) for the comparison, protocol history, exact source snapshots, and limitations.

## Files

- `PLAN.md` and `cases.json`: the original 16 cases, fixture source strings, and expected semantic results.
- `preregistered.json`: SHA-256 hashes recorded before running the upgraded implementation.
- `ADJUDICATION.md`, `ADJUDICATION-02.md`, the two files under `amendments/`, and their separate registrations: a pre-run arithmetic correction and an additional negative control; the original plan and fixtures are retained.
- `run.mjs`: the current API adapter and runner. It verifies the preregistered hashes before each run and refuses to overwrite a result file.
- `runner-historical-01.mjs`: the exact runner bytes used for the first historical run. This copy is evidence, not a second maintained implementation.
- `results/historical-01.json`: the preserved first run against commit `67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4`.
- `results/historical-02.json`: the corrected 16-case historical run; `runner-historical-02.mjs` preserves its runner.
- `results/historical-03.json`: the amended 17-case historical run used for the current comparison; `runner-historical-03.mjs` preserves its runner.
- `results/current-01.json`: the first passing improved-implementation snapshot, retained unchanged.
- `results/current-02.json`: the final SelfReview 0.2.0 integration snapshot, with the same 17 cases and runner as historical-03/current-01.

Other evaluation directories and their earlier results are not modified by this pilot.

## Running from the repository root

Use a new output filename for every recorded run:

```sh
node evaluation/workflow/run.mjs --out evaluation/workflow/results/current-next.json
```

The historical comparator extracts only its own `src/`, `bin/`, and `package.json` into a disposable directory. It uses the already installed pinned dependencies and never runs code from the synthetic projects:

```sh
node evaluation/workflow/run.mjs --historical 67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4 --out evaluation/workflow/results/historical-next.json
```

A recorded run exits 0 only when every declared case passes and the implementation files remained unchanged during the run. It exits 2 for declared gaps, unavailable features, unexpected errors, or an unstable implementation snapshot. The historical version is expected to expose gaps on the newly declared workflow cases; that is retained as evidence rather than treated as an infrastructure error.

## First historical result

The initial main commit produced:

| Outcome | Cases |
|---|---:|
| PASS | 4 |
| FAIL | 3 |
| NOT_AVAILABLE | 9 |
| Unexpected runner errors | 0 |

The existing syntax behavior matched equivalent native ESLint configuration: five expected finding tuples across A, B/C/D, and E, with no additional findings in the declared negative files. Candidate non-approval, distinct conditional/manual requirements, and selected-source parse failure also met their expectations.

The three observed failures were duplicate logical policies from repeated MR evidence, a duplicate policy after an unrelated document edit, and an `INCOMPLETE` result for a documentation-only diff. Source-status APIs, per-proposal project coverage states, and baseline classification were not present in that historical version, so those nine cases are labelled `NOT_AVAILABLE`.

Before any upgraded run, review of the evaluator found that its small-sample case used 20 const + 4 var, only 83.33% aggregate support at a 90% threshold. A no-var proposal therefore correctly did not exist. The intended insufficient-project scenario now uses 200 + 4; the original 20 + 4 input remains a separate control requiring zero proposals. The amended 17-case historical run has **5 PASS, 3 FAIL, 9 NOT_AVAILABLE, 0 unexpected errors**. It is a different, explicitly amended protocol, not a relabelled unchanged first run.

## Interpretation

These are author-written engineering cases, not a blind benchmark or a sample of real team MRs. The syntax comparator uses only equivalent `no-var`, `no-console`, and `eqeqeq` settings. It does not compare unrelated rules or claim stronger syntax detection than ESLint.

Developer time saved, prevented reviewer comments, agent output quality, inference costs, real-team precision/recall, architectural correctness, and adoption remain **NOT_MEASURED**. Recorded elapsed time is diagnostic only.

A later passing run demonstrates these fixed workflows on these inputs. It does not erase the historical failures or establish that arbitrary project conventions can be extracted automatically.

