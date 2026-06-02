import { z } from "zod";
import type { ExtensionMcpToolServer } from "@cinatra-ai/sdk-extensions";
import { createApolloPrimitiveHandlers, validateKeySchema, runExecutionJobSchema, runOptimizationJobSchema, peopleSearchSchema } from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "apollo_status": {
    description: "Get the current Apollo API connector connection status.",
    inputSchema: z.object({}),
  },
  "apollo_administration_get": {
    description: "Get Apollo API administration including connection state and feature availability.",
    inputSchema: z.object({}),
  },
  "apollo_administration_logging": {
    description: "Get Apollo API logging settings.",
    inputSchema: z.object({}),
  },
  "apollo_validate": {
    description: "Validate an Apollo API key. Uses the stored key if none is provided.",
    inputSchema: validateKeySchema,
  },
  "apollo_people_search": {
    description: "Contact enrichment and email lookup via Apollo. Search for people at a company by domain or name and get back verified emails, names, titles, and LinkedIn URLs — without saving to the workspace. Use this as the enrichment step in any workflow that needs to find or verify professional email addresses for a list of contacts. organizationDomains accepts full URLs (e.g. [\"https://example.com\"]) OR bare domains (e.g. [\"example.com\"]) — the tool normalizes them automatically, so you can pass the same targetWebsite URL used for scraping. organizationName is optional when organizationDomains is provided. Optionally add personTitles (e.g. [\"CEO\", \"CTO\"]) to narrow results.",
    inputSchema: peopleSearchSchema,
  },
  "apollo_jobs_execution_run": {
    description: "Worker: execute a queued Ross Index import job.",
    inputSchema: runExecutionJobSchema,
  },
  "apollo_jobs_optimization_run": {
    description: "Worker: execute a queued Ross Index optimization job.",
    inputSchema: runOptimizationJobSchema,
  },
};

export function registerApolloPrimitives(server: ExtensionMcpToolServer) {
  const handlers = createApolloPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      async (input) => {
        const result = await handler({
          primitiveName: name,
          input,
          actor: { actorType: "model", source: "agent" },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result) ? { items: result } : typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result },
        };
      },
    );
  }
}
