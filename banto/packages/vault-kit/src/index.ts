export { createVaultModuleServer, type VaultModuleOptions } from "./server.js";
export {
  LocalFileAliasStore,
  toPublic,
  type AliasStore,
  type AliasMeta,
  type AliasPatch,
  type PublicAliasMeta,
} from "./alias-store.js";
export { GroupBindings } from "./group-bindings.js";
export { REQUEST_APP_HTML, requestAppUri } from "./request-app.js";
export type { VaultBackend, AliasKind } from "./backend.js";
