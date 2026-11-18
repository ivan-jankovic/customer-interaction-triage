# CLAUDE.md

Working rules for Claude Code in **customer-interaction-triage** (Customer Interaction Triage), a system that does the first pass over customer messages for a fictional Czech internet and mobile provider.

## The constitution

The project is built spec-driven. The constitution lives in `specs/`:
- `specs/mission.md`: what we build, why, principles, non-goals
- `specs/tech-stack.md`: technologies, architecture, data model, evaluation
- `specs/roadmap.md`: the phases, in order

Read all three at the start of every phase. Changes to them need approval: if a decision changes, propose the edit first.

## Starting a phase

1. Find the next unfinished phase in `specs/roadmap.md`.
2. Create a git branch named `pNN-<slug>`.
3. Ask about the feature spec. You **must** use the AskUserQuestion tool before writing anything to disk, with the questions grouped by the three files below. If more questions are needed than fit in one call, ask in several rounds until everything is clear.
4. Create the folder `specs/phases/NNN-pNN-<slug>/`, where `NNN` is the next free sequence number (naming rules are in `specs/roadmap.md`), containing:
   - `requirements.md`: scope, decisions, context
   - `plan.md`: a series of numbered task groups
   - `validation.md`: how to know the implementation succeeded and can be merged
5. Use the phase description in the roadmap as the starting scope, and refer to `specs/mission.md` and `specs/tech-stack.md` for guidance.
6. After writing the three files, **stop and wait for approval** before implementing.

## Implementing a phase

- Work through `plan.md` task group by task group, in order.
- Keep the app working after each task group: from P01 onwards, `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass, and `npm run test:integration` too when the group touches the database or Redis (it needs `docker compose up -d --wait`).
- Make small, focused commits with clear messages.
- Briefly record why non-obvious technical choices were made, in a code comment or the phase's `requirements.md`, so the reasoning is part of the review before anything is merged.
- If the plan turns out to be wrong or incomplete, stop and raise it instead of silently changing scope; update `plan.md` once the change is agreed.

## Finishing a phase

- A phase is finished when everything in its `validation.md` passes, including the **Demo** and **Done when** criteria from the roadmap.
- Once it has been reviewed, mark the phase as done in `specs/roadmap.md` (e.g. "✅ P04 …") on the phase branch, so the update is merged together with the work.
- Push the phase branch and open a pull request to `main` on GitHub. Merge only when CI (`checks` and `integration`) is green, with a merge commit (the repository allows no other kind). `main` is not protected on this plan, so this is a rule to follow, not one GitHub enforces: never push to `main` directly.
- Ask before merging the pull request.

## Engineering rules

- **Unit tests never call a model.** The LLM client is mocked; model calls happen only in evaluation runs.
- **Model calls cost money.** Ask before running the full evaluation; prefer the small subset while developing.
- **Validate every model output** against its schema before use; invalid output goes to review, never into a decision.
- **Decisions are made in code.** Routing and review rules are code with tests, not prompt instructions.
- **Only synthetic data.** No real customer data, and no names or details of real companies or people.
- **Mask before the model.** Nothing after the masking step sees raw personal data.
- **No secrets in the repo.** API keys (e.g. `ANTHROPIC_API_KEY`) come from environment variables or CI secrets; `.env` is in `.gitignore`.
- **Version prompts.** Every prompt change gets a new version, and evaluation results record which version they used.
