# GitHub CI follow-up

This note supplements the original [verification report](../VERIFICATION.md).
The historical report, synthetic implementation snapshots, and raw evaluation
results describe the portable delivery. Later commits record publication changes
and the Windows correction below.

## Initial hosted run

The [initial workflow run](https://github.com/AlexanderLevenskikh/selfreview/actions/runs/42461719670)
tested publication commit `6734bdfc3291516843abdc898b1ab3750807e1ce`:

| Runner | Node.js | Result |
| --- | --- | --- |
| Ubuntu | 22 | Tests and public source replay passed |
| Ubuntu | 24 | Tests and public source replay passed |
| Windows | 22.23.4 | 105/107 tests passed; Git-root checks failed |
| Windows | 24.22.2 | 105/107 tests passed; Git-root checks failed |

Both Windows failures rejected the test's own repository root. The original
implementation compared absolute path strings returned by Git and Node.js;
Windows path aliases and casing can give different representations of the same
directory. The relevant failures were the CLI exact-root workflow and the
Git clean-filter regression test.

The original job logs are preserved in
[windows-initial/job-128672236468.log](windows-initial/job-128672236468.log) and
[windows-initial/job-128672236871.log](windows-initial/job-128672236871.log).
The public replay was skipped in those Windows jobs after the test failure.

## Correction

`diffFromGit` now asks Git whether its working directory is inside a working tree
and whether its repository-relative prefix is empty. It accepts only a working
tree root. A nested project remains rejected, so the change does not broaden the
analysis boundary. The guard normalizes CRLF output and does not compare Windows
absolute-path strings.

The final correction passed all **107 local tests, with no failures or skips**,
on Linux Node.js 24.22.1. The new log is
[windows-initial/linux-after-fix.tap](windows-initial/linux-after-fix.tap).
This local run alone does not establish Windows success.

The repository also includes `.gitattributes` to preserve the reference corpus's
original bytes during Windows checkout. Expected corpus hashes were not changed.

## Current hosted status

Check the workflow for the exact commit you use:

- [Organization repository workflow](https://github.com/levencode-labs/selfreview/actions/workflows/ci.yml)
- [Publication fork workflow](https://github.com/AlexanderLevenskikh/selfreview/actions/workflows/ci.yml)

The matrix runs `npm ci --ignore-scripts`, `npm test`, and the checked-in public
source replay on Ubuntu and Windows with Node.js 22 and 24. A hosted Windows run
validates these automated steps; it is not a manual run of every PowerShell 5.1
example in the user guides.

## Manifest scope

`SOURCE_MANIFEST.json` remains the portable-delivery inventory.
`PUBLICATION_MANIFEST.json` describes the first source publication at commit
`6734bdfc3291516843abdc898b1ab3750807e1ce`. Neither is rewritten to make later
files appear to belong to an earlier snapshot. The Windows correction and this
note are recorded by subsequent Git commits. In particular, current
`src/review.mjs` differs from the frozen synthetic evaluation implementation.
