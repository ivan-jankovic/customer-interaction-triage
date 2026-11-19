// The intake API (P02). buildApp takes its dependencies as arguments, so unit tests run it
// with an in-memory store through fastify.inject, and server.ts wires in PostgreSQL.

import { createHash, timingSafeEqual } from "node:crypto";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import { Ajv, type ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Interaction, InteractionStore } from "../db/interactions.js";
import {
  BODY_LIMIT_BYTES,
  createInteractionBody,
  errorResponse,
  interactionParams,
  interactionResponse,
  listQuery,
  listResponse,
} from "./schemas.js";

// ajv-formats is CommonJS; under NodeNext its default import is the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

/** The response shape: the stored interaction with ISO 8601 timestamps. */
function toJson(i: Interaction) {
  return { ...i, received_at: i.received_at.toISOString(), created_at: i.created_at.toISOString() };
}

export interface AppOptions {
  store: InteractionStore;
  apiKey: string;
  /** Resolves when the database answers; used by GET /health. */
  checkDb: () => Promise<void>;
  /**
   * Queues a stored interaction for processing (P08); never throws. Best effort: when it fails
   * (Redis down), the request still succeeds and the worker's sweep enqueues the message later.
   */
  enqueue: (interactionId: string) => Promise<"queued" | "failed">;
  logger?: FastifyServerOptions["logger"];
}

/**
 * Fastify's default Ajv setup removes unknown properties silently and coerces types
 * ("123" → 123, ["chat"] → "chat"). The API rejects both in bodies instead (requirements.md,
 * "Request validation"). Query strings and path parameters are always text, so they keep
 * coercion, which turns ?limit=10 into a number.
 */
function makeAjv(coerceTypes: boolean): Ajv {
  const ajv = new Ajv({ removeAdditional: false, coerceTypes, useDefaults: true, allErrors: false, strict: true });
  addFormats(ajv);
  return ajv;
}
const bodyAjv = makeAjv(false);
const textAjv = makeAjv(true);

/** "body/text must match pattern", plus the property name Ajv keeps in params for unknown fields. */
function formatSchemaErrors(errors: ErrorObject[], dataVar: string): Error {
  const parts = errors.map((e) => {
    const extra = e.keyword === "additionalProperties" ? ` '${String(e.params.additionalProperty)}'` : "";
    return `${dataVar}${e.instancePath} ${e.message ?? "is invalid"}${extra}`;
  });
  return new Error(parts.join(", "));
}

/** Constant-time comparison; hashing first gives both sides the same length. */
function sameKey(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function buildApp({ store, apiKey, checkDb, enqueue, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES }).withTypeProvider<JsonSchemaToTsProvider>();

  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === "body" ? bodyAjv : textAjv).compile(schema));
  app.setSchemaErrorFormatter((errors, dataVar) => formatSchemaErrors(errors, dataVar));

  // Server errors get a generic message: a database error text must not reach the caller.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: "Internal error." });
    }
    return reply.code(statusCode).send({
      statusCode,
      error: statusCode === 413 ? "Payload Too Large" : statusCode === 400 ? "Bad Request" : "Error",
      message: error.message,
    });
  });

  app.get("/health", async (request, reply) => {
    try {
      await checkDb();
      return { status: "ok" };
    } catch (error) {
      request.log.warn({ err: error }, "health check: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  // Every /interactions route needs the key. The hook runs on request, before the body is
  // read or validated, so a caller without the key learns nothing about the input rules.
  void app.register((plugin, _opts, done) => {
    // An encapsulated scope starts without the type provider, so it is applied again.
    const scope = plugin.withTypeProvider<JsonSchemaToTsProvider>();
    scope.addHook("onRequest", async (request, reply) => {
      const given = request.headers["x-api-key"];
      if (typeof given !== "string" || !sameKey(given, apiKey)) {
        return reply.code(401).send({ statusCode: 401, error: "Unauthorized", message: "Missing or invalid API key." });
      }
    });

    scope.post(
      "/interactions",
      {
        schema: {
          body: createInteractionBody,
          response: { 200: interactionResponse, 201: interactionResponse, 409: errorResponse },
        },
      },
      async (request, reply) => {
        const body = request.body;
        const result = await store.create({
          external_id: body.external_id ?? null,
          channel: body.channel,
          language: body.language ?? null,
          text: body.text,
          received_at: body.received_at ? new Date(body.received_at) : null,
        });
        // A repeat (`existing`) is enqueued too: if the first request's enqueue failed, this one
        // may succeed, and BullMQ ignores the duplicate job ID otherwise.
        if (result.kind !== "conflict") {
          const id = result.interaction.id;
          if ((await enqueue(id)) === "failed") {
            request.log.warn({ interactionId: id }, "enqueue failed; the sweep will pick the interaction up");
          }
        }
        switch (result.kind) {
          case "created":
            return reply
              .code(201)
              .header("location", `/interactions/${result.interaction.id}`)
              .send(toJson(result.interaction));
          case "existing":
            return reply.code(200).send(toJson(result.interaction));
          case "conflict":
            return reply.code(409).send({
              statusCode: 409,
              error: "Conflict",
              message: `external_id "${result.existing.external_id}" is already stored with different content.`,
            });
        }
      },
    );

    scope.get(
      "/interactions/:id",
      { schema: { params: interactionParams, response: { 200: interactionResponse, 404: errorResponse } } },
      async (request, reply) => {
        const interaction = await store.getById(request.params.id);
        if (!interaction) {
          return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "No such interaction." });
        }
        return toJson(interaction);
      },
    );

    scope.get(
      "/interactions",
      { schema: { querystring: listQuery, response: { 200: listResponse } } },
      async (request) => {
        const limit = request.query.limit ?? 20;
        const items = await store.list({ limit, before: request.query.before });
        // A full page may be followed by more; an empty next page is the cheap way to find out.
        return {
          items: items.map(toJson),
          next_before: items.length === limit ? items[items.length - 1]!.id : null,
        };
      },
    );

    done();
  });

  return app;
}
