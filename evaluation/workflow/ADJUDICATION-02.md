# Workflow pilot adjudication 02 — retain the original boundary control

Before the first improved-implementation run, the original 20-`const` / 4-`var` input is retained as an additional negative case, `aggregate-below-threshold-has-no-proposal`.

At the unchanged threshold of 90%, its aggregate support of 83.33% must produce **zero** aggregate `no-var` proposals, zero `no-var` catalog policies, and zero automatically approved rules. It uses the original source bytes already frozen in `cases.json`.

This adds a boundary control. It does not weaken or remove any original expectation. The protocol used for subsequent comparison is therefore **17 cases: the original 16, with one disclosed input-precondition correction, plus one additional negative control**. It must not be described as an unchanged 16-case protocol.

`results/historical-01.json` retains the unamended original run. `results/historical-02.json` retains the corrected 16-case run. The next historical run and the first improved run will use the full amended 17-case protocol. `preregistered-amendment-02.json` records this extension before either execution.

