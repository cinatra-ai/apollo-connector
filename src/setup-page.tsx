// Dispatch-route entry.
import { ApolloSettingsPage } from "./settings-page";

type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
};

export default async function ApolloConnectorSetupPage({
  searchParams,
}: ConnectorSetupPageProps) {
  return ApolloSettingsPage({ searchParams: Promise.resolve(searchParams) });
}
