export { createVaultModuleServer, type VaultModuleOptions } from "./server.js";
export {
  LocalFileAliasStore,
  toPublic,
  isLink,
  type AliasStore,
  type AliasMeta,
  type SecretAliasMeta,
  type LinkAliasMeta,
  type AliasPatch,
  type PublicAliasMeta,
  type AliasListOptions,
} from "./alias-store.js";
export { GroupBindings } from "./group-bindings.js";
export { REQUEST_APP_HTML, requestAppUri } from "./request-app.js";
export type { VaultBackend, AliasKind, VariantAxis, VariantCount } from "./backend.js";
export { splitVariant, joinVariant, VARIANT_SEPARATOR } from "./backend.js";
export { ALIAS_KIND_RULES, ALIAS_KIND_RULES_JS, type AliasKindRule } from "./kind-rules.js";
export { agentSocketPath } from "./backend.js";
