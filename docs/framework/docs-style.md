# Style sheet for the user docs

The user docs are `docs/README.md`, `docs/quickstart.md`, `docs/guides/`, `docs/reference/` and `docs/explanation/`. They follow the conventions of the React, Vue and Svelte docs, read from the live sites on 2026-11-22. This file is framework-only: a created project does not take it.

## Where each page goes

| Folder | The reader wants to | Shape |
|---|---|---|
| `quickstart.md` | get something working | One task, in order, start to finish |
| `guides/` | do one job | A goal, the steps, what can go wrong |
| `reference/` | look something up | Complete, dry, one entry per thing |
| `explanation/` | understand why | Prose; no steps |

A page belongs to one folder. If a guide starts explaining, link to an explanation page instead.

## Voice

1. Address the reader as "you". Keep "we" for "we recommend".
2. Present tense. Future only for "you will learn".
3. Imperative for steps: "Run", "Add", "Call".
4. Under 20 words a sentence, one idea each.
5. The first sentence says what the thing is or what the page gets you.
6. No selling. No "simply", "just" or "easy". No exclamation marks.

## Structure

7. The quickstart and guides open with one or two sentences, then a "You will learn" list of three to six items where the page teaches more than one thing.
8. Sentence-case headings. H2 and H3 only.
9. Reference headings are the name in code font, one name per heading. The export check depends on this.
10. Guides end with "Next steps": one to three links.
11. Troubleshooting headings quote the message the reader sees.

## Code

12. Introduce each sample with one sentence ending in a colon.
13. Show the file name as the first line of a complete file, as a comment: `// app/src/contacts-screen.tsx`.
14. After the sample, say what to notice.
15. Mark wrong and right code with comments inside the block.
16. Every `ts` and `tsx` sample must compile. A block that shows a declaration's shape is marked `ts signature` and is not compiled.
17. Commands go in `sh` blocks. Output goes in `text` blocks and is copied from a real run.

## Callouts

18. Two kinds, as blockquotes: **Note** for an aside, **Pitfall** for a common mistake. At most one per 300 words.

## Reference entries

19. Order: one-sentence definition, signature, Parameters, Returns, Caveats, then a usage sample.
20. Parameters as a list: name in code, then what it is.

## Rules that come from this repository

21. Document only what `framework/index.ts` exports. A sample imports only `@trellis/framework`, `react`, its own files, and packages in `app/package.json`.
22. Do not write the framework's name in the user docs, except inside the identifiers `@trellis/framework`, `TrellisApp`, `TRELLIS_PUBLIC_KEY` and `TRELLIS_SIGNING_KEY`. A created project keeps these pages, and gate G2 allows the name nowhere else. Write "the framework".
23. Do not link from the user docs to `docs/framework/` or the ADRs. A created project does not have them.
24. Where the code and an ADR disagree, the docs follow the code.
25. Samples compile against `docs/samples/app`, a copy of the example app, and not against `app/`. A created project's app changes; the docs' samples must still compile there.
26. Do not use a table or field name in a sample that is a quoted word in framework source, such as `name`. A created project keeps `framework/runtime/test/empty-app.test.js`, which rejects it.

## What checks this

`framework/test/docs.test.js`, part of `npm test`:

- every export of `framework/index.ts` has a heading in `docs/reference/api.md`, and no heading names a non-export
- every relative link and anchor resolves
- every sample typechecks and passes the app import rule
