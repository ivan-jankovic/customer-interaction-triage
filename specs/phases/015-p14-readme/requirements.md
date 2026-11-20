# Phase 14 — README: Requirements

## Context

This is phase P14 in [roadmap.md](../../roadmap.md), the last phase of the MVP. P00–P13 built the whole system: intake, masking, classification with structured output, enrichment, the investigating agent, routing rules with a decision log, the queue and worker, the review queue as a CLI and a web page, the evaluations, the injection scenarios and the evaluation in CI.

The README grew phase by phase into a **how-to reference**: setup, every command, and a section per pipeline step. What it doesn't have is the **overview**: what the system is for, how the parts fit, why it is built this way, how well it works and where it falls short. [mission.md](../../mission.md) makes that a success criterion: "A new reader can understand the design, the decisions and the limitations from the README in a few minutes." The roadmap's Done when is the same: "a new reader can understand the design, the decisions and the results without asking."

The README is also the project's front page: the first thing a reviewer, a hiring manager or a future contributor sees.

## Scope

In scope:

- **`README.md` becomes the overview** (see Contents). It ends with a short Quick start and links to the guide for everything else.
- **`docs/guide.md`**: the current README's how-to reference (setup, intake API, each pipeline step's commands, background processing, reviewing, evaluating, prompt injection, checks), moved with light edits: a title and introduction, links fixed for the new location, and the overview parts that move into the README replaced by links to it.
- **Diagrams in Mermaid**: the architecture, the pipeline, and the data model (see Diagrams).
- **Screenshots**: 3 or 4 of the review page in `docs/images/`, cropped from the P13 demo screenshots (see Screenshots).
- **Tests** for the docs (see Doc tests).
- **Docs:** [tech-stack.md](../../tech-stack.md) (the repository layout gains `docs/`). Approving this spec approves this edit.

Out of scope:

- Any model call. Every number comes from a committed, kept run (decided during spec review).
- New features, refactors or prompt changes. A wrong statement found while writing is fixed in the docs; a bug found in the code is raised, not fixed silently.
- The optional phases (P15 transcription, P16 MCP server, P17 confidence gate comparison). They appear only under Next steps.
- A documentation site or generator. Plain Markdown on GitHub.
- Rewriting the phase specs or `tech-stack.md`. The README links to them for detail.

## Contents

**Changed during review of the README (decided by the user):** the first version followed the order below and put all results in the README, so a reader met tables before seeing the product. The README now leads with the product: after the opening paragraph come **What a reviewer sees** (one message's journey told plainly, with the four screenshots) and **Results at a glance** (six headline numbers and the main caveat), then **How it works** (the eight steps), Architecture, The pipeline, Data model, Key decisions, Limitations, Next steps and Quick start. The full results (items of Results below, including the confusion matrix and "What the results do and don't show") moved to `docs/results.md`, linked from the README. The audience stays a new reader of the project, not the fictional reviewer: the mission's success criterion is about understanding the design.

The original order, kept for the record:

1. **Title and one paragraph:** what it is, for whom (a fictional Czech internet and mobile provider; e-mails, chats and call transcripts in Czech, Slovak and English), that it uses only synthetic data, and that it is built spec-first.
2. **What it does:** the eight steps of [mission.md](../../mission.md) in a few lines, and what it deliberately doesn't do (the non-goals: no chatbot, no autonomous actions, no real data).
3. **Architecture:** a Mermaid diagram (intake API, PostgreSQL, Redis/BullMQ, the worker, the Anthropic API, the review CLI and web page) and a few sentences on what runs where.
4. **The pipeline:** a Mermaid diagram of the steps (intake → store → queue → mask → classify → enrich → [investigate] → route → case + decision log → review), with one line per step: what it does, whether it calls a model, and what it stores.
5. **Data model:** the Mermaid diagrams of Diagrams, and one line per table.
6. **Key decisions:** one short section each (see Key decisions).
7. **Results:** see Results.
8. **Review page:** the screenshots, with a sentence each.
9. **Limitations:** see Limitations.
10. **Next steps:** the optional phases P15–P17 and the roadmap's "Ideas for later", one line each.
11. **Quick start:** the shortest path to a running system (install, `.env`, `docker compose up`, seed, load) and to the free checks, then a link to [docs/guide.md](../../../docs/guide.md) for everything else, and to the constitution and the phase specs.

### Key decisions

Each has a short section with four parts: the decision, the alternative that was considered, why, and a link to the phase spec that made it (decided during spec review). At least these:

| Decision | Spec |
| --- | --- |
| A workflow by default, one bounded agent only for technical faults | P10 |
| Decisions in code: routing and review rules are tested code, not prompt instructions | P07 |
| Structured output with a JSON Schema, validated with Ajv; invalid output goes to review | P03 |
| Masking before the model: rule-based, typed placeholders, the mapping used for CRM lookups; names and addresses not masked | P05 |
| Queue consistency between PostgreSQL and Redis: best-effort enqueue plus a periodic sweep, not an outbox | P08 |
| Untrusted input: layered defences against prompt injection, and the output check | P11 |
| The labelled dataset: labels first, two independent model graders, human review of every mismatch | P00 |
| Evaluation in CI on a small subset with a threshold, and a separate key with a spend limit | P12 |
| Review: one final review per case, masked by default, every unmask logged | P09, P13 |

### Results

Every number comes from a kept run in [eval/results/kept/](../../../eval/results/kept/) and links to its report (decided during spec review).

- **Classification** (`classify.v2`, `claude-opus-5-5`, 100 messages): intent accuracy and macro F1, the confusion matrix, urgency, service type and area accuracy, identifiers, the per-language table (with the "indicative" note for Slovak and English), summary scores.
- **Routing:** routing accuracy, must-review recall and precision, and the review rate, with the existing explanation of why the review rate is high on this dataset.
- **Investigation** (`investigate.v1`, 17 technical faults): cause accuracy, outcomes, turns and tool calls.
- **Prompt injection** (15 scenarios × 5 repeats): the pass rate per goal and tactic, and the two known limits.
- **Cost and latency:** per message for the classifier and per fault for the agent, p50 and p95; the Opus vs Sonnet table.
- **What the results do and don't show.** The scores are close to perfect, so this part matters most. The dataset is small (100 messages), synthetic, and written by models from chosen labels; every intent has an equal share; deliberately ambiguous messages are few. The results show that the pipeline does what it is designed to do on clean, labelled data and that the safety rules hold; they don't show how it would do on real traffic. This must be in the Results section, not only under Limitations.

### Limitations

At least: the dataset (as above); names and street addresses are not masked; the reviewer handle is not verified and the review key is shared; no login rate limit and no hosted deployment; the two known injection limits (a confidently wrong intent, a misleading summary without identifiers); review rules are conservative and not yet tuned with corrections; Czech and Slovak formats only for identifiers; the default model stays Opus although Sonnet matched it at 55% of the cost.

## Diagrams

Mermaid in the Markdown, which GitHub renders (decided during spec review).

- **Architecture:** a `flowchart` with the processes and stores.
- **Pipeline:** a `flowchart` of the steps, marking the ones that call a model and the conditional investigate step.
- **Data model** (decided during spec review): one `erDiagram` of the pipeline tables (`interactions`, `masked_identifiers`, `classifications`, `enrichments`, `investigations`, `cases`, `decision_log`, `reviews`, `unmask_log`) with their key columns and relations, and a smaller second one for the mock CRM (`crm_customers`, `crm_services`, `crm_tickets`, `crm_line_status`, `outages`). The full column lists stay in [tech-stack.md](../../tech-stack.md); the README links there.
- **Changed during review of the README:** the README shows only the pipeline tables and their relations, without columns, and links to a "Data model" section in `docs/guide.md` that holds both detailed diagrams. The column diagrams were too much for the front page. Decided by the user.

The diagrams are written from the migrations and `src/db/database.ts`, not from memory.

## Screenshots

Cropped from the P13 demo screenshots (decided during spec review): no new demo and no model calls. They show the merged page, including the queue's order hint.

- The queue list (P13 PR screenshot 1).
- The top of a case page (P13 PR screenshot 2).
- The reviewed list (P13 PR screenshot 9).
- Optionally the investigation section (P13 PR screenshot 8), if the README's pipeline section uses it.

Each is cropped to remove the browser's address bar and toolbar, saved in `docs/images/` as PNG under 500 KB, and has alt text. The sources are the files the user saved on the desktop during the P13 demo; the user confirms the paths before they are committed. The raw-text unmask screenshot is not used.

## Doc tests

Unit tests (no Docker, no network, no model), decided during spec review:

- **Links and anchors:** every relative link in `README.md` and `docs/guide.md` points at a file that exists, and every `#anchor` (in the same file or another Markdown file) matches a heading, using GitHub's slug rules.
- **Images:** every image `README.md` embeds is in `docs/images/`, exists, and is under 500 KB.
- **Numbers match the reports:** the README's headline numbers equal the kept runs' `metrics.json` (and the comparison and injection reports where the numbers come from there): at least intent accuracy, must-review recall and precision, review rate, routing accuracy, urgency accuracy, investigation cause accuracy, injection scenarios passed, and cost per message. A test names which run each number comes from, so a new kept run that changes a number fails the test until the README is updated.

## Decisions

### Requirements

| Decision | Choice | Why |
| --- | --- | --- |
| README and the how-to reference | The README becomes the overview; the reference moves to `docs/guide.md`, mostly unchanged | The overview must be readable in a few minutes (mission.md); the reference stays one link away. Decided during spec review. |
| Diagrams | Mermaid | Rendered by GitHub, diffable, easy to keep in step with the code. Decided during spec review. |
| Data model diagram | Pipeline tables and the mock CRM, key columns only | Readable at a glance; full columns stay in tech-stack.md. Decided during spec review. |
| Key decisions | A short section each: decision, alternative, why, spec | The trade-off is what a reader needs. Decided during spec review. |
| Screenshots | 3–4 cropped from the P13 demo, in `docs/images/` | Free, and show the merged page. Decided during spec review. |
| Results | Kept runs only, each number linked to its report | No model calls; every number checkable. Decided during spec review. |

### Plan

| Decision | Choice | Why |
| --- | --- | --- |
| Cropping | macOS `sips`, then a check that each file is under 500 KB | Built in; no new dependency. |
| Where the doc tests live | `test/docs/` | Unit tests, run by `npm test` and CI. |

### Validation

| Decision | Choice | Why |
| --- | --- | --- |
| "A new reader understands without asking" | A fresh subagent with no context reads only the README and answers a fixed question list; its answers are checked against the specs. Then the user reads it as the final check. | Decided during spec review. |
| Automated doc checks | Links and anchors, images, and numbers against the kept reports | Decided during spec review. |

## Notes

- **Older phase specs link to README sections** (for example "see the README, Reviewing cases"). They record what was true at the time and are not changed; the guide keeps the section titles, so a reader can find them there.
- **The README states results, not opinions.** Claims like "works well" are replaced by the number and its caveat.
- **GitHub renders Mermaid** in Markdown files; other viewers show the source. The diagrams are written so the source is readable too.
- **Privacy:** the screenshots and every example are synthetic; the README names no real company or person.

## Implementation notes

- **Cropping without `sips`.** `sips --cropOffset` is ignored on macOS 26.7, so the screenshots were cropped by a small script in the session's scratchpad: it reads the pixels from a BMP export (`sips -s format bmp`), finds the toolbar's 2-pixel grey separator, and writes the rows below it as a PNG with zlib and per-row filters (no new dependency). The four images are 145–197 KB.
- **The numbers test matches table rows as whole lines.** A substring match let a changed urgency number pass, because `| Urgency accuracy | 89.0% |` is also the start of the Opus vs Sonnet row. Found by editing numbers by hand (plan 5.2).
- **The guide no longer repeats results.** The routing results, the Opus vs Sonnet table and the injection result moved to the README; the guide links to them, so each number has one source.
- **A fact found while writing:** the dataset's messages were generated by `claude-opus-5-5`, the classifier's default model. The README says so under "What the results do and don't show". The labels stay independent of the pipeline (labels first, two other models as graders, human review of every mismatch).
- **Costs in the README come from the kept runs**: a full evaluation cost $0.60 ($0.0060 per message); the guide's "~$0.90" is the pre-run estimate the eval prints.

## Results (recorded during implementation)

- **Tests:** 1079 unit tests pass, including 92 doc tests (links and anchors in the README and the guide, the four images, 22 numbers against four kept runs). Lint, format, type check, build and audit pass; nothing under `src/` changed.
- **Cold read 1** (a fresh subagent given only the README's text): all 10 questions answered in agreement with the specs, four partly. Gaps it found, all fixed: the full list of review reasons and the 0.7 threshold; what happens when the agent's answer is invalid; what ends a job that keeps failing (`processing_failed` after 5 attempts); which models graded the dataset and the sample size. It also flagged confusing points, fixed: investigation accuracy 100% next to a 47% review rate (8 faults are designed to be `inconclusive`); 38 must-review vs 33 cancellations and complaints (plus 6 labelled unclear, one both); "routine" and "ambiguous" undefined; "equal share" vs 16/17; "identifier in output" vs placeholders; the shared review key vs authentication; costs given three ways; the injection tactics; skip missing from the Review row; "birth number".
- **Cold read 2** (a new subagent, the fixed README): all 10 answered correctly, none partly. Eight smaller wording points, fixed: what "unclear" is; that the CRM lookup uses the values behind the placeholders; what a CRM mismatch is; that `inconclusive` counts as a right cause; that the agent reports a confidence; that a message is stored as an interaction; what "no action was triggered" means; what `classify.v1` and `v2` differ in.
