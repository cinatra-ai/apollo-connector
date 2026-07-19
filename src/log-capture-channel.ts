// Dependency-free leaf module (same rationale as the retired ./log-directory.ts
// — kept out of the heavy index barrel so it carries no init-order coupling).
//
// The channel name this connector's request/response captures write under via
// the host-owned `ctx.logger.capture(channel, entry)` port (cinatra#981). The
// host resolves the actual on-disk directory (`<extension-data-root>/logs/
// <packageName>/<channel>/`) — this connector only ever needs the channel id,
// never a raw filesystem path.
export const APOLLO_LOG_CAPTURE_CHANNEL = "apollo-api";
