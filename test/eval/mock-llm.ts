import type { LlmClient, LlmRequest, LlmResult, LlmUsage } from "../../eval/lib/llm.js";

export const USAGE: LlmUsage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** A scripted LLM client: answers come from a function of the request; every call is recorded. */
export function mockLlm(answer: (req: LlmRequest, callIndex: number) => string | { error: string }): LlmClient & {
  calls: LlmRequest[];
} {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req): Promise<LlmResult> {
      calls.push(req);
      const out = answer(req, calls.length - 1);
      if (typeof out === "string") return { ok: true, text: out, model: req.model, usage: USAGE };
      return { ok: false, error: out.error, model: req.model, usage: USAGE };
    },
  };
}
