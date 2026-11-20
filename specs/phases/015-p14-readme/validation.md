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

- [ ] `README.md` has, in this order: the opening paragraph, What it does, Architecture, The pipeline, Data model, Key decisions, Results, Review page, Limitations, Next steps, Quick start. **(manual)**
- [ ] `docs/guide.md` holds the former reference (setup, intake API, each pipeline step, background processing, reviewing, evaluating, prompt injection, checks) with the same section titles, and links back to the README. **(manual)**
- [ ] Nothing from the former README is lost: every command and every rule it described is in the README or the guide. **(manual)**

## Diagrams

- [ ] The architecture and pipeline diagrams are Mermaid `flowchart`s and render on GitHub. **(manual)**
- [ ] The data model is two Mermaid `erDiagram`s (pipeline tables; mock CRM) that render on GitHub, and every table and relation in them exists in the migrations. **(manual)**

## Key decisions

- [ ] Each decision in requirements.md (Key decisions) has a short section with the decision, the alternative, why, and a link to its phase spec. **(manual)**

## Results

- [ ] Every number in the Results section links to the kept report it comes from. **(manual)**
- [ ] The headline numbers equal the kept reports: intent accuracy, must-review recall and precision, review rate, routing accuracy, urgency accuracy, investigation cause accuracy, injection scenarios passed, cost per message. **(test)**
- [ ] The numbers test fails when one of those numbers in the README is changed by hand. **(manual)**
- [ ] Results includes the confusion matrix, the per-language table with the "indicative" note, and "What the results do and don't show". **(manual)**

## Links and images

- [ ] Every relative link in `README.md` and `docs/guide.md` resolves, and every `#anchor` matches a heading (GitHub slug rules). **(test)**
- [ ] Every image the README embeds is in `docs/images/`, exists, has alt text and is under 500 KB. **(test)**
- [ ] The screenshots show no browser chrome and no raw message text. **(manual)**

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

- [ ] A fresh subagent answers all 10 correctly from the README alone; its answers and any fixes are recorded in requirements.md (Results). **(manual)**
- [ ] The user has read the README on GitHub and has no open questions about the design, the decisions or the results. **(manual)**

## Specs updated

- [ ] [tech-stack.md](../../tech-stack.md)'s repository layout includes `docs/`. **(manual)**
- [ ] P14 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [ ] No model call in this phase. **(manual)**
- [ ] No source code under `src/` changes (`git diff main --stat -- src` is empty). **(manual)**
- [ ] The prompts and their registry hashes are unchanged. **(test)**
- [ ] The README names no real company or person, and every example is synthetic. **(manual)**
