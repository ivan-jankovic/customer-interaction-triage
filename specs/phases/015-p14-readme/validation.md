# Phase 14 — README: Validation

The branch `p14-readme` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest, run with `npm test` (the doc tests are in `test/docs/`).
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [ ] `npm test` passes with no `ANTHROPIC_API_KEY` and no network; no test calls a model. **(ci)**
- [ ] `npm run test:integration` passes in CI (nothing in it changes). **(ci)**

## Structure

- [x] `README.md` has, in this order: the opening paragraph, What a reviewer sees (with the screenshots), Results at a glance, How it works, Architecture, The pipeline, Data model, Key decisions, Limitations, Next steps, Quick start (changed during review; see requirements.md, Contents). **(manual)**
- [x] `docs/guide.md` holds the former reference (setup, intake API, each pipeline step, background processing, reviewing, evaluating, prompt injection, checks) with the same section titles, and links back to the README. **(manual)**
- [x] Nothing from the former README is lost: every command and every rule it described is in the README or the guide. **(manual)**

## Diagrams

- [ ] The architecture and pipeline diagrams are Mermaid `flowchart`s and render on GitHub. **(manual)**
- [ ] The README's data model is a Mermaid `erDiagram` of the pipeline tables and their relations (no columns), linking to the guide's "Data model" with the two detailed `erDiagram`s (pipeline tables; mock CRM); all render on GitHub, and every table and relation in them exists in the migrations. **(manual)**

## Key decisions

- [x] Each decision in requirements.md (Key decisions) has a short section with the decision, the alternative, why, and a link to its phase spec. **(manual)**

## Results

- [x] `docs/results.md` holds the full results, and every number in it links to the kept report it comes from; the README's "Results at a glance" links to it. **(manual)**
- [x] The numbers equal the kept reports: in the README, the six headline numbers and the review rate under Limitations; in `docs/results.md`, intent accuracy, must-review recall and precision, review rate, routing accuracy, urgency accuracy, investigation cause accuracy, injection scenarios passed, cost per message and the Opus vs Sonnet rows. **(test)**
- [x] The numbers test fails when one of those numbers in the README is changed by hand. **(manual)**
- [x] `docs/results.md` includes the confusion matrix, the per-language table with the "indicative" note, and "What the results do and don't show". **(manual)**

## Links and images

- [x] Every relative link in `README.md`, `docs/guide.md` and `docs/results.md` resolves, and every `#anchor` matches a heading (GitHub slug rules). **(test)**
- [x] Every image the README embeds is in `docs/images/`, exists, has alt text and is under 500 KB. **(test)**
- [x] The screenshots show no browser chrome and no raw message text. **(manual)**

## Cold read

A fresh subagent with no project context reads only the README and answers these questions. Each answer must agree with the specs; a gap is fixed in the README and the questions are asked again by a new subagent.

1. What does the system do, for whom, and what does it deliberately not do?
2. Which steps call a model, and what happens when a model's output is invalid?
3. Why are routing and review decided in code, and which cases always go to a person?
4. What is masked before a model sees the text, what isn't, and why?
5. How does the system make sure a stored message is not lost if Redis is down or the process crashes after saving it?
6. What does the investigating agent do, what can't it do, and what bounds it?
7. How was the labelled dataset built, and why can't its labels have come from the pipeline itself?
8. What are the headline results, and what do they not show?
9. How is prompt injection defended against, and what are the known limits?
10. What would you need to run it locally, and what costs money?

- [x] A fresh subagent answers all 10 correctly from the README alone; its answers and any fixes are recorded in requirements.md (Results). **(manual)**
- [ ] The user has read the README on GitHub and has no open questions about the design, the decisions or the results. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md)'s repository layout includes `docs/`. **(manual)**
- [ ] P14 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] No model call in this phase. **(manual)**
- [x] No source code under `src/` changes (`git diff main --stat -- src` is empty). **(manual)**
- [x] The prompts and their registry hashes are unchanged. **(test)**
- [x] The README names no real company or person, and every example is synthetic. **(manual)**
