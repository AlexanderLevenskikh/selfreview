# Workflow pilot adjudication 01 — sparse sample precondition

This correction was identified by reading the preregistered fixture arithmetic and the documented per-proposal coverage API, **before any run of the improved implementation**.

The original case `small-contradictory-sample-is-insufficient` has 20 `const` declarations in the large project and 4 `var` declarations in the small one. Its aggregate support is 20/24 = 83.33%, below the preregistered threshold of 90%. Discovery therefore correctly produces no `no-var` proposal. The original runner incorrectly assumed that this proposal existed before checking its per-project coverage.

This is an evaluator setup error, not a newly found implementation defect. The intended acceptance condition is unchanged: a **proposed** shared convention must label a project with four contradictory opportunities as insufficient at `minSamples=5`.

## Transparent correction

`amendments/001-sparse-sample.json` changes only that case's large-project source fixture to 200 `const` declarations. The small project remains four `var` declarations. Aggregate support becomes 200/204 = 98.04%, so a statistical `no-var` proposal exists while the small project's local sample remains insufficient.

No expected outcomes, thresholds, other cases, or production code are changed. The new fixture bytes are frozen and hashed in `preregistered-amendment-01.json` before the first improved run.

The original `PLAN.md`, `cases.json`, `preregistered.json`, `runner-historical-01.mjs`, and `results/historical-01.json` are preserved. A second historical run will use the amendment so that the historical/current comparison uses identical amended inputs. Reports must state which registration they use; the first historical run must not be relabelled as having used the corrected fixture.

