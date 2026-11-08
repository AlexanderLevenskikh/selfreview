# SelfReview user guide

[Русский](USERGUIDE.ru.md) · [README](README.md) · [Detailed rule reference, in Russian](docs/RULES.md)

SelfReview is a local tool for preparing JavaScript and TypeScript changes for review. It stores conventions in explicit project scopes, proposes rules from code, documents, and merge request comments, runs a bounded set of AST checks, and exports material for people and coding agents.

The working cycle is **collect evidence → inspect candidates → approve applicable conventions → check changes → review behavior and design**. A frequent coding pattern or a resolved MR comment does not become an enforced convention automatically.

## 1. Install from Git

You need **Node.js 22.13 or newer**, npm, and Git for cloning and the `--base` workflow. The Git repository does not contain `node_modules`: install dependencies after cloning.

Git review modes require support for `git --no-lazy-fetch`. Missing objects must
fail without contacting a promisor remote. Check support with
`git --no-lazy-fetch --version`; source-only review does not invoke Git.

The Windows examples below use PowerShell 5.1. Run each command on its own line. Using `npm.cmd` avoids needing to change PowerShell's script execution policy; PowerShell 5.1 does not support the `&&` operator.

```powershell
node --version
git clone https://github.com/levencode-labs/selfreview.git 'C:\SelfReview'
Set-Location 'C:\SelfReview'
npm.cmd ci --ignore-scripts
node .\bin\selfreview.mjs --version
node .\bin\selfreview.mjs --help
```

The full installation includes runtime and development dependencies. If you only need the CLI, use this installation command instead:

```powershell
npm.cmd ci --ignore-scripts --omit=dev
```

Tests and development checks of the ESLint adapter need development dependencies, so use the full command without `--omit=dev` for those tasks. `npm ci` may access your configured npm registry. Once dependencies are installed, CLI operations do not need network access, an API key, or an AI service.

On Linux or macOS:

```sh
git clone https://github.com/levencode-labs/selfreview.git
cd selfreview
npm ci --ignore-scripts
node bin/selfreview.mjs --help
```

The remaining examples assume that SelfReview is in `C:\SelfReview` and your projects are in `C:\Repos\A` through `C:\Repos\E`. Run them from the SelfReview root. Keep quotes around paths with spaces. The `$srConfig` variable lasts only for the current PowerShell session; set it again in a new terminal. On Linux/macOS, replace the Windows paths and use `node bin/selfreview.mjs`.

Implementation checks were run on Linux with Node.js 24.22.1. The PowerShell examples have been reviewed for 5.1 syntax; a full manual run of every example on Windows PowerShell 5.1 has not been performed. Automated Windows runs and the Git-root correction are documented in the [CI follow-up](verification/GITHUB_CI.md). CLI help, some diagnostic messages, and generated reference explanations are currently in Russian. The detailed rule reference (`docs/RULES.md`), architecture notes (`docs/ARCHITECTURE.md`), and verification report (`VERIFICATION.md`) are also in Russian. This guide does not imply complete interface localization; command names and JSON field names do not depend on the guide language.

## 2. Register scopes A, B/C/D, and E

A configuration can live outside the repositories you review. This makes it practical to share a convention set across several projects.

```powershell
$srConfig = 'C:\SelfReview\workspace\selfreview.config.json'

node .\bin\selfreview.mjs init --config $srConfig --scope a --project 'C:\Repos\A'

node .\bin\selfreview.mjs scope add team-bcd --config $srConfig --project 'C:\Repos\B' --project 'C:\Repos\C' --project 'C:\Repos\D'

node .\bin\selfreview.mjs scope add e --config $srConfig --project 'C:\Repos\E'

node .\bin\selfreview.mjs doctor --config $srConfig
```

The project directories must already exist. `init` creates the configuration and an empty rule catalog; it refuses to overwrite an existing configuration or catalog. It does not edit the project source.

For folders named A, B, C, D, and E, the generated project IDs are `a`, `b`, `c`, `d`, and `e`. A **project ID** identifies a registered directory; a **scope ID** identifies its convention set. Identical folder names get suffixed project IDs. Read the actual IDs returned by `init`, `scope add`, or `doctor`.

| Scope | Project IDs | Shared conventions |
|---|---|---|
| `a` | `a` | Project A conventions |
| `team-bcd` | `b`, `c`, `d` | Shared B/C/D conventions |
| `e` | `e` | Project E conventions |

A project belongs to one scope. Other scopes are not inferred from directory names. Inheritance requires an explicit `extends` relationship; `scope add NAME --extends PARENT --project FOLDER` can create a child scope. The parent must already exist. To change inheritance later, edit and validate the configuration. Use rule applicability for path-specific variants within a project.

`--project` has two meanings depending on the command: `init` and `scope add` accept a **folder**, while `review`, `agent-pack`, and `export` accept a registered **project ID**. Project roots cannot overlap as ancestor and descendant directories.

The main files in this example are:

- `C:\SelfReview\workspace\selfreview.config.json`: scopes, projects, and configuration.
- `C:\SelfReview\workspace\.selfreview\catalog.json`: candidates, approved rules, evidence, and recorded decisions.

The catalog is editable local JSON. It may contain excerpts from internal documents or reviews. SelfReview does not add ignore entries to your project repositories. Keep private catalogs, raw MR exports, and reports out of a public repository unless you have deliberately reviewed them for publication.

`doctor` validates the configuration and catalog. Run `review` to analyze source files and detect conflicting rule variants that apply to a file.

## 3. Learn from code, documents, and MR comments

Suppose the conventions for A are in `C:\Rules\A` and an MR export is in `C:\Reviews\review.json`:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --docs 'C:\Rules\A' --mr 'C:\Reviews\review.json' --out 'C:\SelfReview\workspace\learn-a.json'
```

This reads source code in projects directly assigned to scope `a`, the supplied documents, and MR comments. It adds **candidates** to the catalog and writes a JSON report. `learn` has no separate text presentation: its output is JSON by default.

Documents may be UTF-8 Markdown, plain text, or JSON containing declarative rules. DOCX, PDF, HTML, and images are not parsed directly. Convert their relevant content to Markdown or text first. Unsupported files encountered in a document directory produce warnings.

Repeat `--docs` and `--mr` to supply multiple sources:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope team-bcd --docs 'C:\Rules\Shared' --docs 'C:\Rules\Testing.md' --mr 'C:\Reviews\first.json' --mr 'C:\Reviews\second.json' --out 'C:\SelfReview\workspace\learn-team.json'
```

Code discovery runs by default. `--code` narrows the sample to folders or files inside projects in the selected scope:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --code 'C:\Repos\A\src\components' --docs 'C:\Rules\A' --out 'C:\SelfReview\workspace\learn-components.json'
```

This changes the **sample**, not the project assignment or rule applicability. A narrow sample does not establish a convention for every file in the scope.

To import only documents and comments:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --no-code --docs 'C:\Rules\A' --mr 'C:\Reviews\review.json' --out 'C:\SelfReview\workspace\learn-sources.json'
```

### Specify precise rules with JSON

When a convention has exceptions or multiple variants, declare its parameters explicitly. Save this as `C:\Rules\A\logging.json`:

```json
{
  "title": "Application logging",
  "description": "Application sources allow console.warn and console.error only; normal logging uses the team's logger.",
  "family": "no-console",
  "mode": "enforce",
  "severity": "error",
  "check": {
    "kind": "no-console",
    "options": { "allowMethods": ["warn", "error"] }
  },
  "applicability": {
    "include": ["src/**/*.ts", "src/**/*.tsx"],
    "exclude": ["**/*.test.ts", "**/*.test.tsx"]
  }
}
```

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --no-code --docs 'C:\Rules\A\logging.json' --out 'C:\SelfReview\workspace\learn-logging.json'
```

An input can be one object, an array of objects, or an object containing a `rules` array. The same JSON can appear in a Markdown fence with the exact language tag `selfreview-rule`:

````markdown
## Logging

```selfreview-rule
{
  "title": "Remove debugger statements",
  "description": "Remove debugger statements before submitting application code.",
  "check": { "kind": "no-debugger", "options": {} },
  "applicability": { "include": ["src/**"], "exclude": [] }
}
```
````

The importer supplies an ID, the scope selected by the command, and actual source provenance. A source object containing `status: approved` cannot bypass candidate review.

Applicability paths are relative to each project root in the scope. Supported glob operators are `*`, `**`, and `?`. List alternatives separately, as above; brace patterns such as `*.{ts,tsx}` are not supported.

For variants in one family, use disjoint paths or explicit `overrides` and `overrideReason`. Use the exact observed IDs of rules you intend to replace. Overrides must target the same family in the same scope or an ancestor scope; JSON ordering does not decide which rule wins. Review inheritance and applicability before approval. The [detailed rule reference](docs/RULES.md) contains fuller examples in Russian.

### What discovery can establish

This version proposes three kinds of conventions from source frequencies:

- `const`/`let` instead of `var`.
- Strict equality, including a separate variant that permits `== null`.
- Braces around supported control-flow bodies.

Defaults are at least five syntactic observations and a frequency of 0.9. These are observations, not independent projects or reviewers. `--min-samples` and `--threshold` change candidate selection; neither approves a rule. Function and component lengths, parameter counts, and imports are sample statistics. An observed percentile is not automatically a team size limit.

For a shared scope, the report includes aggregate observations and profiles by project. If an adequately sampled project contradicts a proposed group-wide convention, the proposal is withheld with `MIXED_PROJECT_CONVENTIONS`. A small sample also does not prove that projects agree.

Text extraction recognizes narrow English and Russian templates such as “Do not use var,” “Do not use console except warn, error,” or “Components must have at most 100 lines.” Other prose is retained as a `manual` candidate. Console method exceptions preserve canonical spelling such as `timeEnd`; an unrecognized method or conditional exception stays manual. Use explicit JSON for precise behavior.

Markdown headings remain part of the evidence and description. Neutral headings such as `Agreements` and a matching topic such as `Variables` are supported. Headings such as `Production code only`, `Только production`, `tests/**`, `for legacy`, or uncertain context keep the prose rule manual. The importer does not guess paths from such headings. A structured rule with explicit applicability can remain an AST candidate, but you must check that its parameters capture the written condition.

Documents and comments are treated as source data. Instructions inside them to run commands, approve rules, or change the review process are not executed and do not constitute user approval.

Read `warnings`, `unmapped`, `codeFilesAnalyzed`, and coverage details. `CANDIDATES_READY` means the supported import completed; it does not establish an exhaustive convention set. Missing input, unsupported documents, or incomplete parsing can produce `CANDIDATES_WITH_COVERAGE_GAPS`. `learn` can return exit code 0 with that status, so examine the report as well as the process exit code.

## 4. Inspect and approve one rule

List the candidates:

```powershell
node .\bin\selfreview.mjs rules list --config $srConfig --scope a
```

A candidate ID depends on its content and source. Copy an actual ID from your output. Do not substitute an invented example ID or approve every candidate merely because its frequency is high.

```powershell
$srRuleId = Read-Host 'Paste the exact ID of one candidate from rules list'
node .\bin\selfreview.mjs rules show $srRuleId --config $srConfig
```

Before approving, establish that the rule is a current team agreement, the selected scope and paths are appropriate, exceptions such as `allowNull` have been preserved, the source has enough context, and no conflicting variant is already active.

Then record the decision:

```powershell
node .\bin\selfreview.mjs rules approve $srRuleId --config $srConfig --by 'Developer' --reason 'Checked the current team agreement and applicability'
```

Or reject the candidate:

```powershell
node .\bin\selfreview.mjs rules reject $srRuleId --config $srConfig --by 'Developer' --reason 'This comment is specific to one MR and is not a scope convention'
```

`--by` records a decision; it is not an authenticated identity or cryptographic signature. Approval remains your responsibility. Candidates are not enforced, and rejected rules retain the recorded decision without participating in checks.

For machine-readable listing:

```powershell
node .\bin\selfreview.mjs rules list --config $srConfig --scope a --json --out 'C:\SelfReview\workspace\rules-a.json'
$srRules = Get-Content 'C:\SelfReview\workspace\rules-a.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$srRules | Select-Object id, status, title
```

### Editing and importing again

You can edit the local `catalog.json`. Changing an approved rule's checked content, including parameters, applicability, wording, or evidence, invalidates its approval. Review stops with `STALE_APPROVAL` until the changed version is inspected and approved again. Do not manually recalculate `approval.behaviorHash` to bypass that step.

Importing equivalent evidence accumulates observations around a stable rule identity. An unrelated paragraph edit does not recreate an unchanged agreement. A changed scope, applicability, condition or behavior can produce a new candidate linked as a potential revision; old approved or rejected decisions are not automatically overwritten. Compare the versions and make an explicit decision so that two active, overlapping variants do not conflict. Ambiguous wording is kept separate. See section 11 for history, preview and registered-source refresh.

### Supported AST checks

All of these are static syntax checks. They do not execute or fully type-check the project.

| `check.kind` | Main options | Meaning |
|---|---|---|
| `no-var` | `{}` | Disallow `var` declarations |
| `no-console` | `allowMethods: ["warn", "error"]` | Restrict supported global console uses; account for local shadowing |
| `no-debugger` | `{}` | Disallow `debugger` statements |
| `strict-equality` | `allowNull: true` | Restrict `==` and `!=`, with an explicit null-comparison exception |
| `restricted-import` | `modules: ["legacy-library"]` | Restrict supported statically identifiable imports |
| `restricted-call` | `callees: ["document.write", "*.substr"]` | Match call syntax; does not establish runtime identity |
| `function-max-lines` | `max: 80` | Measure physical lines of supported function nodes |
| `component-max-lines` | `max: 150` | Measure components identified by the AST heuristic |
| `max-parameters` | `max: 5` | Count declared function parameters |
| `no-async-promise-executor` | `{}` | Detect supported `new Promise(async ...)` uses |
| `require-braces` | `{}` | Require braces around supported conditional and loop bodies |
| `manual` | `{}` | Add a semantic review item without an AST verdict |

Size limits in the table are examples, not inferred team standards. A rule has a finite supported `kind` and options; the catalog cannot contain executable custom JavaScript.

## 5. Supply MR evidence

### Neutral JSON format

Save this UTF-8 example as `C:\Reviews\review.json`:

```json
{
  "title": "Logging discussion example",
  "diff": "--- a/src/format.ts\n+++ b/src/format.ts\n@@ -1 +1 @@\n-console.log(value);\n+logger.info(value);\n",
  "comments": [
    {
      "body": "Do not use console.",
      "path": "src/format.ts",
      "line": 1,
      "side": "old",
      "resolved": true
    },
    {
      "body": "Preserve the order of side effects in this adapter.",
      "path": "src/format.ts",
      "line": 1,
      "side": "new",
      "resolved": false
    }
  ]
}
```

The first comment can become an AST candidate; the second remains manual. `resolved: true` preserves the discussion state, not approval of a general convention. An old-side comment is not relocated to a new-side line. Imported coordinates are evidence, not proof that the discussion matches the current working tree.

### Separate diff and comments files

`comments.json` can contain an array of comment objects with `body`, `path`, `line`, `side`, and `resolved`:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --no-code --diff 'C:\Reviews\change.diff' --comments 'C:\Reviews\comments.json' --out 'C:\SelfReview\workspace\learn-mr.json'
```

For this form, supply both `--diff` and `--comments`. Plain-text comments are also accepted, with weaker location context. A diff without reviewer comments is context; changing code alone does not establish a team convention. To supply a diff-only MR source, use an MR JSON object with an empty `comments` array rather than omitting the required paired flag.

### GitLab discussions export

Discussion arrays with `notes` are supported:

```json
[
  {
    "id": "discussion-example",
    "notes": [
      {
        "id": 123,
        "body": "Do not use var.",
        "system": false,
        "resolved": true,
        "author": { "username": "reviewer" },
        "position": {
          "old_path": "src/example.ts",
          "new_path": "src/example.ts",
          "old_line": 12,
          "new_line": null
        }
      }
    ]
  }
]
```

Pass this file through `--mr`. System notes do not become rules. This version does not connect directly to GitLab or download an MR by URL; supply a local export.

## 6. Review before submitting an MR

### Full project or shared scope

```powershell
node .\bin\selfreview.mjs review --config $srConfig --project a

node .\bin\selfreview.mjs review --config $srConfig --scope team-bcd --format json --out 'C:\SelfReview\workspace\review-team.json'
```

Project A uses scope `a`; B/C/D use `team-bcd`. Applicability is evaluated for each source file. Overlapping variants in the same family require an explicit decision; catalog order does not resolve the conflict.

### Changes relative to a local Git ref

If `C:\Repos\A` is the exact Git repository root:

```powershell
node .\bin\selfreview.mjs review --config $srConfig --project a --base origin/main --format json --out 'C:\SelfReview\workspace\review-a.json'
$srReviewExit = $LASTEXITCODE
```

`origin/main` must already exist locally; this command does not fetch. The comparison is against the supplied commit/ref, not an automatically calculated merge base. `--base HEAD` covers local changes relative to HEAD; another ref covers its difference from the current working tree. New untracked files are considered separately.

The configured project root must be the Git root. SelfReview refuses to use Git metadata from an ancestor repository when the project is only a subdirectory. For this workflow in a monorepo, register the Git root and express convention variants through paths.

### Supplied diff

```powershell
node .\bin\selfreview.mjs review --config $srConfig --project a --diff 'C:\Reviews\current.diff' --format json --out 'C:\SelfReview\workspace\review-diff.json'
```

Diff paths must be relative to the selected project root. Added and context lines must match current files. Stale or unverifiable context makes the review incomplete. A supplied deletion-only `-U0` diff has no new-side lines against which to verify the current file; use a fresh `--base` review or a diff containing context. Diff and base review require a single project; do not combine `--diff` with `--base`.

The complete file is parsed, then findings are filtered by overlap with touched nodes. Adding a line inside a large component can therefore report its size even if the declaration is outside the diff. This means the finding **touches the change**; it does not prove that the change introduced the issue. Strict regression attribution would also require analysis of the base version.

### Statuses and exit codes

| Status | Meaning | Exit code |
|---|---|---:|
| `CHECKS_PASSED` | Selected executable checks completed without blocking findings | 0 |
| `VIOLATIONS` | An approved `enforce` rule produced an `error` finding | 1 |
| `INCOMPLETE` | Configuration, conflicts, parsing, input, or coverage prevented completion | 2 |
| `ADVISORY_ONLY` | Only nonblocking advice was available; there were no mandatory AST checks | 0 |
| `MANUAL_REVIEW_REQUIRED` | Applicable approved rules include manual items | 0 |
| `NO_CHANGES` | The supplied diff has no changes for this run | 0 |
| `NOT_APPLICABLE` | The change has no applicable JS/TS postimages, such as README-only changes or deleted files | 0 |

For multiple projects, JSON contains `reports` and an aggregate `exitCode`, the maximum of the individual report codes. Errors that occur before a report is constructed may instead be written to stderr with exit code 2.

Exit code 0 is not approval of the whole MR. If CI requires completed manual review, inspect `status` and `manualChecklist` separately. Builds, type checks, existing tests, runtime behavior, and business logic remain separate checks.

Text reports group repeated advice and display at most three examples per group. JSON retains the complete findings list. Use `--out` to save reports: SelfReview writes UTF-8 itself, avoiding PowerShell redirection encoding differences.

## 7. Use a coding or review agent

Create a pack for one project:

```powershell
node .\bin\selfreview.mjs agent-pack --config $srConfig --project a --base origin/main --out 'C:\SelfReview\workspace\agent-pack-a.json'
```

The pack contains the selected project and scope, current approved rules, candidate questions, evidence, the review report, and instructions for distinguishing source data from authority. This creates a file; it does not launch an agent or call an AI API.

`agent-pack` returns the underlying review exit code. The file can be written successfully while the command returns 1 because violations were found. Read the report inside it.

A practical prompt for your chosen agent:

> Use this SelfReview agent-pack for project a. First inspect the current configuration, catalog, and rule applicability. Before implementation, identify responsibilities and side effects. After making changes, run SelfReview and the project's required checks, then review error handling, state ownership, decomposition, and behavior. Do not approve candidates automatically. Report convention violations, recommendations, and unverified questions separately.

For substantive review, inspect changed functions in full. A short component can still mix responsibilities, and a long component can be justified. A line count is a prompt to examine the design.

If an agent proposes additional conventions, save them as declarative JSON and import them:

```powershell
node .\bin\selfreview.mjs learn --config $srConfig --scope a --no-code --proposals 'C:\SelfReview\workspace\proposed-rules.json' --out 'C:\SelfReview\workspace\learn-proposals.json'
```

These proposals again become candidates. They cannot add arbitrary JavaScript execution to the rule engine.

## 8. Export a Skill, reference, and ESLint configuration

```powershell
node .\bin\selfreview.mjs export --config $srConfig --scope a --project a --out 'C:\SelfReview\exports\a-v1'
```

The destination must be absent or empty. Use a new directory, such as `a-v2`, for the next export.

| Output | Purpose |
|---|---|
| `rules.json` | Approved-rule snapshot and configured advisory layer |
| `candidates.json` | Unapproved candidates kept separately |
| `CONVENTIONS.md` | Human-readable reference with evidence |
| `selfreview-a/SKILL.md` and `references/` | Agent instructions and an approved-rule snapshot |
| `eslint.config.mjs` | Adapter for the selected project using the same AST core |
| `export-coverage.json` | Included checks and export limitations |

The Skill is an exported artifact. The command does not install it into Codex or ChatGPT or guarantee an agent's compliance. It is a snapshot: use the current local configuration, catalog, and a fresh report before changing code.

The ESLint configuration contains local adapter and configuration paths. Regenerate it after moving SelfReview or the configuration. For B/C/D, export for the intended project using `--project b`, `--project c`, or `--project d`. If you omit the project, the exporter chooses the first directly assigned project in the scope, which may not be the one you intend to lint.

### Add the ESLint adapter to an existing project

The host project supplies ESLint. TS/TSX also needs its TypeScript-aware parser; the SelfReview CLI already parses TS/TSX without that extra parser.

For a Windows installation at the paths in this guide, an integration can look like this:

```javascript
import tsParser from '@typescript-eslint/parser';
import { createFlatConfig } from 'file:///C:/SelfReview/src/eslint.mjs';

const selfreviewConfig = createFlatConfig(
  'C:/SelfReview/workspace/selfreview.config.json',
  'a',
);

export default selfreviewConfig.map(config => ({
  ...config,
  languageOptions: {
    ...config.languageOptions,
    parser: tsParser,
  },
}));
```

Merge this array into the project's existing flat configuration while preserving its other checks. The example is an integration pattern, not an instruction to replace an established setup. Use a parser compatible with the project's ESLint version. SelfReview's development versions are pinned in `package-lock.json`; installing them in SelfReview does not install a parser into the host project.

Keep the adapter's integrity checks enabled. Advice is mapped to ESLint warnings, so an external `--max-warnings=0` policy can make advisory findings block the host build even though the SelfReview CLI treats them as advice.

ESLint analyzes the files it is given. Use the CLI for inventory coverage, diff validation, and the manual checklist. Reload a long-running ESLint process after changing its loaded configuration or catalog.

## 9. Configure best-practice advice

The default advisory layer includes `var`, loose equality, large functions/components, parameter count, async Promise executors, and some potentially outdated call syntax. In the CLI these use `mode: advisory` and `severity: info`.

Approved conventions of the same family or check kind take precedence. The defaults are heuristics, not universal style standards or proof that code must be decomposed.

To turn off the entire advisory layer, set this property in the configuration:

```json
"bestPractices": false
```

To disable one built-in recommendation in one scope, add its ID and a meaningful reason to that scope's `disabledRules`:

```json
{
  "id": "e",
  "extends": [],
  "disabledRules": [
    {
      "id": "bp.legacy-calls",
      "reason": "Legacy runtime compatibility requires manual review before replacing APIs"
    }
  ]
}
```

The same mechanism can disable a particular catalog rule. Configuration changes should reflect an actual team decision.

For a path-specific convention allowing legacy calls, a declarative source could instead contain:

```json
{
  "title": "Review compatibility in legacy adapters",
  "description": "Preserve required legacy calls until compatibility and behavior have been checked manually.",
  "family": "restricted-call",
  "mode": "advisory",
  "severity": "info",
  "check": { "kind": "manual", "options": {} },
  "applicability": { "include": ["src/legacy/**"], "exclude": [] }
}
```

Import and inspect this like any other candidate. Once approved and applicable, its family suppresses the corresponding built-in legacy-call advice in those paths while retaining a manual review item. It does not silently override a separate approved prohibition; resolve overlapping explicit rules through the supported override mechanism.

## 10. Limitations, privacy, and development

Supported source extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts`. Declaration files are excluded. React component recognition is an AST heuristic; it does not prove full React semantics, component responsibilities, or the import graph. C#/.NET, Vue SFCs, Svelte, and other languages need separate adapters and are not supported by this version.

Source discovery excludes common generated and dependency directories, including `node_modules`, `dist`, `build`, and coverage output. Symlinks are not followed. Read failures, unsupported input, parsing failures, and bounded scanning can leave coverage gaps; inspect the report rather than assuming every file was checked.

There is no desktop UI, built-in GitLab client, automatic agent runner, or exhaustive inference of all conventions from arbitrary code. The catalog is shared data; CLI, ESLint, Skill, and human reference outputs apply it in different ways. A manual convention does not become a machine-verified claim.

CLI operations do not make network requests or execute the inspected project. Dependency installation through npm and sending a pack to an external agent are separate actions under your control. Catalogs, exports, and agent-packs may include project names, paths, and source excerpts. Review those contents before sharing them, particularly from private projects.

To develop SelfReview or repeat its tests, install development dependencies from the lockfile:

```powershell
Set-Location 'C:\SelfReview'
npm.cmd ci --ignore-scripts
npm.cmd test
```

If you previously used `--omit=dev`, the full `npm.cmd ci --ignore-scripts` command supplies the dependencies needed by tests. Linux checks do not replace acceptance testing on your own Windows toolchain.

## 11. Maintain rules and prepare a daily task

### Keep evidence and decisions together

Use the rule ID returned by `rules list`:

```powershell
node .\bin\selfreview.mjs rules history $srRuleId --config $srConfig
node .\bin\selfreview.mjs rules preview $srRuleId --config $srConfig --project a
```

History includes observed evidence, registered sources, potential revisions and
recorded decisions. A preview hypothetically activates the selected candidate
in a separate in-memory catalog, showing applicable files, findings, conflicts,
manual questions and examples. It does not approve the candidate or modify the
catalog. Preview findings do not change the current enforced policy.

Equivalent repeated evidence is stored separately from the approved/rejected
snapshot, so corroborating comments do not invalidate an existing approval.
Different scopes, conditions, options and applicability remain distinct. A
revision link is a review suggestion, not an automatic replacement.

### Refresh registered sources

```powershell
node .\bin\selfreview.mjs sources status --config $srConfig --scope a
node .\bin\selfreview.mjs sources refresh --config $srConfig --scope a
```

`status` reads current source bytes without writing. It distinguishes `current`,
`changed`, `missing` and `unavailable`. `refresh` reimports registered documents,
MR exports, proposals and paired comments/diffs without a new code scan. It never
approves or rejects rules. Missing, unavailable or unsupported registered inputs
remain coverage gaps and produce exit 2. The refresh result explains them.

The registry tracks imported files. Run `learn --docs FOLDER` again to discover
new files added to a source folder. Legacy evidence without a registered,
resolvable source is shown explicitly; it is not silently guessed or executed.

When an approved clause disappears from a refreshed document, the old rule is
retained and reported as `SOURCE_RULE_NOT_REOBSERVED`. Review it explicitly.
Current source bytes alone do not establish that every older agreement still
appears in that source.

Static discovery reports `supported`, `contradicted`, `insufficient` or
`unobserved` for each project in the proposed scope. A small sample is not an
endorsement, and sampling one project does not prove a shared convention.

### Give an agent only the effective rules for its files

```powershell
node .\bin\selfreview.mjs context --config $srConfig --project a --file src/Panel.tsx --file src/new-helper.ts --out 'C:\SelfReview\workspace\task-context-a.json'
node .\bin\selfreview.mjs context check --config $srConfig --input 'C:\SelfReview\workspace\task-context-a.json'
```

`--file` is repeatable and takes a path relative to the registered project root.
It can name a planned file that does not exist yet. Omit it for the configured
project inventory. Effective rules are resolved separately for every file;
disabled and overridden variants are shown under `suppressed`. Candidates stay
questions. Manual items identify their files and the answer expected from a
reviewer. The context includes absolute local paths and executable/argument
arrays, so an agent need not reconstruct a shell command from source text.

Freshness checking returns `CONTEXT_CURRENT`, `STALE_CONTEXT` or `INCOMPLETE`.
It compares trusted current policy and source bytes, including inherited source
documents. Recomputing the saved context's hash does not make fabricated rules
match the current catalog. This is a consistency check, not authentication.

Check the context **before editing**. Editing a selected source intentionally
makes the old snapshot stale. After editing, use the context's review invocation,
run the project's required checks and regenerate context for subsequent work.
`agent-pack` now contains this context alongside its review. `context check` also
rechecks a saved pack's policy/source binding and Git snapshot metadata, including
an index change that leaves the working file unchanged. It does not recompute
findings or authenticate their origin. A staged report and
working-tree context can differ; read `reportBinding` and the report's snapshot
metadata before attributing results to either state.

### Supply checkable examples

An imported declarative rule can include:

```json
"examples": [
  { "filename": "example.ts", "code": "const count = 1;", "expect": "valid" },
  { "filename": "example.ts", "code": "var count = 1;", "expect": "violation" }
]
```

Examples are parsed by the same AST checker and never executed. Expectations
apply to the checker in isolation, not to project/path applicability. A failing
expectation, parse failure or invalid example is shown explicitly. Manual rules
and legacy free-form examples remain unverified. Use only `PASS` examples as
checked illustrations. The supported bounds are 50 examples and 32 KiB of code
per example.

### Compare a change with its baseline

```powershell
node .\bin\selfreview.mjs review --config $srConfig --project a --base origin/main --merge-base --new-only --format json
node .\bin\selfreview.mjs review --config $srConfig --project a --staged --format json
node .\bin\selfreview.mjs review --config $srConfig --project a --staged --new-only --format json
```

Ordinary `--base` retains touched-node review. `--merge-base` records the requested
ref and calculated common ancestor. `--staged` reads index blobs, not unstaged
working-tree edits; its default base is `HEAD`. It cannot be combined with an
external `--diff`.

`--new-only` compares complete changed files against a trusted local Git
baseline and separates new, existing and resolved findings. Additional identical
occurrences are counted. A worsening size/parameter metric counts as a new
finding with `baselineChange: "worsened"` and `previousMetric`; different lexical
owners are not treated as the same named function. Supplied arbitrary diffs
cannot establish this baseline.
The report identifies what was compared and what affects its exit code.

The configuration and catalog must have compatible versioned policy for narrow
new-only gating. Changed, untracked or external policy can trigger a full-review
fallback, identified in the report. This is relevant to the external shared
configuration used earlier in this guide: it remains supported, but historical
policy cannot be recovered from a project repository that never contained it.
Baseline parse/read failures stay incomplete. Full review remains available to
show existing debt. Staged review does not run any inspected project code.

README-only or deletion-only changes can be `NOT_APPLICABLE`; this does not mean
the complete MR has been approved. An unreadable selected source or parse error
still gives `INCOMPLETE`. Binary patches, including binary-only assets, remain
unsupported and incomplete. Manual review, builds, types and runtime tests remain
separate obligations.

See [WORKFLOW.md](docs/WORKFLOW.md) and the [implementation plan](IMPLEMENTATION_PLAN.md)
for the API boundaries and acceptance protocol. Human time savings and fewer
real review comments have not yet been measured.

## Architecture references

The AST adapter uses the TypeScript Compiler API, and the ESLint adapter is a local plugin exposed through flat configuration. These documents describe the integration mechanisms; they do not validate your particular convention set:

- [Microsoft TypeScript: Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [ESLint: Custom Rules](https://eslint.org/docs/latest/extend/custom-rules)
- [ESLint: Configure Plugins](https://eslint.org/docs/latest/use/configure/plugins)

For complete rule fields, variants, exceptions, and evidence examples, see the [detailed rule reference, in Russian](docs/RULES.md).
