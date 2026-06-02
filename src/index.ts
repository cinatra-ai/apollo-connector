import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { APOLLO_API_LOG_DIRECTORY } from "./log-directory";
import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import {
  getExtensionConnectorConfig,
  setExtensionConnectorConfig,
} from "@cinatra-ai/sdk-extensions";
// Host-coupled services (Nango connection-storage, usage-metric emission) are
// reached via injected deps `getApolloDeps().nango.*` / `.emitUsage(...)`. Boot
// wires concrete impls via registerApolloConnector(deps). Connector-config is
// read/written through the SDK's GENERIC accessor (no per-connector host
// binding). The connector carries no non-SDK `@cinatra-ai/*` code dependency.
import { getApolloDeps } from "./deps";

const APOLLO_PACKAGE_ID = "@cinatra-ai/apollo-connector";
const APOLLO_CONFIG_KEY = "apollo";

export type ApolloAPISettings = {
  apiKey?: string;
  lastValidatedAt?: string;
  peopleSearchAvailable?: boolean;
  peopleSearchCheckedAt?: string;
  peopleSearchDetail?: string;
  loggingEnabled?: boolean;
};

export { APOLLO_API_LOG_DIRECTORY } from "./log-directory";

export const apolloAPIConnectionPackage: HostRequiredPackageDefinition = {
  packageId: "@cinatra-ai/apollo-connector",
  name: "Apollo API Connection",
  slug: "connector-apollo",
  description: "Optional API connection for enriching Ross Index companies and founders with Apollo data.",
  settingsHref: "/configuration/llm/apollo",
};

function readSettings() {
  return getExtensionConnectorConfig<ApolloAPISettings>(APOLLO_PACKAGE_ID, APOLLO_CONFIG_KEY, {});
}

function writeSettings(value: ApolloAPISettings) {
  setExtensionConnectorConfig(APOLLO_PACKAGE_ID, APOLLO_CONFIG_KEY, value);
}

function sanitizeLogLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "apollo-call"
  );
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isApolloLoggingEnabled() {
  return readSettings().loggingEnabled !== false;
}

function parseJsonResponseBody<T>(rawBody: string) {
  const candidates = [
    rawBody.trim(),
    rawBody.includes("\n") ? rawBody.split("\n").map((line) => line.trim()).find(Boolean) : undefined,
    rawBody.includes("{") && rawBody.includes("}")
      ? rawBody.slice(rawBody.indexOf("{"), rawBody.lastIndexOf("}") + 1).trim()
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

async function writeApolloLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isApolloLoggingEnabled()) {
    return;
  }

  await mkdir(APOLLO_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const content = typeof input.body === "string" ? { raw: input.body } : input.body;
  await writeFile(path.join(APOLLO_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");
}

export function getApolloAPISettings() {
  return readSettings();
}

export async function getConfiguredApolloAPIKey(opts?: { forceRefresh?: boolean }) {
  const { nango } = getApolloDeps();
  if (!nango.isConfigured()) {
    return null;
  }

  // Require a verified saved pointer. The cinatra-side connection record is
  // written (saveApolloConnectionPointer) ONLY after the credential is both
  // persisted (readback-verified) AND accepted by Apollo (live /v1/auth/health).
  // Reading credentials off the deterministic provider/connection ids WITHOUT a
  // saved pointer would let a failed/aborted save leave an old or unverified key
  // reachable by searchApolloPeople — so bail out when no pointer exists, and
  // read ONLY the saved provider/connection (no deterministic fallback).
  const savedConnection = nango.getPrimarySavedConnection("apollo");
  if (!savedConnection) {
    return null;
  }

  const credentials = await nango.getCredentials(
    savedConnection.providerConfigKey,
    savedConnection.connectionId,
    opts,
  );

  return credentials && typeof credentials === "object" && "apiKey" in credentials && typeof credentials.apiKey === "string"
    ? credentials.apiKey
    : null;
}

export function getApolloLoggingSettings() {
  const settings = readSettings();
  return {
    enabled: settings.loggingEnabled !== false,
    directory: APOLLO_API_LOG_DIRECTORY,
  };
}

export function getApolloAPIStatus() {
  const settings = readSettings();
  const savedConnection = getApolloDeps().nango.getPrimarySavedConnection("apollo");

  if (savedConnection) {
    return {
      status: "connected" as const,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  if (settings.apiKey && settings.lastValidatedAt && settings.peopleSearchAvailable === false) {
    return {
      status: "incomplete" as const,
      detail: "Save the Apollo API key again to finish setup.",
    };
  }

  if (settings.apiKey) {
    return {
      status: "incomplete" as const,
      detail: "Save and validate the Apollo API key to enable Ross Index enrichment.",
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Add an Apollo API key to enable optional Ross Index enrichment.",
  };
}

export async function validateApolloAPIKey(apiKey?: string, opts?: { forceRefresh?: boolean }) {
  const resolvedApiKey = apiKey?.trim() || (await getConfiguredApolloAPIKey(opts));
  if (!resolvedApiKey) {
    throw new Error("Apollo is not connected.");
  }

  await writeApolloLogFile({
    label: "apollo-auth-health",
    kind: "request",
    body: {
      endpoint: "https://api.apollo.io/v1/auth/health",
      method: "GET",
    },
  });
  const response = await fetch("https://api.apollo.io/v1/auth/health", {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": resolvedApiKey,
    },
    cache: "no-store",
  });

  const rawBody = await response.text();
  await writeApolloLogFile({
    label: "apollo-auth-health",
    kind: "response",
    body: rawBody,
  });

  const payload = parseJsonResponseBody<{ message?: string; error?: string }>(rawBody);

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? "Unable to validate the Apollo API key.");
  }
}

async function probeApolloPeopleSearch(apiKey?: string) {
  const resolvedApiKey = apiKey?.trim() || (await getConfiguredApolloAPIKey());
  if (!resolvedApiKey) {
    throw new Error("Apollo is not connected.");
  }

  const requestBody = {
    q_organization_domains_list: ["example.com"],
    person_titles: ["Founder"],
    page: 1,
    per_page: 1,
  };
  await writeApolloLogFile({
    label: "apollo-people-api-search-probe",
    kind: "request",
    body: {
      endpoint: "https://api.apollo.io/api/v1/mixed_people/api_search",
      method: "POST",
      body: requestBody,
    },
  });
  const response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": resolvedApiKey,
    },
    body: JSON.stringify(requestBody),
    cache: "no-store",
  });

  const rawBody = await response.text();
  await writeApolloLogFile({
    label: "apollo-people-api-search-probe",
    kind: "response",
    body: rawBody,
  });

  if (response.ok) {
    return {
      available: true,
      detail: "Apollo People API Search is available for this API key.",
    };
  }

  const payload = parseJsonResponseBody<{ message?: string; error?: string }>(rawBody);
  const detail = payload?.message ?? payload?.error ?? "Apollo People API Search is not available for this API key.";
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("free plan") ||
    normalized.includes("not accessible with this api_key") ||
    normalized.includes("upgrade your plan") ||
    normalized.includes("people api search")
  ) {
    return {
      available: false,
      detail,
    };
  }

  throw new Error(detail);
}

export async function saveApolloAPISettings(input: { apiKey?: string; loggingEnabled?: boolean }) {
  const current = readSettings();
  const apiKey = input.apiKey?.trim() || current.apiKey;

  if (!apiKey) {
    throw new Error("Enter an Apollo API key to continue.");
  }

  if (!getApolloDeps().nango.isConfigured()) {
    throw new Error("Configure the connection service first so Apollo API requests can authenticate.");
  }

  // 1. Validate the SUBMITTED key against Apollo BEFORE touching Nango — using
  //    the explicit key, NOT a stored credential. On a re-connect / key rotation
  //    this is critical: a bad new key throws HERE, before any import, so the
  //    currently-valid stored credential is never overwritten (no Nango write
  //    happens until the key is proven live-valid).
  await validateApolloAPIKey(apiKey);
  const peopleSearch = await probeApolloPeopleSearch(apiKey);
  // 2. Key is live-valid → persist it into Nango and verify the round-trip
  //    (import WITHOUT connectorKey → forceRefresh readback → compare).
  await syncApolloAPISettingsToNango({ apiKey });
  // 3. Persist the cinatra-side pointer LAST. getConfiguredApolloAPIKey requires
  //    it, so any failure above leaves Apollo reporting its PRIOR state: a failed
  //    rotation keeps the old valid connection (Nango untouched); a failed
  //    first-time save stays not-connected.
  await saveApolloConnectionPointer();
  const nextSettings: ApolloAPISettings = {
    apiKey: undefined,
    lastValidatedAt: new Date().toISOString(),
    peopleSearchAvailable: peopleSearch.available,
    peopleSearchCheckedAt: new Date().toISOString(),
    peopleSearchDetail: peopleSearch.detail,
    loggingEnabled: input.loggingEnabled ?? current.loggingEnabled ?? true,
  };
  writeSettings(nextSettings);
  return nextSettings;
}

export async function saveApolloLoggingSettings(enabled: boolean) {
  writeSettings({
    ...readSettings(),
    loggingEnabled: enabled,
  });
}

export async function clearApolloAPISettings() {
  const current = readSettings();
  writeSettings({
    loggingEnabled: current.loggingEnabled ?? true,
  });
  const { nango } = getApolloDeps();
  const savedConnection = nango.getPrimarySavedConnection("apollo");
  await nango.deleteConnection(
    savedConnection?.providerConfigKey ?? nango.providerConfigKeys.apollo,
    savedConnection?.connectionId ?? nango.connectionIds.apollo,
  );
  await nango.clearConnectionRecords("apollo");
}

export async function syncApolloAPISettingsToNango(input: {
  apiKey: string;
}) {
  const { nango } = getApolloDeps();
  if (!nango.isConfigured()) {
    return;
  }

  const trimmedKey = input.apiKey.trim();
  const providerConfigKey = nango.providerConfigKeys.apollo;
  const connectionId = nango.connectionIds.apollo;

  await nango.ensureIntegration({
    provider: "apollo",
    providerConfigKey,
    displayName: "Cinatra Apollo",
  });

  // Verified write-then-read-back (mirrors gemini/apify):
  //   1. import WITHOUT `connectorKey` so the cinatra-side pointer is NOT
  //      auto-saved before verification.
  //   2. forceRefresh readback + compare against the SUBMITTED key — a no-op
  //      write (the previous key still stored) or a mismatch throws a generic
  //      error (no key in the message).
  // The cinatra-side pointer is saved by `saveApolloConnectionPointer()` ONLY
  // after live Apollo validation (see saveApolloAPISettings) — NOT here — so a
  // persisted-but-invalid key never leaves a connected-looking pointer.
  await nango.importConnection({
    providerConfigKey,
    connectionId,
    credentials: {
      type: "API_KEY",
      apiKey: trimmedKey,
    },
  });

  const readback = await nango.getCredentials(providerConfigKey, connectionId, {
    forceRefresh: true,
  });
  const readbackKey =
    readback && typeof readback === "object" && "apiKey" in readback && typeof readback.apiKey === "string"
      ? readback.apiKey
      : null;
  if (readbackKey !== trimmedKey) {
    throw new Error(
      "Nango credential verification failed: the readback value did not match the saved Apollo API key.",
    );
  }
}

/**
 * Persist the cinatra-side connection pointer. Called by saveApolloAPISettings
 * ONLY after the credential has been persisted (readback-verified) AND accepted
 * by Apollo (live /v1/auth/health). `getConfiguredApolloAPIKey` requires this
 * pointer, so until it runs no credential is reachable — a verification or
 * validation failure leaves Apollo reporting not-connected.
 */
async function saveApolloConnectionPointer() {
  const { nango } = getApolloDeps();
  await nango.saveConnectionRecord(
    "apollo",
    {
      connectionId: nango.connectionIds.apollo,
      providerConfigKey: nango.providerConfigKeys.apollo,
      metadata: {},
    },
    { multiple: false },
  );
}

/**
 * Search Apollo People API for contacts at a company.
 * Returns results directly without saving to the workspace database.
 */
export async function searchApolloPeople(input: {
  organizationDomains?: string[];
  organizationName?: string;
  personTitles?: string[];
  personLocations?: string[];
  page?: number;
  perPage?: number;
  agentLabel?: string | null;
}) {
  const apiKey = await getConfiguredApolloAPIKey();
  if (!apiKey) {
    throw new Error("Apollo is not connected. Add an API key in LLM > Apollo.");
  }

  const settings = readSettings();
  if (settings.peopleSearchAvailable === false) {
    throw new Error("Apollo People API Search is not available for this API key. Upgrade your Apollo plan.");
  }

  const requestBody: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 10, 25),
  };

  if (input.organizationDomains?.length) {
    // Normalize: accept full URLs or bare domains — strip protocol and path.
    requestBody.q_organization_domains_list = input.organizationDomains.map((d) => {
      try {
        return new URL(d.includes("://") ? d : `https://${d}`).hostname.replace(/^www\./, "");
      } catch {
        return d;
      }
    });
  }
  if (input.organizationName) {
    requestBody.q_organization_name = input.organizationName;
  }
  if (input.personTitles?.length) {
    requestBody.person_titles = input.personTitles;
  }
  if (input.personLocations?.length) {
    requestBody.person_locations = input.personLocations;
  }

  await writeApolloLogFile({
    label: "apollo-people-search",
    kind: "request",
    body: requestBody,
  });

  const response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(requestBody),
    cache: "no-store",
  });

  const rawBody = await response.text();
  await writeApolloLogFile({
    label: "apollo-people-search",
    kind: "response",
    body: rawBody,
  });

  if (!response.ok) {
    const payload = parseJsonResponseBody<{ message?: string; error?: string }>(rawBody);
    throw new Error(payload?.message ?? payload?.error ?? "Apollo People API search failed.");
  }

  const payload = parseJsonResponseBody<{
    people?: Array<{
      id?: string;
      first_name?: string;
      last_name?: string;
      name?: string;
      title?: string;
      email?: string;
      email_status?: string;
      linkedin_url?: string;
      city?: string;
      state?: string;
      country?: string;
      organization?: {
        name?: string;
        website_url?: string;
        estimated_num_employees?: number;
        industry?: string;
      };
    }>;
    pagination?: {
      page?: number;
      per_page?: number;
      total_entries?: number;
      total_pages?: number;
    };
  }>(rawBody);

  const people = (payload?.people ?? []).map((person) => ({
    id: person.id,
    name: person.name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim(),
    title: person.title,
    email: person.email,
    emailStatus: person.email_status,
    linkedinUrl: person.linkedin_url,
    location: [person.city, person.state, person.country].filter(Boolean).join(", "),
    company: person.organization?.name,
    companyDomain: person.organization?.website_url,
    companySize: person.organization?.estimated_num_employees,
    industry: person.organization?.industry,
  }));

  // Emit usage event — api_search does not consume credits (requestCount only)
  getApolloDeps().emitUsage({
    source: "apollo",
    operation: "people_search",
    agentLabel: input.agentLabel ?? null,
    requestCount: 1,
    resultCount: payload?.pagination?.total_entries ?? people.length,
    creditsConsumed: 0,
    idempotencyKey: randomUUID(),
    occurredAt: new Date().toISOString(),
  });

  return {
    people,
    pagination: payload?.pagination ?? { page: 1, total_entries: people.length },
  };
}


// Connector registration exports expose the dependency-injection entry point.
export { registerApolloConnector } from "./deps";
export type { ApolloConnectorDeps } from "./deps";
