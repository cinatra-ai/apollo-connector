# Apollo

Find and verify professional contacts through Apollo, straight from your Cinatra agents. Connect Apollo once and your prospecting and discovery agents can pull verified names, titles, email addresses, and LinkedIn URLs for any company you target.

## Works with

- Cinatra agents that search for people or contacts (prospecting, company-discovery, contact-discovery)
- The Ross Index enrichment pipeline (optional — Apollo enriches company and founder records when connected)

## Capabilities

- Search Apollo for people at a target company by domain or company name
- Narrow a people search by job title or location
- Return verified email addresses and LinkedIn URLs for matched contacts
- Emit usage telemetry per search so you can track API consumption in the workspace
- Expose connection status and logging settings through the Cinatra configuration UI

---

## Purpose

The Apollo connector gives Cinatra agents access to Apollo's People API Search. When you have a company domain or name, the connector lets an agent look up founders, executives, or other contacts and return email addresses, email verification status, and LinkedIn URLs for each match — without leaving Cinatra.

Apollo integration is **optional**. Core workspace features work without it. When it is connected, it enriches company and founder records in the Ross Index with data Apollo has on file.

> **Apollo plan requirement.** In practice, the Apollo Free plan does not grant access to the People API Search endpoint. You need a paid Apollo plan to use contact search. Verify your plan's access on Apollo's plan-management page before connecting.

---

## Install

The Apollo connector is a first-party Cinatra extension. There is nothing to install separately. To enable it you only need to supply your Apollo API key in the configuration UI.

---

## Configuration

1. Open **Configuration → LLM → Apollo** (path: `/configuration/llm/apollo`) in your Cinatra workspace.
2. Paste your Apollo API key into the **API key** field.
3. Click **Save API connection**.

Cinatra validates the key against the Apollo `/v1/auth/health` endpoint and then probes the People API Search endpoint to check plan access. If the key is valid but the probe detects that People API Search is not available for your plan, the key is still saved and the connection is recorded — but contact search will not work until you upgrade to a plan that includes People API Search access.

To rotate the key later, paste the new key and save again. The old credential is replaced only after the new key passes live validation. To remove the connection entirely, click **Clear saved key**.

### Environment variables

The connector reads no custom environment variables. API log files are written to `<cwd>/data/logs/apollo-api` derived from the host process working directory. All user-facing configuration is stored through Cinatra's connector-config system (no `.env` edits required).

---

## Usage

Once connected, Apollo capabilities are available automatically to any Cinatra agent that calls the `apollo_people_search` primitive. No per-agent wiring is needed.

### Example: searching for contacts at a company

A search request accepts a company domain or name plus optional filters:

```json
{
  "organizationDomains": ["acme.com"],
  "personTitles": ["CEO", "Founder"],
  "personLocations": ["San Francisco, CA"],
  "page": 1,
  "perPage": 10
}
```

A successful response returns a list of matched people and pagination metadata:

```json
{
  "people": [
    {
      "name": "Jane Smith",
      "title": "CEO",
      "email": "jane@acme.com",
      "emailStatus": "verified",
      "linkedinUrl": "https://linkedin.com/in/janesmith",
      "company": "Acme Inc",
      "companyDomain": "https://acme.com",
      "location": "San Francisco, CA, United States"
    }
  ],
  "pagination": {
    "page": 1,
    "total_entries": 42
  }
}
```

**Inputs:**
| Field | Type | Description |
|---|---|---|
| `organizationDomains` | `string[]` | One or more company domains (bare domain or full URL — both accepted). |
| `organizationName` | `string` | Company name (use instead of or alongside domains). |
| `personTitles` | `string[]` | Filter by job title keywords. |
| `personLocations` | `string[]` | Filter by location strings. |
| `page` | `number` | Page number, default `1`. |
| `perPage` | `number` | Results per page, max `25`, default `10`. |

**Outputs:** Each person record includes `name`, `title`, `email`, `emailStatus`, `linkedinUrl`, `location`, `company`, `companyDomain`, `companySize`, and `industry` where available.

**Required credentials:** A validated Apollo API key with People API Search access, saved through the configuration UI above.

**Failure modes:**
- `Apollo is not connected. Add an API key in LLM > Apollo.` — no API key has been saved; open Configuration → LLM → Apollo.
- `Apollo People API Search is not available for this API key. Upgrade your Apollo plan.` — the saved key belongs to a plan that does not include People API Search.
- `Unable to validate the Apollo API key.` — the key was rejected by Apollo's auth endpoint; check that the key is correct and active.

---

## API contract

The connector registers the following MCP primitives through the Cinatra SDK:

| Primitive | Input | Output |
|---|---|---|
| `apollo_status` | none | `{ status, detail }` — one of `connected`, `incomplete`, or `not_connected`. |
| `apollo_administration_get` | none | `{ connected, lastValidatedAt, peopleSearchAvailable, loggingEnabled }` |
| `apollo_administration_logging` | none | Current logging settings object. |
| `apollo_validate` | `{ apiKey?: string }` | `{ ok: true }` on success, throws on failure. |
| `apollo_people_search` | See Usage above | `{ people[], pagination }` |

Two additional primitives exist in the registry (`apollo_jobs_execution_run`, `apollo_jobs_optimization_run`) but are not implemented — they throw a descriptive error because the backend they depended on is archived.

The active primitives are registered at activation via the `register(ctx)` server entry (`src/register.ts`). The connector depends on the host's `@cinatra-ai/host:connector-config` capability and the `nango-system` capability; both are resolved lazily at call time so activation order does not matter.

---

## Development

### Prerequisites

- Node.js (version matching the workspace's toolchain)
- The Cinatra host environment (`@cinatra-ai/sdk-extensions` peer dependency resolved by the host)

### Lint

```bash
npm run lint
```

ESLint is the only script defined in `package.json`. The connector ships TypeScript source directly (no separate compile step in this repo).

### Testing

Tests live in `src/__tests__/`. They are excluded from the published package (`"files"` in `package.json` lists `src` with `!src/__tests__`).

### Dependency injection

Host services (connection storage via the Nango gateway, usage-metric emission) reach the connector through `registerApolloConnector(deps)` called at host boot (`src/register.ts`). Tests swap in stubs by calling the exported `_resetApolloDepsForTests()` and re-registering. The connector carries no non-SDK `@cinatra-ai/*` code dependency.

### API logging

When API logging is enabled (the default, controlled by the `loggingEnabled` setting), each Apollo API call writes a JSON request and response file to `<cwd>/data/logs/apollo-api`. The toggle is exposed through the `apollo_administration_logging` and `apollo_administration_get` MCP primitives and surfaced in the Cinatra configuration UI.

---

## Troubleshooting

**The connector shows "Optional" or "Setup required" but you expected it to be connected.**
The save action validates the key against Apollo's auth endpoint before persisting anything. If validation fails, nothing is stored and the connector stays in its prior state. Check that the key is copied correctly and try again.

**People search returns zero results.**
Apollo's search index may not have data for the domain or name supplied. Try a broader search (drop title filters or try the company name instead of the domain).

**`apollo_people_search` throws "Apollo People API Search is not available for this API key."**
Your Apollo plan does not include the People API Search endpoint. Log in to Apollo and check your plan. If you are on a trial, verify that People API Search is enabled for the trial.

**Agents report `not_connected` but the setup page shows a connected state.**
Agents call `apollo_administration_get` during connectivity pre-checks; if that primitive returns `{connected: false}`, the agent bails with `not_connected`. Verify that the key has been saved successfully via the configuration UI.

**Logging files are not appearing.**
API logging writes to `<cwd>/data/logs/apollo-api` only when the `loggingEnabled` setting is true (the default). The setting is exposed through the `apollo_administration_get` and `apollo_administration_logging` primitives in the Cinatra configuration UI. Confirm that logging is enabled for this connector.
