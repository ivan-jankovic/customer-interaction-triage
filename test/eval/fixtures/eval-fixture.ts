// A hand-made 8-message evaluation, used by the metrics, report and runner tests.
// Every expected value in test/eval/metrics.test.ts is worked out by hand from this table:
//
// id  lang label (intent/urgency/service/area, ids)            prediction                                    judge
// m1  cs   technical_fault/high/internet/Kolín, [MR1]        all right, area "kolin" (diacritics), 0.95      5/4
// m2  cs   complaint/normal/mobile/null, [phone spaced]      billing_question; phone unspaced (fp+fn), 0.85 4/3
// m3  sk   billing_question/low/internet/null, []            urgency normal (wrong); invents an email; 0.70  5/5 PII
//                                                            fallback to claude-opus-4-8, cost unknown
// m4  sk   cancellation/normal/tv/Bratislava, [contract]     invalid output                                  —
// m5  en   tariff_change/low/mobile/null, []                 language cs (wrong), 0.40                       3/4
// m6  en   other/low/unknown/null, []                        API error                                       —
// m7  cs   technical_fault/normal/internet/Brno, []          complaint; area Praha (wrong), 0.92             judge invalid
// m8  cs   complaint/normal/mobile/null, [MR2, account]      urgency high, service tv (wrong); finds MR2 only, 0.88  4/4

//
// Routing (P07), against FIXTURE_SEED: customer MR10000001 has internet in Kolín, MR20000002 has
// mobile in Praha. Labels follow the rules: must_review for cancellation, complaint and the two
// messages labelled unclear (m3, m5); expected_team from the intent.
//
// id  enrichment       routed to          reason codes                              label must-review
// m1  found            technical_support  —                                         no   (team right)
// m2  not_found        billing            customer_not_found                        yes  (team wrong)
// m3  no_identifiers   billing            — (0.70 is not below 0.7)                 yes, unclear: MISSED
// m4  — (invalid)      general            invalid_output                            yes  (team wrong)
// m5  no_identifiers   sales              low_confidence                            yes, unclear: caught
// m6  — (error)        general            classification_error                      no   (team right)
// m7  no_identifiers   complaints         complaint                                 no   (team wrong)
// m8  found            complaints         complaint, crm_mismatch_service_type (tv) yes  (team right)

import type { CrmSeed } from "../../../src/db/crm-seed.js";
import { INTENT_TO_TEAM } from "../../../src/taxonomy.js";
import type { Labels } from "../../../eval/schema/labels.schema.js";
import type { JudgeResult, OutputLine } from "../../../eval/metrics/types.js";
import type { ClassificationAttempt } from "../../../src/pipeline/understand.js";
import type { Language } from "../../../src/taxonomy.js";

type Ids = Labels["fields"]["identifiers"];

function labels(
  intent: Labels["intent"],
  urgency: Labels["urgency"],
  service_type: Labels["fields"]["service_type"],
  area: string | null,
  identifiers: Ids = [],
  unclear = false,
): Labels {
  const reasons: Labels["review_reasons"] = [
    ...(intent === "cancellation" || intent === "complaint" ? [intent] : []),
    ...(unclear ? (["unclear"] as const) : []),
  ];
  return {
    intent,
    urgency,
    must_review: reasons.length > 0,
    review_reasons: reasons,
    expected_team: INTENT_TO_TEAM[intent],
    fields: { identifiers, service_type, area },
  };
}

const USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 };
const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function valid(
  c: { intent: string; urgency: string; language: string; service_type: string; area: string | null; ids?: Ids },
  confidence: number,
  costUsd: number | null,
  latencyMs: number,
  extra: Partial<ClassificationAttempt> = {},
): ClassificationAttempt {
  const classification = {
    intent: c.intent,
    urgency: c.urgency,
    language: c.language,
    fields: { identifiers: c.ids ?? [], service_type: c.service_type, area: c.area },
    summary: `Summary for ${c.intent}.`,
    confidence,
  } as NonNullable<ClassificationAttempt["classification"]>;
  return {
    outcome: "valid",
    classification,
    rawOutput: JSON.stringify(classification),
    errors: [],
    promptVersion: "classify.v1",
    requestedModel: "claude-opus-5-5",
    servedModel: "claude-opus-5-5",
    fellBack: false,
    effort: "low",
    usage: USAGE,
    costUsd,
    latencyMs,
    ...extra,
  };
}

function judge(faithful: number, complete: number, pii = false): JudgeResult {
  return {
    outcome: "graded",
    scores: { faithful, complete, contains_personal_data: pii, reason: "ok" },
    rawOutput: "{}",
    errors: [],
    promptVersion: "summary-judge.v1",
    model: "claude-haiku-5-5",
    usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0.0002,
    latencyMs: 800,
  };
}

export interface FixtureMessage {
  id: string;
  language: Language;
  channel: "email" | "chat" | "call";
  /** The message itself: routing masks it to find the identifiers it enriches with. */
  text: string;
  labels: Labels;
  line: OutputLine;
}

const MR1 = { type: "customer_number" as const, value: "MR10000001" };
const MR2 = { type: "customer_number" as const, value: "MR20000002" };

export const FIXTURE: FixtureMessage[] = [
  {
    id: "m1",
    language: "cs",
    channel: "chat",
    text: "Zákaznické číslo MR10000001, v Kolíně mi nejde internet.",
    labels: labels("technical_fault", "high", "internet", "Kolín", [MR1]),
    line: {
      id: "m1",
      attempt: valid(
        {
          intent: "technical_fault",
          urgency: "high",
          language: "cs",
          service_type: "internet",
          area: "kolin",
          ids: [MR1],
        },
        0.95,
        0.008,
        2000,
      ),
      judge: judge(5, 4),
    },
  },
  {
    id: "m2",
    language: "cs",
    channel: "email",
    text: "Volám z +420 001 111 111, chci si stěžovat na poslední vyúčtování.",
    labels: labels("complaint", "normal", "mobile", null, [{ type: "phone", value: "+420 001 111 111" }]),
    line: {
      id: "m2",
      attempt: valid(
        {
          intent: "billing_question",
          urgency: "normal",
          language: "cs",
          service_type: "mobile",
          area: null,
          ids: [{ type: "phone", value: "+420001111111" }],
        },
        0.85,
        0.007,
        2500,
      ),
      judge: judge(4, 3),
    },
  },
  {
    id: "m3",
    language: "sk",
    channel: "chat",
    text: "Dobrý deň, neviem, či je moja faktúra správna.",
    labels: labels("billing_question", "low", "internet", null, [], true),
    line: {
      id: "m3",
      attempt: valid(
        {
          intent: "billing_question",
          urgency: "normal",
          language: "sk",
          service_type: "internet",
          area: null,
          ids: [{ type: "email", value: "a12@example.com" }],
        },
        0.7,
        null,
        4000,
        { servedModel: "claude-opus-4-8", fellBack: true },
      ),
      judge: judge(5, 5, true),
    },
  },
  {
    id: "m4",
    language: "sk",
    channel: "call",
    text: "Zmluva SML-2024-00001, chcem zrušiť televíziu v Bratislave.",
    labels: labels("cancellation", "normal", "tv", "Bratislava", [
      { type: "contract_number", value: "SML-2024-00001" },
    ]),
    line: {
      id: "m4",
      attempt: {
        ...valid({ intent: "other", urgency: "low", language: "sk", service_type: "tv", area: null }, 0.5, 0.006, 3000),
        outcome: "invalid",
        classification: null,
        rawOutput: "not json {",
        errors: ["not valid JSON"],
      },
      judge: null,
    },
  },
  {
    id: "m5",
    language: "en",
    channel: "email",
    text: "Hi, maybe I want a different mobile plan? Not sure yet.",
    labels: labels("tariff_change", "low", "mobile", null, [], true),
    line: {
      id: "m5",
      attempt: valid(
        { intent: "tariff_change", urgency: "low", language: "cs", service_type: "mobile", area: null },
        0.4,
        0.007,
        1500,
      ),
      judge: judge(3, 4),
    },
  },
  {
    id: "m6",
    language: "en",
    channel: "call",
    text: "Hello, I have a general question about your shops.",
    labels: labels("other", "low", "unknown", null),
    line: {
      id: "m6",
      attempt: {
        ...valid({ intent: "other", urgency: "low", language: "en", service_type: "unknown", area: null }, 0.5, 0, 100),
        outcome: "error",
        classification: null,
        rawOutput: null,
        errors: ["API error 529: overloaded"],
        usage: ZERO,
      },
      judge: null,
    },
  },
  {
    id: "m7",
    language: "cs",
    channel: "chat",
    text: "V Brně mi od rána nejde internet.",
    labels: labels("technical_fault", "normal", "internet", "Brno"),
    line: {
      id: "m7",
      attempt: valid(
        { intent: "complaint", urgency: "normal", language: "cs", service_type: "internet", area: "Praha" },
        0.92,
        0.009,
        2200,
      ),
      judge: { ...judge(1, 1), outcome: "invalid", scores: null, errors: ["/faithful must be <= 5"] },
    },
  },
  {
    id: "m8",
    language: "cs",
    channel: "email",
    text: "Číslo MR20000002, účet 1234567890/0042. Reklamuji vyúčtování.",
    labels: labels("complaint", "normal", "mobile", null, [MR2, { type: "bank_account", value: "1234567890/0042" }]),
    line: {
      id: "m8",
      attempt: valid(
        { intent: "complaint", urgency: "high", language: "cs", service_type: "tv", area: null, ids: [MR2] },
        0.88,
        0.008,
        3500,
      ),
      judge: judge(4, 4),
    },
  },
];

const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The mock CRM the fixture's routing is scored against (see the table at the top). */
export const FIXTURE_SEED: CrmSeed = {
  generator: "test fixture",
  dataset_hash: "fixture",
  customers: [
    {
      id: fixtureId(1),
      customer_number: "MR10000001",
      email: null,
      segment: "residential",
      created_at: "2020-01-01T00:00:00.000Z",
    },
    {
      id: fixtureId(2),
      customer_number: "MR20000002",
      email: null,
      segment: "residential",
      created_at: "2020-01-01T00:00:00.000Z",
    },
  ],
  services: [
    {
      id: fixtureId(11),
      customer_id: fixtureId(1),
      service_type: "internet",
      tariff: "Merelo Fiber 300",
      contract_number: "SML-2020-00011",
      phone: null,
      area: "Kolín",
      status: "active",
      started_at: "2020-01-01T00:00:00.000Z",
    },
    {
      id: fixtureId(12),
      customer_id: fixtureId(2),
      service_type: "mobile",
      tariff: "Merelo Mobil S",
      contract_number: "SML-2020-00012",
      phone: "+420601000002",
      area: "Praha",
      status: "active",
      started_at: "2020-01-01T00:00:00.000Z",
    },
  ],
  tickets: [],
  outages: [],
  // Expectations are the enrichment with the labelled area and service type; the eval tests
  // don't check them, but they keep the fixture a valid seed.
  messages: FIXTURE.map((m) => ({
    message_id: m.id,
    received_at: "2026-11-03T10:00:00.000Z",
    design: "eval fixture",
    expected:
      m.id === "m1" || m.id === "m8"
        ? {
            outcome: "found" as const,
            customer_id: fixtureId(m.id === "m1" ? 1 : 2),
            area: m.id === "m1" ? "Kolín" : "Praha",
            area_source: m.id === "m1" ? ("message" as const) : ("customer" as const),
            outage_ids: [],
          }
        : {
            outcome: m.id === "m2" || m.id === "m4" ? ("not_found" as const) : ("no_identifiers" as const),
            customer_id: null,
            area: m.labels.fields.area,
            area_source: m.labels.fields.area ? ("message" as const) : null,
            outage_ids: [],
          },
  })),
};
