import { clearApolloConnectionAction } from "./actions";
import { SaveApolloForm } from "./save-apollo-form";
import { getApolloAPISettings, getApolloAPIStatus } from "./index";
import { Main, PageHeader, PageContent, StatusPill, type StatusPillStatus } from "@cinatra-ai/sdk-ui/marketplace";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";
import { FieldGroup, Field, FieldLabel, FieldDescription } from "./components/ui/field";

type SettingsApolloPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function apolloStatusToPill(status: string): { pill: StatusPillStatus; label: string } {
  if (status === "connected") return { pill: "approved", label: "Connected" };
  if (status === "incomplete") return { pill: "needs-review", label: "Setup required" };
  return { pill: "idle", label: "Optional" };
}

export async function ApolloSettingsPage({ searchParams: _searchParams }: SettingsApolloPageProps) {
  // getApolloAPISettings still drives the "Leave blank to keep" affordance;
  // logging is owned by /configuration/telemetry now (toggle removed here).
  void getApolloAPISettings();
  const status = getApolloAPIStatus();
  const { pill, label } = apolloStatusToPill(status.status);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Apollo"
        description="Apollo is optional and is used by the Ross Index source as an enrichment layer for companies and founders. Cinatra keeps personal email reveal disabled so Apollo enrichment prefers business emails."
        actions={<StatusPill status={pill}>{label}</StatusPill>}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Alert variant="warning" className="rounded-control">
          <AlertTitle>Minimum Apollo plan for Cinatra</AlertTitle>
          <AlertDescription>
            The Ross Index optimization flow needs Apollo&apos;s{" "}
            <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">People API Search</code>{" "}
            endpoint. Apollo&apos;s current docs say advanced API access depends on your plan, and in
            practice the Apollo Free plan does not grant access to this endpoint. For this feature,
            use at least a non-Free Apollo plan or free trial with People API Search enabled, and
            verify access on Apollo&apos;s plan management page.
          </AlertDescription>
        </Alert>

        {status.status === "connected" && status.detail ? (
          <Alert variant="success" className="rounded-control">
            <AlertDescription>{status.detail}</AlertDescription>
          </Alert>
        ) : null}

        <section className="soft-panel rounded-panel p-5">
          <SaveApolloForm className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="apollo-api-key">API key</FieldLabel>
                <Input
                  id="apollo-api-key"
                  name="apiKey"
                  type="password"
                  required={status.status !== "connected"}
                />
                {status.status === "connected" ? (
                  <FieldDescription>Leave blank to keep the current saved key.</FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>

            <div className="flex flex-wrap gap-3">
              <Button type="submit">Save API connection</Button>
              {status.status === "connected" ? (
                <Button variant="outline" formAction={clearApolloConnectionAction} formNoValidate>
                  Clear saved key
                </Button>
              ) : null}
            </div>
          </SaveApolloForm>
        </section>
      </PageContent>
    </Main>
  );
}
