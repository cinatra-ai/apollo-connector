# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**Archived primitives registered but never implemented:**
- Issue: `apollo_jobs_execution_run` and `apollo_jobs_optimization_run` are fully registered as MCP tools (with input schemas, descriptions, and tool-server registration in `src/mcp/registry.ts`) but their handlers always throw immediately — they exist only to surface a descriptive error. This is dead surface area advertised to agents.
- Files: `src/mcp/handlers.ts` (lines 103–119), `src/mcp/registry.ts` (TOOL_META entries for both)
- Impact: Agents that discover these tool names via introspection may attempt to call them, receive an opaque error, and have no recovery path. The tool descriptions ("Worker: execute a queued Ross Index import job") reference the "Ross Index" pipeline, which was archived.
- Fix approach: Remove the two handler entries from `createApolloPrimitiveHandlers()` and their corresponding `TOOL_META` entries in `src/mcp/registry.ts`. If a sentinel is needed, move it to a changelog comment, not a registered tool.

**`noImplicitAny: false` in strict-mode tsconfig:**
- Issue: `tsconfig.json` sets `"strict": true` but also `"noImplicitAny": false`, which disables one of the most impactful checks that `strict` enables. This means untyped function parameters and variables are silently `any`.
- Files: `tsconfig.json`
- Impact: Type holes can propagate through the codebase undetected; `strict` is partially cosmetic without `noImplicitAny`.
- Fix approach: Remove the `"noImplicitAny": false` override and fix any resulting type errors.

**`isApolloLoggingEnabled()` defaults to `true` but logging writes to local filesystem:**
- Issue: `isApolloLoggingEnabled()` in `src/index.ts` returns `true` when `loggingEnabled` is `undefined` (i.e., any fresh/uninitialized settings state). Logging writes JSON files containing full API request/response bodies to `data/logs/apollo-api/` via Node `fs/promises`. In a serverless or ephemeral deployment the directory creation silently fails or accumulates unbounded files.
- Files: `src/index.ts` (lines 61–63, 85–98), `src/log-directory.ts`
- Impact: Log accumulation with no rotation, eviction, or size limit. On ephemeral deployments (e.g. Vercel), filesystem writes fail silently — log entries are lost with no error surfaced to the caller.
- Fix approach: Make logging opt-in (default `false`) rather than opt-out, or add a log rotation / max-file-count limit. Surface filesystem write failures in development.

**`peopleSearchAvailable` check is stale after key rotation:**
- Issue: `searchApolloPeople` in `src/index.ts` (line 423) short-circuits with an error when `settings.peopleSearchAvailable === false`. This flag is only updated on `saveApolloAPISettings`. If a plan is upgraded externally (outside of Cinatra), the connector will continue to block `apollo_people_search` until the user manually re-saves their API key.
- Files: `src/index.ts` (lines 422–425)
- Impact: False negatives — users on upgraded Apollo plans cannot use People Search until they re-save their key even though it would now succeed.
- Fix approach: Re-probe `probeApolloPeopleSearch` when `peopleSearchAvailable === false` and update the stored flag automatically, or expose a "re-check plan" action.

## Known Bugs

**`apollo_administration_get` bug comment documents a prior regression:**
- Symptoms: The `apollo_administration_get` handler contains an inline comment documenting a live regression where the handler used to check `settings.apiKey` (which Nango-configured setups never populate) instead of delegating to `getApolloAPIStatus()`. The fix is in place, but the verbose inline comment is itself a signal that the contract between settings and status is confusing.
- Files: `src/mcp/handlers.ts` (lines 63–82)
- Trigger: Any Nango-connected Apollo setup where `settings.apiKey` is `undefined` (the normal Nango path) would have surfaced `connected: false` from this handler.
- Workaround: Fixed; no workaround needed, but the comment is a warning sign for future modifications.

## Security Considerations

**API key written to local log files:**
- Risk: `writeApolloLogFile` logs full request bodies. The `validateApolloAPIKey` request log writes the endpoint but NOT the key (header only). However, if a future developer adds key material to the request body log, it would be written to plaintext JSON files on disk.
- Files: `src/index.ts` (lines 178–185, 220–228)
- Current mitigation: The current log body for auth calls omits the `x-api-key` header value. Response bodies are also logged which could contain PII (names, email addresses, LinkedIn URLs from People Search).
- Recommendations: Explicitly document that response log bodies may contain PII. Add a redaction step or a clear warning in the log-writing utility. Consider making logging opt-in by default (see Tech Debt above).

**`globalThis` symbol as a dependency injection slot:**
- Risk: The `APOLLO_DEPS_KEY` symbol anchored on `globalThis` (`src/deps.ts` line 102–104) is a mutable global. Any code running in the same process can call `registerApolloConnector()` with substitute deps (including a malicious `nango.getCredentials` that exfiltrates the key).
- Files: `src/deps.ts` (lines 102–128)
- Current mitigation: This pattern is documented as a deliberate architectural choice shared across connectors to survive Next.js bundle segmentation.
- Recommendations: Not applicable to change here (monorepo-wide pattern), but any new code that handles the registered deps should not log or forward them externally.

**.npmrc file exists:**
- The `.npmrc` file is present at the repo root. Its contents are not read here (forbidden file). Verify it does not contain auth tokens committed to version control.
- Files: `.npmrc`

## Performance Bottlenecks

**Sequential Nango calls in `saveApolloAPISettings`:**
- Problem: The save flow calls `validateApolloAPIKey` (network), then `probeApolloPeopleSearch` (network), then `syncApolloAPISettingsToNango` (network import + network readback), then `saveApolloConnectionPointer` (network) in strict sequence. This is 4–5 round trips all gated on each other.
- Files: `src/index.ts` (lines 291–309)
- Cause: Intentional ordering constraint (validate before write). The first two calls (`validateApolloAPIKey` and `probeApolloPeopleSearch`) could run in parallel since both are read-only Apollo probes, but are sequential today.
- Improvement path: Use `Promise.all([validateApolloAPIKey(apiKey), probeApolloPeopleSearch(apiKey)])` for the two probe calls. The sequencing constraint (write after validate) is still satisfied.

**No pagination cursor / continuation token:**
- Problem: `searchApolloPeople` caps results at 25 per page (`per_page: Math.min(input.perPage ?? 10, 25)`) and pagination is purely by page number. There is no cursor-based continuation.
- Files: `src/index.ts` (lines 428–429)
- Cause: Apollo API limitation (page-number based).
- Improvement path: Not actionable without Apollo API changes, but callers should be aware they must track `page` manually.

## Fragile Areas

**`parseJsonResponseBody` heuristic JSON extraction:**
- Files: `src/index.ts` (lines 65–83)
- Why fragile: The function attempts three candidate extractions from a raw response string (trim, first non-empty line, brace-slice). If Apollo changes its response format (e.g. adds a BOM, wraps in JSONP, or returns streaming JSON), this silent fallback chain returns `null` and all error/payload reading degrades to generic messages with no diagnostic information.
- Safe modification: Always add new Apollo response-reading code paths through this function. Do not bypass it with direct `JSON.parse`. If the function returns `null` in production, the caller receives a generic error — this is intentional but hard to debug.
- Test coverage: Not directly tested — the test suite mocks `fetch` to return `"{}"` and does not exercise the heuristic candidates.

**`getApolloDeps()` throws if called before `registerApolloConnector()`:**
- Files: `src/deps.ts` (lines 114–123)
- Why fragile: Any server-side invocation of exported functions (`getApolloAPIStatus`, `searchApolloPeople`, etc.) before the host calls `registerApolloConnector()` at boot will throw a runtime error. There is no lazy initialization or graceful degradation.
- Safe modification: Always ensure `registerApolloConnector(deps)` is called before any exported function is invoked. Calling order is enforced by convention, not by the type system.
- Test coverage: Covered — `beforeEach` wires deps; `_resetApolloDepsForTests` tears down. The unhappy path (unregistered deps) is implicitly tested by the reset, but not with a dedicated test case.

**`clearApolloAPISettings` always attempts Nango delete with fallback IDs:**
- Files: `src/index.ts` (lines 320–332)
- Why fragile: If `getPrimarySavedConnection` returns `null` (e.g., during a partial setup or after a prior failed save), the delete falls back to `nango.providerConfigKeys.apollo` and `nango.connectionIds.apollo`. This may attempt to delete a connection that does not exist, and the result depends on whether the Nango implementation tolerates a not-found delete silently.
- Safe modification: Confirm that the injected `nango.deleteConnection` implementation is tolerant of missing connections before relying on this fallback.
- Test coverage: Not tested in the current test suite (`src/__tests__/sync-and-readback.test.ts` does not cover `clearApolloAPISettings`).

## Scaling Limits

**Local filesystem logging:**
- Current capacity: Unlimited — one JSON file per API call.
- Limit: Disk fills as call volume grows; no rotation or max-count policy.
- Scaling path: Replace filesystem logging with a structured log sink (stdout JSON, external log service) or add file rotation with a configurable max.

**Apollo API rate limits not handled:**
- Current capacity: No retry or backoff logic.
- Limit: Apollo's API enforces rate limits; consecutive agent calls will receive 429 responses that surface as generic errors.
- Scaling path: Add exponential backoff and retry around `fetch` calls in `searchApolloPeople`, `validateApolloAPIKey`, and `probeApolloPeopleSearch`.

## Dependencies at Risk

**`lucide-react ^1.7.0`:**
- Risk: Version `1.x` is a non-standard major for lucide-react; the published stable series is `0.x` (e.g. `0.460.0`). A `^1.7.0` range would resolve to a version that may not exist in the public registry, or may be a pre-release / experimental major.
- Impact: Install failure or unexpected icon API changes in the consuming monorepo.
- Migration plan: Verify the actual installed version in the monorepo lockfile. If `1.x` is an internal/pre-release series, pin to the exact version.

**`zod ^4.3.6`:**
- Risk: Zod v4 is a major breaking change from v3 (different API surface for some validators). If any peer dependency (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`) uses Zod v3, schema objects from this package will not interoperate.
- Impact: Schema parse errors or type incompatibilities at runtime.
- Migration plan: Confirm all first-party peers align on the same Zod major version.

## Missing Critical Features

**No rate-limit / retry handling:**
- Problem: All three `fetch` call sites (`validateApolloAPIKey`, `probeApolloPeopleSearch`, `searchApolloPeople`) make a single network call with no retry on transient failure or 429 rate-limit response.
- Blocks: Reliable agent-driven prospecting at any volume; a single transient Apollo error fails the entire operation.

**No test for `clearApolloAPISettings`:**
- Problem: The disconnect/clear flow is entirely untested.
- Blocks: Confidence in key rotation and disconnection flows; a regression in `clearApolloAPISettings` would not be caught by CI.

## Test Coverage Gaps

**`clearApolloAPISettings` not tested:**
- What's not tested: The full disconnect flow including `writeSettings` reset, Nango delete, and `clearConnectionRecords`.
- Files: `src/index.ts` (lines 320–332), `src/__tests__/sync-and-readback.test.ts`
- Risk: A regression in the clear/disconnect path (e.g. fallback IDs, wrong Nango method called) would not be caught.
- Priority: High

**`searchApolloPeople` not tested:**
- What's not tested: The main people-search function — domain normalization, `peopleSearchAvailable` guard, result mapping, pagination passthrough, usage event emission.
- Files: `src/index.ts` (lines 408–538), `src/__tests__/sync-and-readback.test.ts`
- Risk: Domain URL normalization logic and the `peopleSearchAvailable` guard could regress silently.
- Priority: High

**`parseJsonResponseBody` heuristic not tested:**
- What's not tested: The multi-candidate JSON extraction logic (newline-split candidate, brace-slice candidate).
- Files: `src/index.ts` (lines 65–83)
- Risk: If Apollo changes its response envelope, the heuristic silently returns `null` and all error messages degrade to generic strings.
- Priority: Medium

**`getApolloAPIStatus` edge cases not directly tested:**
- What's not tested: The `incomplete` status branches (apiKey set without lastValidatedAt; apiKey + lastValidatedAt + peopleSearchAvailable === false).
- Files: `src/index.ts` (lines 141–170)
- Risk: UI shows incorrect status for partially-configured connectors.
- Priority: Medium

**MCP registry/handler integration not tested:**
- What's not tested: `createApolloPrimitiveHandlers`, `registerApolloPrimitives`, and the actor-label derivation in `deriveAgentLabel`.
- Files: `src/mcp/handlers.ts`, `src/mcp/registry.ts`
- Risk: Regressions in the MCP tool dispatch layer (wrong input schema, actor label not forwarded) would only surface at runtime.
- Priority: Medium

---

*Concerns audit: 2026-06-09*
