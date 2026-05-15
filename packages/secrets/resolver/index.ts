/**
 * @ark/secrets/resolver -- hierarchical resolver that walks user -> team
 * chain -> tenant under `/ark/<tid>/...` and emits the effective env-var
 * set for a dispatched session.
 */
export {
  tenantPath,
  tenantPrefix,
  teamPath,
  teamPrefix,
  userPath,
  userPrefix,
  parsePath,
  validateSegment,
  validateKey,
  MAX_PATH_LENGTH,
} from "./paths.js";
export type { ParsedPath } from "./paths.js";
export { HierarchicalSecretResolver } from "./resolver.js";
export type { ResolveSession } from "./resolver.js";
