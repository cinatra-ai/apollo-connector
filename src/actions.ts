"use server";

// Apollo connection server actions — relocated from the central
// `@cinatra-ai/connectors` host hub into the connector itself (SDK-only
// decouple). Gated by the SDK's `requireExtensionAction(pkg, "manage")` — the
// hub copies used `requireAdminSession()` (admin tier); the SDK action guard is
// the host-bound equivalent (org_owner/org_admin/platform_admin, fail-closed),
// so authorization is preserved with NO `@/lib/*` import. The actual
// save/clear work runs through Apollo's own `saveApolloAPISettings` /
// `clearApolloAPISettings` (which reach Nango + connector-config via the
// connector's injected deps + the SDK generic config accessor).

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import { clearApolloAPISettings, saveApolloAPISettings } from "./index";

const APOLLO_PACKAGE_ID = "@cinatra-ai/apollo-connector";

const apolloConnectorSchema = z.object({
  apiKey: z.string().optional(),
});

export async function saveApolloConnectionAction(formData: FormData) {
  await requireExtensionAction(APOLLO_PACKAGE_ID, "manage");
  const parsed = apolloConnectorSchema.parse({
    apiKey: formData.get("apiKey") ?? undefined,
  });
  try {
    await saveApolloAPISettings(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save the Apollo API connection.";
    throw new Error(message);
  }
}

export async function clearApolloConnectionAction() {
  await requireExtensionAction(APOLLO_PACKAGE_ID, "manage");
  await clearApolloAPISettings();
  redirect("/configuration/llm/initial-setup");
}
