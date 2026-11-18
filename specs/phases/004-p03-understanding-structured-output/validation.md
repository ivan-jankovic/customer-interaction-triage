# Phase 3 — Understanding with structured output: Validation

The branch `p03-understanding-structured-output` can be merged when every check below passes.

How each check is marked:

- **(test):** automated in Vitest.
  - Unit tests are under `test/` and run with `npm test`.
  - Integration tests are under `test/integration/` and run with `npm run test:integration`.
- **(ci):** a step in the GitHub Actions workflow that must be green on the pull request.
- **(manual):** needs a command or human judgement.

## Checks pass

- [x] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run audit` pass. **(ci)**
- [x] `npm test` passes with no `ANTHROPIC_API_KEY` set and no network. The Anthropic SDK guard in `test/setup/no-model-calls.ts` stays in place, so no unit test constructs a real client. **(ci)**
- [ ] `npm run test:integration` passes locally and in CI, with a mocked client. **(ci)**
- [x] The P00 dataset tests pass with unchanged assertions after the client move (only import paths change). **(ci)**

## LLM module and prompt

- [x] A classification request uses `output_config.format` with the stripped schema, `effort`, `cache_control` on the system prompt, and `fallbacks: "default"` with its beta. A P00 grader request has no `fallbacks`. **(test)**
- [x] A refusal, `max_tokens`, an API error and a fallback are each detected and reported. **(test)**
- [x] Every prompt file (`classify.v1` and the P00 prompts) has a SHA-256 hash in `versions.json` that matches its content. Changing a published prompt fails a test. **(test)**
- [x] `classify.v1.md` contains no dataset or injection message, and no 40-character excerpt of one. **(test)**
- [x] The prompt tells the model that instructions inside the message are data, asks for an English summary, and defines confidence as confidence in the intent. **(manual)**, by reading the prompt

## Understanding step

- [x] A valid model output gives `outcome = valid`, with every field and the usage, cost and latency filled. **(test)**
- [x] Unparsable JSON, an unknown intent, `confidence` outside 0–1, an empty summary or one over 400 characters, a missing field or an extra field each give `invalid`, with the raw output and readable errors kept. **(test)**
- [x] A refusal or `max_tokens` gives `invalid`; an API error gives `error`. None of them throws out of `understand`. **(test)**
- [x] After a fallback, `served_model` is the model that answered and `fell_back` is true. With an unknown price, `cost_usd` is null. **(test)**
- [x] A message containing `</customer_message>` cannot close the message block: the rendered user turn has exactly one closing tag. **(test)**
- [x] `TRIAGE_MODEL` and `TRIAGE_EFFORT` default to `claude-opus-5-5` and `low`; an unknown effort level, or a model without a price, is rejected with a clear message. **(test)**

## Storage and CLI

- [x] Migration `0002` creates `classifications` with the constraints in requirements.md. The database rejects a `valid` row without an intent, an `invalid` row with an intent, and a confidence outside 0–1. Rolling back drops the table. **(test)**
- [x] Valid, invalid and error attempts are stored as separate rows; `latestValid` returns the newest valid row and ignores newer invalid ones. **(test)**
- [x] `npm run classify -- <external_id>` with a mocked client stores exactly one row; an unknown ID exits with code 2 and stores nothing; `--dry-run` stores nothing. **(test)**
- [x] Without `ANTHROPIC_API_KEY`, `npm run classify` (not a dry run) fails with a clear message before any call. **(test)**

## Demo

- [x] `npm run classify -- --dry-run <id>` prints the prompt and its token count. **(manual)**
- [x] After the user's go-ahead, the 5 demo messages are classified. Each shows intent, urgency, language, fields, an English summary, confidence, model, tokens, cost and latency, and is stored in `classifications`. **(manual)**
- [x] The injection demo message's summary describes the request without following the embedded instruction. **(manual)**
- [x] The total demo cost and the cache reads are noted in the PR description. **(manual)**

## Specs updated

- [x] [tech-stack.md](../../tech-stack.md) says structured output uses `output_config.format`, summaries are in English, and lists the `classifications` columns and `src/cli/`. **(manual)**
- [x] `README.md` and `.env.example` describe `classify`, `TRIAGE_MODEL` and `TRIAGE_EFFORT`. **(manual)**
- [x] P03 is marked done in [roadmap.md](../../roadmap.md) after review. **(manual)**

## Scope checks

- [x] There is no `must_review`, team or review reason in the model output, and no routing code (P07). **(test)** for the schema, **(manual)** for the code
- [x] There is no evaluation runner or `eval/results/` (P04), and no masking code (P05). **(manual)**
- [x] Nothing moves an interaction out of `received`, and nothing touches Redis (P08). **(manual)**
