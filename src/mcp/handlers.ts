import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
import {
  getApolloAPIStatus,
  getApolloAPISettings,
  validateApolloAPIKey,
  getApolloLoggingSettings,
  searchApolloPeople,
} from "../index";

/**
 * `ExtensionPrimitiveRequest.actor` is typed `unknown` (the SDK does not
 * enumerate the host actor shape). The Apollo people-search handler derives an
 * agent label from the actor's `label`/`source` for usage attribution, so narrow
 * the `unknown` defensively here instead of indexing it directly.
 */
function deriveAgentLabel(actor: unknown): string | null {
  if (actor && typeof actor === "object") {
    const record = actor as Record<string, unknown>;
    if (typeof record.label === "string") {
      return record.label;
    }
    if (typeof record.source === "string") {
      return record.source;
    }
  }
  return null;
}

export const validateKeySchema = z.object({
  apiKey: z.string().optional(),
});

export const peopleSearchSchema = z.object({
  organizationDomains: z.array(z.string()).optional(),
  organizationName: z.string().optional(),
  personTitles: z.array(z.string()).optional(),
  personLocations: z.array(z.string()).optional(),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(25).optional(),
});

export function createApolloPrimitiveHandlers() {
  return {
    "apollo_status": async (_request: ExtensionPrimitiveRequest<unknown>) => {
      return getApolloAPIStatus();
    },

    "apollo_administration_get": async (_request: ExtensionPrimitiveRequest<unknown>) => {
      // `connected` must mirror what `getApolloAPIStatus()` says — the
      // ground truth the connector UI reads. Connector setups via Nango
      // do NOT populate `settings.apiKey` (the API key lives inside
      // Nango), so the prior check missed every Nango-configured
      // operator. Live regression: chat-dispatched
      // `@cinatra-ai/apollo-prospecting-agent` bailed at SKILL.md Step 1
      // with `{name:"apollo", error:"not_connected"}` even though the
      // `/connectors/cinatra-ai/apollo-connector/setup` page showed
      // "Connected as Cinatra User" because the agent's connectivity
      // pre-check called this handler.
      const status = getApolloAPIStatus();
      const settings = getApolloAPISettings();
      return {
        connected: status.status === "connected",
        lastValidatedAt: settings.lastValidatedAt,
        peopleSearchAvailable: settings.peopleSearchAvailable,
        loggingEnabled: settings.loggingEnabled,
      };
    },

    "apollo_administration_logging": async (_request: ExtensionPrimitiveRequest<unknown>) => {
      return getApolloLoggingSettings();
    },

    "apollo_validate": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { apiKey } = validateKeySchema.parse(request.input);
      await validateApolloAPIKey(apiKey);
      return { ok: true };
    },

    "apollo_people_search": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = peopleSearchSchema.parse(request.input);
      const agentLabel = deriveAgentLabel(request.actor);
      return searchApolloPeople({ ...input, agentLabel });
    },
  } as const;
}
