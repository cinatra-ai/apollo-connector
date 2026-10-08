import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import {
  ConnectorSetupPage,
  type ConnectorSetupSchemaData,
} from "@cinatra-ai/sdk-ui/connector-setup-page";

type SetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
  ctx: ExtensionHostContext;
  setupData: ConnectorSetupSchemaData;
};

export default function SetupPage({ setupData }: SetupPageProps) {
  if (!setupData) {
    throw new Error("Connector setup data is unavailable");
  }

  return (
    <ConnectorSetupPage
      title="Apollo"
      description="Connector setup"
      divider={false}
      schema={setupData}
    >
      {null}
    </ConnectorSetupPage>
  );
}
