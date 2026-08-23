export {
  checkManifest,
  describeDependency,
  describeProblem,
  isCapabilityDependency,
  NOT_IN_THE_CONTRACT,
  requiredRoot,
  type BantoModule,
  type GuiBoundary,
  type ModuleGui,
  type ViewSpec,
  type Capability,
  type CapabilityDependency,
  type Dependency,
  type ModuleDependency,
  type Handles,
  type Isolation,
  type ManifestProblem,
  type McpSpec,
  type ModuleId,
} from './manifest.js';

export {
  ALL_AVAILABLE,
  decline,
  defineModule,
  ok,
  type Availability,
  type DefinedModule,
  type ModuleSpec,
  type ToolResult,
  type ToolSpec,
  type TextToolSpec,
  type StructuredToolSpec,
} from './define.js';

export {
  assertStartable,
  availabilityFor,
  describeRegistryProblem,
  resolve,
  type Bindings,
  type Degradation,
  type ModuleSource,
  type RegistryProblem,
  type Resolution,
} from './registry.js';

export {
  inProcessSource,
  loadManifest,
  subprocessSource,
} from './load.js';

export { connectInProcess, connectSubprocess, type ToolCaller } from './client.js';

export { resolveInside } from './boundary.js';

export {
  describeImpact,
  impactOfDisabling,
  type Breakage,
  type Impact,
} from './impact.js';
