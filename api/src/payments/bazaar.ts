/**
 * Bazaar discovery metadata for the create-session route.
 *
 * The CDP x402 Bazaar indexes a resource only when its 402 advertises an
 * `extensions.bazaar` block, and an agent can construct a call only when that
 * block carries a complete input schema and a worked example. A route without
 * one is either absent from the catalogue or listed and unusable, which reads
 * the same to a buyer: no call.
 *
 * Three constraints come from the Bazaar itself:
 *
 *  - Metadata is screened for prompt injection before listing. Every string
 *    here names a field; none of them instructs an agent to do anything.
 *  - The indexer posts `info.input` at the route, so the example must be a body
 *    this API accepts, or discovery stops at its own schema check.
 *  - Prices come from the tier table rather than from a literal, so the copy an
 *    agent reads cannot drift from the price it is charged.
 */
import type { TierTable } from "@x402s/shared/payment";
import type { SessionLimits } from "@x402s/shared/protocol";

/** A worked example of the body the create route accepts. */
interface BazaarExample {
  tier: string;
  runtime?: string;
  clientPublicKey: string;
  clientNonce: string;
}

export interface BazaarOptions {
  tiers: TierTable;
  /** The tier the example quotes, and the one discovery ranks first. */
  exampleTier: string;
  runtime: string;
  limits: SessionLimits;
}

/**
 * The example client key and nonce.
 *
 * Both fields are required by the route schema, so the example needs values of
 * the right shape. They are a shape, not a credential: 32 zero bytes in base64,
 * which no client should reuse and which the example's own description says is
 * generated per call.
 */
const EXAMPLE_PUBLIC_KEY = "A".repeat(43) + "=";
const EXAMPLE_NONCE = "A".repeat(43) + "=";

/** The 201 body, as an agent sees it after a settled call. */
function outputExample(
  tier: string,
  leaseSeconds: number,
  runtime: string,
  limit: SessionLimits,
): Record<string, unknown> {
  return {
    sessionId: "sbx_01j0example0000000000000000",
    capability: "eyJhbGciOiJFZERTQSJ9.example",
    state: "PAID",
    tier,
    durationSeconds: leaseSeconds,
    limits: limit,
    runtime,
    capabilityExpiresAt: "2026-01-01T00:00:15.000Z",
  };
}

/** One sentence per tier, with the price and lease attached to it. */
function tierDescription(definition: TierTable[keyof TierTable]): string {
  return (
    `${definition.priceUsd} for ${definition.durationSeconds} seconds of one Linux machine ` +
    `(${definition.cpuMillis} millicores, ${definition.memoryMiB} MiB memory, ` +
    `${definition.diskMiB} MiB workspace).`
  );
}

/**
 * Build the `extensions.bazaar` payload for a 402.
 *
 * Shaped to the extension the Bazaar validator accepts: `info` is the example
 * the indexer replays, `schema` is what an agent reads before it builds a call.
 * Both are generated from the live tier table.
 */
export function sessionBazaarExtension(options: BazaarOptions): Record<string, unknown> {
  const exampleDefinition = options.tiers[options.exampleTier as keyof TierTable];
  if (!exampleDefinition) {
    throw new Error(
      `bazaar example tier ${options.exampleTier} is not in the tier table (${Object.keys(options.tiers).join(", ")})`,
    );
  }

  const example: BazaarExample = {
    tier: options.exampleTier,
    clientPublicKey: EXAMPLE_PUBLIC_KEY,
    clientNonce: EXAMPLE_NONCE,
  };

  return {
    bazaar: {
      info: {
        input: { type: "http", method: "POST", bodyType: "json", body: example },
        output: {
          type: "json",
          example: outputExample(
            options.exampleTier,
            exampleDefinition.durationSeconds,
            options.runtime,
            options.limits,
          ),
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["input"],
        properties: {
          input: inputSchema(options),
          output: outputSchema(),
        },
      },
    },
  };
}

/**
 * The envelope an agent reads before it builds a call.
 *
 * The shape is fixed by the extension (type, method, bodyType, body); only the
 * body's fields are this service's. Descriptions are noun phrases on purpose:
 * the Bazaar screens metadata for text that could be read as an instruction to
 * an agent, and a listing that trips that screen is removed.
 */
function inputSchema(options: BazaarOptions): Record<string, unknown> {
  const tierCatalogue = Object.entries(options.tiers)
    .map(([name, definition]) => `${name} (${tierDescription(definition)})`)
    .join("; ");

  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "method", "bodyType", "body"],
    properties: {
      type: { const: "http", type: "string" },
      method: { enum: ["POST"], type: "string" },
      bodyType: { enum: ["json"], type: "string" },
      body: {
        type: "object",
        properties: {
          tier: {
            description: `Preset session size and lease. Known tiers: ${tierCatalogue}.`,
            type: "string",
            enum: Object.keys(options.tiers),
          },
          runtime: {
            description: `Guest runtime profile. Omit for the default (${options.runtime}).`,
            type: "string",
          },
          clientPublicKey: {
            description:
              "Base64 ed25519 public key for this session, generated by the client. The guest seals operation envelopes to it.",
            type: "string",
            minLength: 40,
            maxLength: 64,
          },
          clientNonce: {
            description:
              "Base64 32-byte nonce, unique per session. Binds the client commitment to one create.",
            type: "string",
            minLength: 40,
            maxLength: 64,
          },
        },
        required: ["clientPublicKey", "clientNonce"],
      },
    },
  };
}

/** The 201 body, described field by field, so an agent knows what it bought. */
function outputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string" },
      example: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session handle for later operations." },
          capability: { type: "string", description: "Bearer token for this session, returned once." },
          state: { type: "string", description: "Last observed session state." },
          tier: { type: "string", description: "The tier that was purchased." },
          durationSeconds: { type: "number", description: "Lease length in seconds, counted from READY." },
          limits: { type: "object", description: "Per-session caps enforced by the guest and the API." },
          capabilityExpiresAt: { type: "string", description: "ISO 8601 expiry of the capability token." },
        },
      },
    },
  };
}
