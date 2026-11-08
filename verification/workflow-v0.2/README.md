# Version 0.2.0 verification

This record covers the lifecycle/context/change-review implementation developed
from `67a42ad980a4b82f8b58c0c9c7e2bbaed19e4fe4`.

## Local gates

Environment: Linux, Node.js 24.22.1, npm 11.9.0, Git 2.51.1.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete `npm test` | 163 passed, 0 failed, 0 skipped | [npm-test.log](npm-test.log) |
| Existing pinned public corpus replay | 229/229 files parsed; observation counters agree | [public-results.json](public-results.json), [public-replay.log](public-replay.log) |
| Frozen final workflow protocol | 17/17 passed; source manifest stable during run | [current-02.json](../../evaluation/workflow/results/current-02.json) |
| Equivalent ESLint control | Both implementations return the same expected syntax tuples | [workflow results](../../evaluation/workflow/RESULTS.md) |

[local-verification.json](local-verification.json) records runtime versions,
source/test hashes, gate results and artifact hashes. No inspected project code
was executed, no model/API session was run, and no dependency version was changed.
The package and lock root versions were advanced together to 0.2.0.

The public runner writes its normal results file during replay. This run's new
result is retained here; the original tracked `evaluation/public/results.json`
bytes were restored from the baseline commit so the historical result remains
unchanged. No old evaluation result or failing case was deleted.

## Independent workflow protocol

The comparable historical run on the final 17-case protocol records **5 PASS,
3 FAIL and 9 NOT_AVAILABLE**. Unimplemented capabilities are separate from
runtime defects. The current run records **17 PASS**.

An evaluator fixture initially used 20 modern declarations and 4 legacy ones,
which is below its own 90% proposal threshold. Before the improved run, a
preregistered amendment used 200/4 for the intended insufficient-small-project
case, and retained 20/4 as an additional no-proposal negative control. Original
plans, hashes, historical runs and runner versions remain available in
[evaluation/workflow](../../evaluation/workflow/README.md).

## Hosted gate

The complete existing matrix remains Ubuntu/Windows × Node.js 22/24, with
`fail-fast: false`, clean dependency installation, the full test suite (including
the workflow acceptance test) and public corpus replay. Use the PR checks and
[main workflow](https://github.com/levencode-labs/selfreview/actions/workflows/ci.yml)
for the exact published commit's results. Local Linux results do not establish
native Windows success. No manual execution of every PowerShell guide example
is claimed.

## Boundaries

These results validate the declared cases and implemented syntax checks. They
do not measure developer active time, agent token/cost/time savings, reduction
of real MR comments, architectural correctness or market demand. Those outcomes
remain **NOT_MEASURED**. The checker vocabulary remains bounded; binary patches
are incomplete, and unavailable historical policy causes explicit full-review
fallback.
