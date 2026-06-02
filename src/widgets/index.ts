export { connectorApolloManifest } from "./manifest";
export { PeopleSearchWidget } from "./people-search-widget";

import type { WidgetDefinition } from "@cinatra-ai/sdk-ui";
import { PeopleSearchWidget } from "./people-search-widget";

export const connectorApolloWidgets: WidgetDefinition[] = [
  { id: "connector-apollo.people-search", label: "Apollo People Search", component: PeopleSearchWidget },
];
