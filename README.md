# SelfReview

**Project conventions you can trace, approve, and check before code review.**

SelfReview is a local toolkit for JavaScript, TypeScript, and React/TSX. It collects
rule candidates from source folders, team agreements, and merge-request comments;
keeps them in explicit project scopes; and applies the rules you approve through a
shared AST engine, a CLI, and an ESLint adapter.

Use one scope for project A, another for B/C/D, and a third for E. Export the same
catalog as a human-readable reference, an agent review pack, or a Skill snapshot.
General best-practice checks remain advisory and yield to approved conventions.

**Version:** 0.1.0 · **Runtime:** Node.js 22.13+ · **Languages:** JS / TS / JSX / TSX

[English user guide](USERGUIDE.md) · [Руководство на русском](USERGUIDE.ru.md) ·
[Verification report](VERIFICATION.md) ·
[GitHub Actions](https://github.com/levencode-labs/selfreview/actions/workflows/ci.yml)

## Why this exists

Review feedback often repeats the same project-specific expectations: which APIs
are allowed, how imports are organized, which exceptions apply in legacy code,
and what deserves a closer look before opening a pull request.

SelfReview turns that evidence into an explicit catalog. Every imported rule starts
as a **candidate**. A person reviews its source, applicability, and parameters
before approving it. A frequent pattern in a repository is evidence of usage;
it does not, by itself, establish a team agreement.

The catalog is the source of truth. AST analysis is one way to enforce it.
Expectations that cannot be represented by a supported check remain visible
manual-review items.

## What is implemented

| Capability | Current behavior |
| --- | --- |
| Project scopes | Explicit project-to-scope mapping, shared scopes, inheritance, path variants, overrides, and exclusions with reasons |
| Source discovery | Candidates for `no-var`, `strict-equality` (including null exceptions), and `require-braces`; additional metrics for functions, components, parameters, and imports |
| Document ingestion | Markdown, text, JSON, and structured rule proposals; unsupported or conditional language stays manual |
| Review ingestion | Neutral MR JSON, GitLab discussions/notes, and separate unified diffs with comments |
| Approval | Source references and SHA-256 hashes; approval tied to the exact rule content |
| Executable checks | 11 finite AST check kinds, plus a separate `manual` kind |
| Review surfaces | CLI text/JSON reports, JavaScript API, and an ESLint flat-config adapter using the same engine |
| Changed-code review | Parse complete changed files and report checks on affected AST nodes |
| Agent integration | Exported Skill snapshot, conventions reference, and a structured `agent-pack`; no AI API key required |
| Completeness reporting | Parse errors, rule conflicts, stale approvals, and unverifiable diffs remain explicit incomplete outcomes |

Executable checks cover variable declarations, console/debugger use, equality,
restricted imports and calls, function/component size, parameter count,
async Promise executors, and control-flow braces. See the guides for configuration
and [the rule schema](schemas/rule.schema.json) for the exact supported options.

## Quick start

Clone the repository and install its pinned dependencies:

```sh
git clone https://github.com/levencode-labs/selfreview.git
cd selfreview
npm ci --ignore-scripts
node bin/selfreview.mjs --help
node bin/selfreview.mjs review --config examples/selfreview.config.json --scope team-bcd
```

On Windows PowerShell 5.1, run these as separate commands and use `npm.cmd` if
PowerShell's execution policy blocks `npm.ps1`. The guides include Windows paths
and commands. For CLI-only use, `npm ci --omit=dev --ignore-scripts` installs the
runtime dependency without ESLint or the development test dependencies.

The repository contains source code, not a bundled Node.js runtime or installed
dependencies. A separately distributed portable archive may include the
TypeScript parser; that does not change the installation step for a Git clone.

### Try the different scopes

```sh
node bin/selfreview.mjs review --config examples/selfreview.config.json --project project-a
node bin/selfreview.mjs review --config examples/selfreview.config.json --scope team-bcd
node bin/selfreview.mjs review --config examples/selfreview.config.json --project project-e
```

| Example | Expected result |
| --- | --- |
| A | Two intentional convention violations; exit code `1` |
| B, C, D | A shared scope permits `console.warn` and `console.error`; exit code `0` |
| E | Explicit legacy exceptions, including a null-comparison policy; exit code `0` |

`npm run demo` runs the intentionally failing A example. Its exit code `1` is the
expected demonstration result.

## Use it with your projects

Run the CLI from the SelfReview directory. Replace the paths below with existing
project and agreement folders; SelfReview creates the configuration and catalog.

```sh
node bin/selfreview.mjs init --config ../review-data/selfreview.config.json --scope a --project ../projects/A
node bin/selfreview.mjs scope add team-bcd --config ../review-data/selfreview.config.json --project ../projects/B --project ../projects/C --project ../projects/D
node bin/selfreview.mjs scope add e --config ../review-data/selfreview.config.json --project ../projects/E
node bin/selfreview.mjs learn --config ../review-data/selfreview.config.json --scope a --docs ../agreements/A --mr ../reviews/review.json
node bin/selfreview.mjs rules list --config ../review-data/selfreview.config.json --scope a
```

Inspect a candidate using the actual ID from the output:

```sh
node bin/selfreview.mjs rules show RULE_ID --config ../review-data/selfreview.config.json
node bin/selfreview.mjs rules approve RULE_ID --config ../review-data/selfreview.config.json --by Alex --reason "Confirmed against the team's agreement"
```

Then check changes and create reusable outputs:

```sh
node bin/selfreview.mjs review --config ../review-data/selfreview.config.json --project a --base HEAD
node bin/selfreview.mjs agent-pack --config ../review-data/selfreview.config.json --project a --base HEAD --out ../review-data/agent-pack.json
node bin/selfreview.mjs export --config ../review-data/selfreview.config.json --scope a --out ../review-data/export-a
```

Project IDs are derived from folder names and shown by `init`. `--base HEAD`
includes local tracked changes and untracked files. For a pull/merge request,
choose the intended base commit explicitly. The configured project must be its
Git root for `--base`; ordinary full-project review does not require Git.
An export destination must be new or empty.

The [English guide](USERGUIDE.md) and [Russian guide](USERGUIDE.ru.md) cover input
formats, rule variants, approval, ESLint setup, agent workflows, and troubleshooting.

## Interpret the result

| Exit code | Meaning |
| --- | --- |
| `0` | The command completed without a blocking AST violation |
| `1` | An approved, enforced error was found |
| `2` | Configuration or analysis is incomplete |

A successful process exit is not full code-review approval. Read the report status:
`ADVISORY_ONLY`, `MANUAL_REVIEW_REQUIRED`, and `NO_CHANGES` describe different
coverage limits. Manual rules stay in a checklist; advisory checks do not become
project conventions automatically.

## Validation and known limits

The recorded Linux run on Node.js 24.22.1 passed **107 tests with no skips**.
It includes CLI subprocess workflows and real ESLint integration. A source-only
evaluation parsed **229 selected files** from pinned revisions of `p-limit`,
`usehooks-ts`, and `underscore`. Synthetic evaluation includes contrasting
styles, scope isolation, conditional documents, and MR inputs.

These are bounded checks of the implemented behavior. The repository preserves
the original evaluation failures, subsequent fixes, and a separate adjudication
of a document-selector defect in the evaluator. They should not be read as a
universal accuracy score. See [VERIFICATION.md](VERIFICATION.md) (Russian),
[public evaluation provenance](evaluation/public/provenance.json), and
[synthetic evaluation history](evaluation/synthetic/RESULTS.md) (Russian).

Current limitations:

- Discovery is not an exhaustive inventory of team conventions. It has three
  supported frequency-based hypotheses; other facts remain evidence or manual
  proposals. Mixed project styles can prevent a shared-scope hypothesis.
- Component length is a heuristic. Responsibility boundaries, business logic,
  and architecture still require judgment.
- API-name checks do not provide full type or data-flow analysis. Aliases and
  unrelated methods with the same name can require manual review.
- A touched AST node can contain an older violation. Diff review does not prove
  that the current change introduced it.
- Supported source extensions are `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`,
  `.mts`, and `.cts`. Flow, Vue/Svelte single-file components, C#, PDF, and DOCX
  ingestion are not implemented.
- The analyzer does not run the inspected project's code, dependencies, builds,
  or tests, and does not replace them.
- There is no desktop application, hosted service, watcher, or automatic Skill
  installation in this version. CLI and exports work locally without AI API calls.

Native Windows execution was not part of the recorded local verification.
The included GitHub Actions workflow is configured for Ubuntu and Windows on
Node.js 22 and 24. The first hosted Windows run exposed a Git-root path comparison
issue; the current implementation checks the working-tree location through Git.
See the [CI follow-up](verification/GITHUB_CI.md) for the original failure,
the correction, and links to current run results.

## Development

```sh
npm ci --ignore-scripts
npm test
node evaluation/public/run.mjs
```

The public replay uses the checked-in source corpus. It does not install or execute
the evaluated projects. Historical synthetic runners protect their output from
overwriting; follow [VERIFICATION.md](VERIFICATION.md) for the replay procedure.

`SOURCE_MANIFEST.json` preserves the file inventory of the original portable
delivery. Its documentation hashes describe that delivery, before the GitHub
guides were added. `PUBLICATION_MANIFEST.json` records this initial repository
publication; subsequent Git commits provide version history. Absolute scratch
paths in historical evaluation output identify the original run environment.

| Location | Contents |
| --- | --- |
| `src/` | Rule model, scope resolution, ingestion, AST engine, reports, and adapters |
| `bin/` | CLI entry point |
| `schemas/` | Configuration and rule schemas |
| `examples/` | Five synthetic projects, agreements, MR inputs, and approved example rules |
| `test/` | Engine, boundaries, CLI, and ESLint tests |
| `evaluation/` | Public and synthetic corpora, provenance, and preserved evaluation history |
| `verification/` | Recorded validation artifacts |

Contributor invariants are in [AGENTS.md](AGENTS.md). Additional design notes are
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/RULES.md](docs/RULES.md), currently in Russian.

## Licensing

SelfReview is currently marked `UNLICENSED`; no open-source license has been
selected for the project's own code. Third-party evaluation inputs retain their
original licenses and notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
