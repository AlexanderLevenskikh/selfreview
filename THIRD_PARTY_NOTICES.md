# Third-party components and evaluation sources

The portable runtime includes TypeScript 5.9.3, distributed under the Apache
License 2.0. Its license, copyright notices and third-party notices are preserved
in `node_modules/typescript/`.

The public source evaluation contains selected, unmodified source files from:

- `sindresorhus/p-limit`, revision `a8a6fbec4e0e866d6d779b10889bb4f5567e70eb`.
- `juliencrn/usehooks-ts`, revision `61949134144d3690fe9f521260a16c779a6d3797`.
- `jashkenas/underscore`, revision `5c1e5f686f8500af9c9d15614ed60289d6d35d6b`.

Their original MIT license/copyright files are preserved alongside each corpus
under `evaluation/public/corpus/`. They are evaluation inputs, not runtime
dependencies, and their project code is not executed by the evaluator.

Development dependency versions and integrity values are recorded in
`package-lock.json`. Development dependencies other than TypeScript are not
included in the portable archive; install them to run the developer test suite.
