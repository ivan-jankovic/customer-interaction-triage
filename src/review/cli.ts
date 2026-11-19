// npm run review -- [--reviewer <handle>] [--team <team>] [--reason <code>] [--spot-check]
//
// The interactive review loop (P09 requirements.md, "The review loop"): shows the oldest
// unreviewed case, masked, and asks for an action: confirm, correct (intent and team, with a
// note), skip (for this session), unmask (needs a reason; logged before the raw text is shown)
// or quit. Free: no model is called.
//
// Input is read line by line from the injected stream, so the loop works with piped input as well
// as a terminal, and tests drive it with scripted lines. End of input counts as quit.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { loadDatabaseUrl } from "../config.js";
import { createDb, type Database } from "../db/database.js";
import { schemaBehindMessage } from "../db/migrate.js";
import { INTENTS, REASON_CODES, TEAMS, type Intent, type ReasonCode, type Team } from "../taxonomy.js";
import { confirmCase, correctCase, InvalidReview, unmaskCase, type ReviewResult } from "./actions.js";
import { readCaseView } from "./case-view.js";
import { nextCase, queueSize, type QueueFilters } from "./queue.js";
import { defaultTeamFor, parseReviewer } from "./rules.js";
import { ACTION_PROMPT, intentMenu, pick, renderCase, teamMenu } from "./screen.js";

export interface ReviewCliDeps {
  db: Kysely<Database>;
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const USAGE =
  "Usage: npm run review -- [--reviewer <handle>] [--team <team>] [--reason <reason code>] [--spot-check]\n" +
  "The reviewer can also come from REVIEWER in .env.";

/** Reads one line per call; null at end of input. */
function lineReader(input: NodeJS.ReadableStream) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async next(): Promise<string | null> {
      const r = await lines.next();
      return r.done ? null : r.value;
    },
    close: () => rl.close(),
  };
}

/** Returns the exit code: 0 after a session, 1 when the database is behind the code, 2 for usage errors. */
export async function runReview(argv: string[], deps: ReviewCliDeps): Promise<number> {
  const write = (text: string) => void deps.output.write(text);
  const say = (line = "") => write(`${line}\n`);

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        reviewer: { type: "string" },
        team: { type: "string" },
        reason: { type: "string" },
        "spot-check": { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    say(USAGE);
    return 2;
  }
  const reviewer = parseReviewer(values.reviewer ?? deps.env.REVIEWER);
  if (!reviewer.ok) {
    say(reviewer.error);
    say(USAGE);
    return 2;
  }
  if (values.team && !(TEAMS as readonly string[]).includes(values.team)) {
    say(`--team must be one of ${TEAMS.join(", ")}.`);
    return 2;
  }
  if (values.reason && !(REASON_CODES as readonly string[]).includes(values.reason)) {
    say(`--reason must be one of ${REASON_CODES.join(", ")}.`);
    return 2;
  }

  // Before anything else reads a table this phase added.
  const behind = await schemaBehindMessage(deps.db);
  if (behind) {
    say(behind);
    return 1;
  }

  const who = reviewer.value;
  const skipped: string[] = [];
  const filters = (): QueueFilters => ({
    spotCheck: values["spot-check"],
    team: values.team as Team | undefined,
    reason: values.reason as ReasonCode | undefined,
    exclude: skipped,
  });
  const counts = { confirmed: 0, corrected: 0, skipped: 0, unmasked: 0 };
  let handled = 0;
  const reader = lineReader(deps.input);
  const ask = async (prompt: string): Promise<string | null> => {
    write(prompt);
    const line = await reader.next();
    if (line === null) write("\n");
    return line;
  };

  const report = (r: ReviewResult, what: string) => {
    if (r.stored) say(`${what} by ${who}.`);
    else say(`Already reviewed by ${r.existing.reviewer} at ${r.existing.reviewedAt.toISOString()}; moving on.`);
  };

  say(`Reviewing as ${who}${values["spot-check"] ? " (spot checks: auto-routed cases)" : ""}.`);
  session: for (;;) {
    const caseId = await nextCase(deps.db, filters());
    if (!caseId) {
      say(handled === 0 ? "No cases to review." : "No more cases to review.");
      break;
    }
    const view = await readCaseView(deps.db, caseId);
    const total = handled + (await queueSize(deps.db, filters()));
    say();
    for (const line of renderCase(view, { index: handled + 1, total })) say(line);
    const caseIntent: Intent | null = view.classification?.intent ?? null;
    const caseTeam = view.case.targetTeam;

    for (;;) {
      say();
      const action = await ask(ACTION_PROMPT);
      if (action === null) break session;
      const a = action.trim().toLowerCase();

      if (a === "q") break session;

      if (a === "s") {
        skipped.push(caseId);
        counts.skipped++;
        handled++;
        continue session;
      }

      if (a === "c") {
        const note = await ask("Note (optional): ");
        if (note === null) break session;
        try {
          const r = await confirmCase(deps.db, caseId, { reviewer: who, note });
          report(r, "Confirmed");
          if (r.stored) counts.confirmed++;
          handled++;
          continue session;
        } catch (error) {
          if (!(error instanceof InvalidReview)) throw error;
          say(error.message);
          continue;
        }
      }

      if (a === "r") {
        for (const line of intentMenu(caseIntent)) say(line);
        let intent: Intent | null = null;
        for (;;) {
          const answer = await ask(`Intent [1-${INTENTS.length}, Enter to cancel]: `);
          if (answer === null) break session;
          if (answer.trim() === "") break;
          intent = pick(INTENTS, answer);
          if (intent) break;
          say("Pick a number from the list.");
        }
        if (!intent) continue;

        const suggested = defaultTeamFor(intent);
        for (const line of teamMenu(caseTeam, suggested)) say(line);
        let team: Team | null;
        for (;;) {
          const answer = await ask(`Team [1-${TEAMS.length}, Enter for ${suggested}]: `);
          if (answer === null) break session;
          team = answer.trim() === "" ? suggested : pick(TEAMS, answer);
          if (team) break;
          say("Pick a number from the list.");
        }

        for (;;) {
          const note = await ask("Note (required: why is it corrected?): ");
          if (note === null) break session;
          try {
            const r = await correctCase(deps.db, caseId, { reviewer: who, intent, team, note });
            report(r, `Corrected to ${intent} / ${team}`);
            if (r.stored) counts.corrected++;
            handled++;
            continue session;
          } catch (error) {
            if (!(error instanceof InvalidReview)) throw error;
            say(error.message);
            // A missing note can be fixed here; anything else goes back to the action prompt.
            if (!/note/.test(error.message)) break;
          }
        }
        continue;
      }

      if (a === "u") {
        for (;;) {
          const reason = await ask("Reason for viewing the raw text (required, Enter to cancel): ");
          if (reason === null) break session;
          if (reason.trim() === "") break;
          try {
            const raw = await unmaskCase(deps.db, caseId, { reviewer: who, reason });
            counts.unmasked++;
            say(`Raw message (unmasked by ${who}; logged):`);
            for (const line of raw.split(/\r?\n/)) say(`  ${line}`);
            break;
          } catch (error) {
            if (!(error instanceof InvalidReview)) throw error;
            say(error.message);
          }
        }
        continue;
      }

      say("Unknown action. Type c, r, s, u or q.");
    }
  }

  reader.close();
  say(
    `Session: ${counts.confirmed} confirmed, ${counts.corrected} corrected, ${counts.skipped} skipped, ${counts.unmasked} unmasked.`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(loadDatabaseUrl());
  runReview(process.argv.slice(2), { db, env: process.env, input: process.stdin, output: process.stdout })
    .then(
      (code) => (process.exitCode = code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    )
    .finally(() => void db.destroy());
}
