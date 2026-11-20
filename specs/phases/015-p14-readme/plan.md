# Phase 14 — README: Plan

See [requirements.md](requirements.md) for scope and decisions, and [validation.md](validation.md) for the merge checklist.

**No model calls in this phase.** After every group, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass. No group touches the database or Redis.

## 1. Move the reference to `docs/guide.md`

1.1. Create `docs/guide.md` from the current README's sections from "Local setup" to the end (setup, intake API, classifying, masking, enrichment, investigating, routing and cases, background processing, reviewing, evaluating, prompt injection, checks). Add a title ("Guide") and a two-line introduction linking back to the README. Keep the section titles, so readers who look for them find them.

1.2. Fix every relative link for the new location (`specs/…` → `../specs/…`, `src/…` → `../src/…`, `eval/…` → `../eval/…`, `test/…` → `../test/…`, `.github/…` → `../.github/…`).

1.3. Reduce `README.md` to its title, the existing first two paragraphs, and a temporary "Guide" link, so the repository stays consistent until group 4 writes the overview.

## 2. Doc tests

2.1. `test/docs/markdown.ts`: helpers that read a Markdown file and return its links (inline `[text](target)` and images `![alt](src)`, skipping fenced code), its headings, and GitHub's anchor slug for a heading (lower case, punctuation removed except `-` and `_`, spaces to `-`, numbered duplicates `-1`, `-2`).

2.2. `test/docs/links.test.ts`: for `README.md` and `docs/guide.md`, every relative link resolves to an existing file or folder, and every `#anchor` matches a heading in its target Markdown file. External links (`http…`, `mailto:`) are skipped. Unit tests for the slug helper with headings from the repo (for example "Opus vs Sonnet", "In CI", "Phase 14 — README: Plan").

2.3. `test/docs/images.test.ts`: every image `README.md` embeds is a relative path under `docs/images/`, exists, and is under 500 KB; every image has alt text.

2.4. Run the tests: they pass on the guide and the reduced README.

## 3. Screenshots

3.1. Confirm the source files with the user (the P13 demo screenshots on the desktop): the queue, the top of a case page, the reviewed list and, if used, the investigation section.

3.2. Crop each with `sips` to remove the browser's address bar and toolbar, scale it down if needed to stay under 500 KB, and save it as `docs/images/review-queue.png`, `review-case.png`, `review-reviewed.png` (and `review-investigation.png`). Look at each result before committing it.

## 4. The overview

Write `README.md` in the order of requirements.md (Contents), each section from the sources named here, not from memory:

4.1. Title, one paragraph, "What it does" (from mission.md: the eight steps and the non-goals).

4.2. Architecture and pipeline Mermaid diagrams (from tech-stack.md "Core" and "Pipeline", `docker-compose.yml`, `src/worker.ts`, `src/pipeline/process.ts`), with one line per step.

4.3. Data model `erDiagram`s (from the migrations in `src/db/migrations/` and `src/db/database.ts`), and one line per table; link to tech-stack.md "Data model" for every column.

4.4. Key decisions: one short section each for the decisions in requirements.md (Key decisions), from the phase specs' Decisions tables and tech-stack.md, each linking its spec.

4.5. Results: the tables of requirements.md (Results), copied from the kept reports and linked to them, including the confusion matrix and "What the results do and don't show".

4.6. Review page: the screenshots with a sentence each.

4.7. Limitations, Next steps (from roadmap.md P15–P17 and "Ideas for later"), Quick start (from the guide's Local setup, shortened), and links to the guide, the constitution and the phase specs.

4.8. View the README rendered on GitHub (push the branch) to check the Mermaid diagrams and the images render; fix what doesn't.

## 5. Numbers test

5.1. `test/docs/numbers.test.ts`: a table of the README's headline numbers, each with the kept run (or comparison or injection report) and the metric it comes from. The test reads each `metrics.json`, formats the value the way the README shows it, and checks the README contains it. At least the numbers listed in requirements.md (Doc tests).

5.2. Check the test fails when a number in the README is changed by hand, then restore it.

## 6. Docs and specs

6.1. [tech-stack.md](../../tech-stack.md): the repository layout gains `docs/` (the guide and images).

6.2. Check `CLAUDE.md`, `eval/results/README.md`, `eval/data/README.md` and `eval/data/crm/README.md` for links to README sections that moved; point them at the guide.

## 7. Verify

7.1. Run lint, format check, type check, unit tests, build and audit.

7.2. **Cold read:** start a fresh subagent with no project context. It gets only the rendered text of `README.md` (no repository access) and answers the questions in [validation.md](validation.md) (Cold read). Check its answers against the specs; every wrong or "can't tell" answer is a gap in the README: fix it and ask again with a fresh subagent. Record the questions, the answers and the fixes in requirements.md (Results).

7.3. The user reads the README on GitHub as the final check.

7.4. Work through [validation.md](validation.md). After review, mark P14 done in [roadmap.md](../../roadmap.md), push, open the PR and ask before merging.
