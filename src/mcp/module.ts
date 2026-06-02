import { registerApolloPrimitives } from "./registry";

export function createApolloModule() {
  return {
    registerCapabilities: registerApolloPrimitives,
  };
}
