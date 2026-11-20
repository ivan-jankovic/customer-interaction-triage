// The review page's HTML (P13) from hand-built data: no server, no database.

import { describe, expect, it } from "vitest";
import type { StoredReview } from "../../../src/review/case-view.js";
import type { QueueRow } from "../../../src/review/queue.js";
import type { ReviewedRow } from "../../../src/review/reviewed.js";
import {
  INTENT_TEAM,
  STYLESHEET,
  casePage,
  emptyQueuePage,
  filterParams,
  loginPage,
  queuePage,
  reviewedPage,
  type PageFilters,
} from "../../../src/review/web/pages.js";
import { CUSTOMER, INVESTIGATION, T, view } from "../../support/case-view.js";

const viewer = { reviewer: "reviewer-1", csrf: "c".repeat(43) };
const none: PageFilters = { spotCheck: false };
const CASE = "0190e9a0-0000-7000-8000-0000000ca5e1";
const EVIL = `<script>alert("x")</script>`;

/** Every form posting to the server carries the CSRF token (GET filter forms don't need it). */
function expectCsrfOnEveryPost(page: string) {
  const posts = page.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
  expect(posts.length).toBeGreaterThan(0);
  for (const f of posts) expect(f).toContain(`<input type="hidden" name="csrf" value="${viewer.csrf}">`);
}

function expectNoScript(page: string) {
  expect(page).not.toMatch(/<script/i);
  expect(page).not.toMatch(/\son[a-z]+=/i);
}

describe("filterParams", () => {
  it("builds a query string from the filters and extras", () => {
    expect(filterParams(none)).toBe("");
    expect(
      filterParams({ team: "billing", reason: "complaint", spotCheck: true }, { after: "x", done: undefined }),
    ).toBe("?team=billing&reason=complaint&spot_check=1&after=x");
  });
});

describe("loginPage", () => {
  it("has the key and handle fields, keeps the handle and escapes the error", () => {
    const page = loginPage({ error: EVIL, reviewer: `a"b` });
    expect(page).toContain('<input type="password" name="key"');
    expect(page).toContain('value="a&quot;b"');
    expect(page).toContain("&lt;script&gt;");
    expectNoScript(page);
    expect(page).not.toContain("Log out");
  });
});

describe("queuePage", () => {
  const row: QueueRow = {
    caseId: CASE,
    interactionId: "int-1",
    externalId: "msg-008",
    receivedAt: T,
    channel: "email",
    language: "cs",
    outcome: "valid",
    intent: "billing_question",
    confidence: 0.86,
    targetTeam: "billing",
    reasonCodes: ["crm_mismatch_unmatched_key"],
  };

  it("lists rows with links that keep the filters, marks skipped ones and links the next page", () => {
    const f: PageFilters = { team: "billing", spotCheck: false };
    const page = queuePage({ viewer, filters: f, total: 41, rows: [row], skipped: [CASE], nextAfter: CASE });
    expect(page).toContain(`<a href="/review/cases/${CASE}?team=billing">msg-008</a> <span class="tag">skipped</span>`);
    expect(page).toContain("<strong>41</strong> cases waiting for review.");
    expect(page).toContain('href="/review/next?team=billing">Start reviewing');
    expect(page).toContain(`href="/review?team=billing&amp;after=${CASE}">Next 50`);
    expect(page).toContain('<option value="billing" selected>billing</option>');
    expect(page).toContain('billing_question <span class="muted">(0.86)</span>');
    expect(page).toContain("Signed in as <b>reviewer-1</b>");
    expectCsrfOnEveryPost(page);
    expectNoScript(page);
  });

  it("names the spot-check queue and shows an unclassified failure case", () => {
    const failed: QueueRow = {
      ...row,
      outcome: null,
      intent: null,
      confidence: null,
      reasonCodes: ["processing_failed"],
    };
    const page = queuePage({
      viewer,
      filters: { spotCheck: true },
      total: 0,
      rows: [failed],
      skipped: [],
      nextAfter: null,
    });
    expect(page).toContain("auto-routed cases not yet spot-checked");
    expect(page).toContain("not classified");
    expect(page).toContain('name="spot_check" value="1" checked');
    expect(page).not.toContain("Start reviewing");
  });
});

describe("emptyQueuePage", () => {
  it("says the queue is empty and links back with the filters", () => {
    const page = emptyQueuePage({ viewer, filters: { reason: "complaint", spotCheck: false } });
    expect(page).toContain("<h1>No cases to review</h1>");
    expect(page).toContain('href="/review?reason=complaint"');
  });
});

describe("casePage", () => {
  it("shows every section, with the position and the masked text", () => {
    const page = casePage({ viewer, view: view(), position: { index: 3, total: 41 }, filters: none });
    expect(page).toContain("Case 3 of 41");
    expect(page).toContain("<h1>Case msg-008</h1>");
    expect(page).toContain("<dt>Team</dt><dd>billing</dd>");
    expect(page).toContain("<li><code>crm_mismatch_unmatched_key</code>: [EMAIL_1] matched no customer</li>");
    expect(page).toContain("<dt>Intent</dt><dd>billing_question</dd>");
    expect(page).toContain("<dt>Confidence</dt><dd>0.86</dd>");
    expect(page).toContain("Customer asks why the invoice is higher.");
    expect(page).toContain('<pre class="message">Dobrý den,\nvolám z [PHONE_1], e-mail [EMAIL_1].</pre>');
    expect(page).toContain(`Customer <code>${CUSTOMER}</code> (residential), matched by [PHONE_1]`);
    expect(page).toContain("<li>internet, Fiber 300, Kolín, active</li>");
    expect(page).toContain("Not in the CRM: [EMAIL_1]");
    expect(page).toContain("Outages: none when the message arrived.");
    expect(page).toContain("<li><code>mask</code> (mask.v1) placeholders: [PHONE_1]</li>");
    expect(page).not.toContain("Raw text");
    expect(page).not.toContain("Unmasked before");
    expectCsrfOnEveryPost(page);
    expectNoScript(page);
  });

  it("has the four forms, with the filters as hidden fields and 'the intent's team' as default", () => {
    const page = casePage({ viewer, view: view(), position: null, filters: { reason: "complaint", spotCheck: true } });
    for (const action of ["confirm", "correct", "skip", "unmask"]) {
      expect(page).toContain(`action="/review/cases/case-1/${action}"`);
    }
    expect(page.match(/<input type="hidden" name="reason" value="complaint">/g)).toHaveLength(4);
    expect(page.match(/<input type="hidden" name="spot_check" value="1">/g)).toHaveLength(4);
    expect(page).toContain(`<option value="${INTENT_TEAM}" selected>the intent's team</option>`);
    expect(page).toContain('<option value="billing_question">billing_question (current)</option>');
    expect(page).toContain('<option value="billing">billing (current)</option>');
    expect(page).not.toContain("Case 1 of");
  });

  it("escapes untrusted text in the message, summary, findings, reasons and notes", () => {
    const v = view({ investigation: { ...INVESTIGATION, evidence: [{ tool: "check_outages", finding: EVIL }] } });
    v.interaction = { ...v.interaction, maskedText: `Hi ${EVIL} "quoted"` };
    v.classification = { ...v.classification!, summary: EVIL };
    v.unmaskings = [{ reviewer: "reviewer-2", reason: EVIL, unmaskedAt: T }];
    const page = casePage({
      viewer,
      view: v,
      position: null,
      filters: none,
      rawText: { text: EVIL, reviewer: "reviewer-1", at: T },
    });
    expectNoScript(page);
    expect(page).toContain("Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &quot;quoted&quot;");
    expect(page.match(/&lt;script&gt;/g)!.length).toBe(5);
  });

  it("shows the raw text only when given, with who unmasked it and when", () => {
    const page = casePage({
      viewer,
      view: view(),
      position: null,
      filters: none,
      rawText: { text: "volám z 777 123 456", reviewer: "reviewer-1", at: T },
    });
    expect(page).toContain("Raw text, unmask logged at 2026-11-17T07:30:00.000Z by reviewer-1");
    expect(page).toContain('<pre class="message">volám z 777 123 456</pre>');
    expect(casePage({ viewer, view: view(), position: null, filters: none })).not.toContain("777 123 456");
  });

  it("shows a failed form's error and keeps what was typed", () => {
    const page = casePage({
      viewer,
      view: view(),
      position: null,
      filters: none,
      error: {
        form: "correct",
        message: "A correction needs a note saying why.",
        values: { intent: "complaint", team: "general", note: "" },
      },
    });
    expect(page).toContain('<p class="notice error" role="alert">A correction needs a note saying why.</p>');
    expect(page).toContain('<option value="complaint" selected>complaint</option>');
    expect(page).toContain('<option value="general" selected>general</option>');
    expect(page).not.toContain(`<option value="${INTENT_TEAM}" selected>`);
  });

  it("shows the investigation with its tool calls", () => {
    const page = casePage({ viewer, view: view({ investigation: INVESTIGATION }), position: null, filters: none });
    expect(page).toContain("Likely cause <strong>line_fault</strong> (confidence 0.85), 2 turns, claude-opus-5-5");
    expect(page).toContain("<li><code>get_line_status</code> Mobile line down since 2026-11-04 18:00.</li>");
    expect(page).toContain(
      'turn 1: <code>get_recent_tickets</code> <code>{&quot;customer_id&quot;:&quot;someone-else&quot;}</code> <span class="tag error">error</span>',
    );
    const skipped = casePage({
      viewer,
      view: view({ investigation: { skipped: "not a technical fault" } }),
      position: null,
      filters: none,
    });
    expect(skipped).toContain("Not run (not a technical fault).");
  });

  it("says what is missing on a failure case", () => {
    const v = view({ classification: null, enrichment: null, customer: null });
    v.interaction = { ...v.interaction, maskedText: null };
    const page = casePage({ viewer, view: v, position: null, filters: none });
    expect(page).toContain("None: processing failed before classifying.");
    expect(page).toContain("Not masked: processing failed at masking. Unmask shows the raw text.");
    expect(page).toContain("Customer lookup: not run.");
    expect(page).toContain('<option value="billing_question">billing_question</option>');
  });

  it("shows the review and no forms for a reviewed case", () => {
    const review: StoredReview = {
      id: "r-1",
      caseId: "case-1",
      reviewer: "reviewer-2",
      decision: "corrected",
      correctedIntent: "complaint",
      correctedTeam: "complaints",
      note: "angry customer",
      spotCheck: false,
      reviewedAt: T,
    };
    const page = casePage({ viewer, view: view({ review }), position: null, filters: none });
    expect(page).toContain("<dt>Corrected intent</dt><dd>complaint</dd>");
    expect(page).toContain("<dt>Note</dt><dd>angry customer</dd>");
    expect(page).not.toContain("/confirm");
    expect(page).not.toContain("/unmask");
  });
});

describe("reviewedPage", () => {
  const row: ReviewedRow = {
    reviewId: "0190e9a0-0000-7000-8000-0000000000r1",
    caseId: CASE,
    externalId: "msg-010",
    reviewer: "reviewer-1",
    decision: "corrected",
    spotCheck: true,
    reviewedAt: T,
    note: EVIL,
    original: { intent: "complaint", team: "complaints" },
    effective: { status: "corrected", intent: "complaint", team: "billing" },
  };

  it("lists reviews with the effective and original decision, escapes notes and links older ones", () => {
    const page = reviewedPage({ viewer, filters: { reviewer: "reviewer-1" }, rows: [row], nextBefore: row.reviewId });
    expect(page).toContain(`<a href="/review/cases/${CASE}">msg-010</a>`);
    expect(page).toContain('corrected <span class="tag">spot check</span>');
    expect(page).toContain('complaint → billing<br><span class="muted">was complaint → complaints</span>');
    expect(page).toContain(`href="/review/reviewed?reviewer=reviewer-1&amp;before=${row.reviewId}">Older`);
    expectNoScript(page);
  });

  it("says when there is nothing", () => {
    expect(reviewedPage({ viewer, filters: { decision: "confirmed" }, rows: [], nextBefore: null })).toContain(
      "No reviews with these filters yet.",
    );
  });
});

describe("STYLESHEET", () => {
  it("is plain CSS with no imports or remote URLs", () => {
    expect(STYLESHEET).not.toMatch(/@import|url\(/);
  });
});
