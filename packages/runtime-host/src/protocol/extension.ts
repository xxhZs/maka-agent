import { isCanonicalExtensionId, isCanonicalExtensionScopeId } from '@maka/runtime/plugin-runtime';
import {
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';

export const EXTENSION_COMPOSITION_MAX_EXTENSIONS = 256;
export const EXTENSION_COMPOSITION_MAX_ENTRIES = 256;
export const EXTENSION_COMPOSITION_RESULT_MAX_BYTES = 96 * 1024;
export const EXTENSION_ERROR_MAX_BYTES = 4 * 1024;
const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'invalid_request',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export interface TrustedExtensionProjection {
  readonly extensionId: string;
  readonly toolNames: readonly string[];
  readonly uiContributionIds: readonly string[];
  readonly eventContributionIds: readonly string[];
  readonly serviceContributionIds?: readonly string[];
  readonly timerContributionIds?: readonly string[];
}

export type ExtensionCompositionEntryStatus = 'disabled' | 'active' | 'waiting' | 'failed';

export interface ExtensionCompositionEntryProjection {
  readonly entryId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly enabled: boolean;
  readonly status: ExtensionCompositionEntryStatus;
  readonly error: string | null;
}

export interface ExtensionCompositionQueryInput {}

export interface ExtensionCompositionQueryResult {
  readonly extensions: readonly TrustedExtensionProjection[];
  readonly entries: readonly ExtensionCompositionEntryProjection[];
}

export type ExtensionConfigurationScalar = string | number | boolean;

export interface ExtensionContractDependency {
  readonly id: string;
}

export interface ExtensionContractConfigurationProperty {
  readonly type: 'string' | 'number' | 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly default?: ExtensionConfigurationScalar;
  readonly enum?: readonly ExtensionConfigurationScalar[];
  readonly secret: boolean;
}

export interface ExtensionContractContribution {
  readonly kind: 'tool' | 'ui' | 'hook' | 'event' | 'listener' | 'service' | 'timer';
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly event?: string;
  readonly mode?:
    | 'emit'
    | 'parallel'
    | 'serial'
    | 'bail'
    | 'observe'
    | 'gate'
    | 'transform'
    | 'around';
}

export interface ExtensionPackageContractProjection {
  readonly extensionId: string;
  readonly displayName: string;
  readonly description: string;
  readonly dependencies: readonly ExtensionContractDependency[];
  readonly configuration: {
    readonly properties: Readonly<Record<string, ExtensionContractConfigurationProperty>>;
    readonly required: readonly string[];
  };
  readonly contributions: readonly ExtensionContractContribution[];
}

export interface ExtensionContractQueryInput {}

export interface ExtensionContractQueryResult {
  readonly packages: readonly ExtensionPackageContractProjection[];
}

export interface ExtensionConfigurationQueryInput {
  readonly entryId: string;
}

export interface ExtensionConfigurationQueryResult {
  readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
}

export interface ExtensionConfigurationMutateInput extends ExtensionConfigurationQueryInput {
  readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
}

export type ExtensionConfigurationMutateResult = ExtensionConfigurationQueryResult;

export interface ExtensionUiSnapshotInput {
  readonly scopeId: string;
}

export interface ExtensionUiContributionProjection {
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly bundle: string;
  readonly bundleSha256: string;
  readonly inject: readonly string[];
  readonly external: readonly string[];
  readonly tools: readonly string[];
}

export interface ExtensionUiSnapshotResult {
  readonly scopeId: string;
  readonly digest: string;
  readonly contributions: readonly ExtensionUiContributionProjection[];
}

export interface ExtensionClientToolInvokeInput {
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ExtensionClientToolInvokeResult {
  readonly value: unknown;
}

export type ExtensionCompositionMutateInput =
  | {
      readonly kind: 'enable';
      readonly entryId: string;
      readonly scopeId: string;
      readonly extensionId: string;
    }
  | { readonly kind: 'disable'; readonly entryId: string }
  | { readonly kind: 'reload'; readonly entryId: string }
  | { readonly kind: 'remove'; readonly entryId: string };

export interface ExtensionCompositionMutateResult {
  readonly entry: ExtensionCompositionEntryProjection | null;
}

export interface ToolPackageInstallInput {
  readonly sourcePath: string;
}

export type ToolPackageInstallResult = TrustedExtensionProjection;

export interface ToolPackageUninstallInput {
  readonly extensionId: string;
}

export interface ToolPackageUninstallResult {}

export interface ExtensionPackageExportInput {
  readonly extensionId: string;
  readonly targetPath: string;
}

export interface ExtensionPackageExportResult {
  readonly targetPath: string;
}

export const EXTENSION_OPERATION_SPECS = {
  'extension.composition.query': defineOperation<
    ExtensionCompositionQueryInput,
    ExtensionCompositionQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionCompositionQueryInput,
    decodeOutput: decodeExtensionCompositionQueryResult,
  }),
  'extension.composition.mutate': defineOperation<
    ExtensionCompositionMutateInput,
    ExtensionCompositionMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionCompositionMutateInput,
    decodeOutput: decodeExtensionCompositionMutateResult,
  }),
  'extension.contract.query': defineOperation<
    ExtensionContractQueryInput,
    ExtensionContractQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionContractQueryInput,
    decodeOutput: decodeExtensionContractQueryResult,
  }),
  'extension.configuration.query': defineOperation<
    ExtensionConfigurationQueryInput,
    ExtensionConfigurationQueryResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionConfigurationQueryInput,
    decodeOutput: decodeExtensionConfigurationQueryResult,
  }),
  'extension.configuration.mutate': defineOperation<
    ExtensionConfigurationMutateInput,
    ExtensionConfigurationMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionConfigurationMutateInput,
    decodeOutput: decodeExtensionConfigurationQueryResult,
  }),
  'extension.ui.snapshot': defineOperation<
    ExtensionUiSnapshotInput,
    ExtensionUiSnapshotResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeExtensionUiSnapshotInput,
    decodeOutput: decodeExtensionUiSnapshotResult,
  }),
  'extension.client.tool.invoke': defineOperation<
    ExtensionClientToolInvokeInput,
    ExtensionClientToolInvokeResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionClientToolInvokeInput,
    decodeOutput: decodeExtensionClientToolInvokeResult,
  }),
  'extension.package.install': defineHostPathOperation<
    ToolPackageInstallInput,
    ToolPackageInstallResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeToolPackageInstallInput,
    decodeOutput: decodeToolPackageInstallResult,
  }),
  'extension.package.uninstall': defineOperation<
    ToolPackageUninstallInput,
    ToolPackageUninstallResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeToolPackageUninstallInput,
    decodeOutput: decodeToolPackageUninstallResult,
  }),
  'extension.package.export': defineHostPathOperation<
    ExtensionPackageExportInput,
    ExtensionPackageExportResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeExtensionPackageExportInput,
    decodeOutput: decodeExtensionPackageExportResult,
  }),
} as const;

export function decodeExtensionCompositionQueryInput(
  value: unknown,
): ExtensionCompositionQueryInput {
  requireExactRecord(value, 'extension composition query input', []);
  return {};
}

export function decodeExtensionContractQueryInput(value: unknown): ExtensionContractQueryInput {
  requireExactRecord(value, 'extension contract query input', []);
  return {};
}

export function decodeExtensionContractQueryResult(value: unknown): ExtensionContractQueryResult {
  const result = requireExactRecord(value, 'extension contract query result', ['packages']);
  if (
    !Array.isArray(result.packages) ||
    result.packages.length > EXTENSION_COMPOSITION_MAX_EXTENSIONS
  ) {
    throw invalidProtocolFrame('Invalid extension contract packages');
  }
  const decoded = { packages: result.packages.map(decodePackageContract) };
  requireEncodedByteLimit(decoded, 'extension contract query result', 512 * 1024);
  return decoded;
}

export function decodeExtensionConfigurationQueryInput(
  value: unknown,
): ExtensionConfigurationQueryInput {
  const input = requireExactRecord(value, 'extension configuration query input', ['entryId']);
  return { entryId: requireEntityId(input.entryId, 'extension entryId') };
}

export function decodeExtensionConfigurationQueryResult(
  value: unknown,
): ExtensionConfigurationQueryResult {
  const result = requireExactRecord(value, 'extension configuration query result', [
    'configuration',
  ]);
  return { configuration: decodeConfigurationValues(result.configuration) };
}

export function decodeExtensionConfigurationMutateInput(
  value: unknown,
): ExtensionConfigurationMutateInput {
  const input = requireExactRecord(value, 'extension configuration mutation input', [
    'entryId',
    'configuration',
  ]);
  return {
    entryId: requireEntityId(input.entryId, 'extension entryId'),
    configuration: decodeConfigurationValues(input.configuration),
  };
}

export function decodeExtensionUiSnapshotInput(value: unknown): ExtensionUiSnapshotInput {
  const input = requireExactRecord(value, 'extension UI snapshot input', ['scopeId']);
  return { scopeId: decodeExtensionScopeId(input.scopeId, 'extension UI scopeId') };
}

export function decodeExtensionUiSnapshotResult(value: unknown): ExtensionUiSnapshotResult {
  const result = requireExactRecord(value, 'extension UI snapshot result', [
    'scopeId',
    'digest',
    'contributions',
  ]);
  if (!Array.isArray(result.contributions) || result.contributions.length > 64) {
    throw invalidProtocolFrame('Invalid extension UI contributions');
  }
  const decoded = {
    scopeId: decodeExtensionScopeId(result.scopeId, 'extension UI scopeId'),
    digest: requireUtf8String(result.digest, 'extension UI digest', 128),
    contributions: result.contributions.map(decodeUiContributionProjection),
  };
  requireEncodedByteLimit(decoded, 'extension UI snapshot result', 2 * 1024 * 1024);
  return decoded;
}

export function decodeExtensionClientToolInvokeInput(
  value: unknown,
): ExtensionClientToolInvokeInput {
  const input = requireExactRecord(value, 'Extension Client Tool invocation', [
    'entryId',
    'extensionId',
    'generation',
    'id',
    'sessionId',
    'toolName',
    'args',
  ]);
  const decoded = {
    entryId: requireEntityId(input.entryId, 'extension entryId'),
    extensionId: decodeExtensionId(input.extensionId),
    generation: decodeGeneration(input.generation),
    id: requireUtf8String(input.id, 'extension UI contribution id', 128),
    sessionId: requireUtf8String(input.sessionId, 'session id', 256),
    toolName: requireUtf8String(input.toolName, 'extension Tool name', 128),
    args: cloneClientJson(input.args, 'Extension Client Tool arguments'),
  };
  requireEncodedByteLimit(decoded, 'Extension Client Tool invocation', 1024 * 1024);
  return decoded;
}

export function decodeExtensionClientToolInvokeResult(
  value: unknown,
): ExtensionClientToolInvokeResult {
  const result = requireExactRecord(value, 'Extension Client Tool result', ['value']);
  return { value: cloneClientJson(result.value, 'Extension Client Tool result') };
}

export function decodeExtensionCompositionQueryResult(
  value: unknown,
): ExtensionCompositionQueryResult {
  const result = requireExactRecord(value, 'extension composition query result', [
    'extensions',
    'entries',
  ]);
  if (
    !Array.isArray(result.extensions) ||
    result.extensions.length > EXTENSION_COMPOSITION_MAX_EXTENSIONS ||
    !Array.isArray(result.entries) ||
    result.entries.length > EXTENSION_COMPOSITION_MAX_ENTRIES
  ) {
    throw invalidProtocolFrame('Invalid extension composition result');
  }
  const decoded = {
    extensions: result.extensions.map(decodeExtensionProjection),
    entries: result.entries.map(decodeEntryProjection),
  };
  requireEncodedByteLimit(
    decoded,
    'extension composition result',
    EXTENSION_COMPOSITION_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeExtensionCompositionMutateInput(
  value: unknown,
): ExtensionCompositionMutateInput {
  const record = requireRecord(value, 'extension composition mutation input');
  switch (record.kind) {
    case 'enable': {
      const input = requireExactRecord(record, 'extension enable input', [
        'kind',
        'entryId',
        'scopeId',
        'extensionId',
      ]);
      return {
        kind: 'enable',
        entryId: requireEntityId(input.entryId, 'extension entryId'),
        scopeId: decodeExtensionScopeId(input.scopeId, 'extension scopeId'),
        extensionId: decodeExtensionId(input.extensionId),
      };
    }
    case 'disable':
    case 'remove': {
      const input = requireExactRecord(record, `extension ${record.kind} input`, [
        'kind',
        'entryId',
      ]);
      return {
        kind: record.kind,
        entryId: requireEntityId(input.entryId, 'extension entryId'),
      };
    }
    case 'reload': {
      const input = requireExactRecord(record, 'extension reload input', ['kind', 'entryId']);
      return {
        kind: 'reload',
        entryId: requireEntityId(input.entryId, 'extension entryId'),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid extension composition mutation kind');
  }
}

export function decodeExtensionCompositionMutateResult(
  value: unknown,
): ExtensionCompositionMutateResult {
  const result = requireExactRecord(value, 'extension composition mutation result', ['entry']);
  return {
    entry: result.entry === null ? null : decodeEntryProjection(result.entry),
  };
}

export function decodeToolPackageInstallInput(value: unknown): ToolPackageInstallInput {
  const input = requireExactRecord(value, 'Tool package install input', ['sourcePath']);
  return { sourcePath: requireUtf8String(input.sourcePath, 'Tool package sourcePath', 16 * 1024) };
}

export function decodeToolPackageInstallResult(value: unknown): ToolPackageInstallResult {
  return decodeExtensionProjection(value);
}

export function decodeToolPackageUninstallInput(value: unknown): ToolPackageUninstallInput {
  const input = requireExactRecord(value, 'Tool package uninstall input', ['extensionId']);
  return {
    extensionId: decodeExtensionId(input.extensionId),
  };
}

export function decodeToolPackageUninstallResult(value: unknown): ToolPackageUninstallResult {
  requireExactRecord(value, 'Tool package uninstall result', []);
  return {};
}

export function decodeExtensionPackageExportInput(value: unknown): ExtensionPackageExportInput {
  const input = requireExactRecord(value, 'Extension package export input', [
    'extensionId',
    'targetPath',
  ]);
  return {
    extensionId: decodeExtensionId(input.extensionId),
    targetPath: requireUtf8String(input.targetPath, 'Extension package targetPath', 16 * 1024),
  };
}

export function decodeExtensionPackageExportResult(value: unknown): ExtensionPackageExportResult {
  const result = requireExactRecord(value, 'Extension package export result', ['targetPath']);
  return {
    targetPath: requireUtf8String(result.targetPath, 'Extension package targetPath', 16 * 1024),
  };
}

function decodeExtensionProjection(value: unknown): TrustedExtensionProjection {
  const source = requireRecord(value, 'trusted extension');
  const extension = requireExactRecord(value, 'trusted extension', [
    'extensionId',
    'toolNames',
    'uiContributionIds',
    ...(Object.hasOwn(source, 'eventContributionIds') ? ['eventContributionIds'] : []),
    ...(Object.hasOwn(source, 'serviceContributionIds') ? ['serviceContributionIds'] : []),
    ...(Object.hasOwn(source, 'timerContributionIds') ? ['timerContributionIds'] : []),
  ]);
  const eventContributionIds = extension.eventContributionIds ?? [];
  const serviceContributionIds = extension.serviceContributionIds ?? [];
  const timerContributionIds = extension.timerContributionIds ?? [];
  if (
    !Array.isArray(extension.toolNames) ||
    extension.toolNames.length > 128 ||
    !Array.isArray(extension.uiContributionIds) ||
    extension.uiContributionIds.length > 64 ||
    !Array.isArray(eventContributionIds) ||
    eventContributionIds.length > 128 ||
    !Array.isArray(serviceContributionIds) ||
    serviceContributionIds.length > 64 ||
    !Array.isArray(timerContributionIds) ||
    timerContributionIds.length > 64
  ) {
    throw invalidProtocolFrame('Invalid trusted extension contribution names');
  }
  return {
    extensionId: decodeExtensionId(extension.extensionId),
    toolNames: extension.toolNames.map((name) =>
      requireUtf8String(name, 'extension tool name', 128),
    ),
    uiContributionIds: extension.uiContributionIds.map((id) =>
      requireUtf8String(id, 'extension UI contribution id', 128),
    ),
    eventContributionIds: eventContributionIds.map((id) =>
      requireUtf8String(id, 'extension Event contribution id', 512),
    ),
    ...(Object.hasOwn(source, 'serviceContributionIds')
      ? {
          serviceContributionIds: serviceContributionIds.map((id) =>
            requireUtf8String(id, 'extension Service contribution id', 192),
          ),
        }
      : {}),
    ...(Object.hasOwn(source, 'timerContributionIds')
      ? {
          timerContributionIds: timerContributionIds.map((id) =>
            requireUtf8String(id, 'extension Timer contribution id', 128),
          ),
        }
      : {}),
  };
}

function decodePackageContract(value: unknown): ExtensionPackageContractProjection {
  const contract = requireExactRecord(value, 'Extension package contract', [
    'extensionId',
    'displayName',
    'description',
    'dependencies',
    'configuration',
    'contributions',
  ]);
  if (
    !Array.isArray(contract.dependencies) ||
    contract.dependencies.length > 64 ||
    !Array.isArray(contract.contributions) ||
    contract.contributions.length > 320
  )
    throw invalidProtocolFrame('Invalid Extension package contract collections');
  const configuration = requireExactRecord(
    contract.configuration,
    'Extension configuration contract',
    ['properties', 'required'],
  );
  const properties = requireRecord(configuration.properties, 'Extension configuration properties');
  if (Object.keys(properties).length > 128 || !Array.isArray(configuration.required)) {
    throw invalidProtocolFrame('Invalid Extension configuration contract');
  }
  const decodedProperties: Record<string, ExtensionContractConfigurationProperty> =
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const propertySource = requireRecord(value, 'Extension configuration property');
        const fields = [
          'type',
          'secret',
          ...(Object.hasOwn(propertySource, 'title') ? ['title'] : []),
          ...(Object.hasOwn(propertySource, 'description') ? ['description'] : []),
          ...(Object.hasOwn(propertySource, 'default') ? ['default'] : []),
          ...(Object.hasOwn(propertySource, 'enum') ? ['enum'] : []),
        ];
        const property = requireExactRecord(
          propertySource,
          'Extension configuration property',
          fields,
        );
        if (
          property.type !== 'string' &&
          property.type !== 'number' &&
          property.type !== 'boolean'
        ) {
          throw invalidProtocolFrame('Invalid Extension configuration property type');
        }
        const scalar = (candidate: unknown): ExtensionConfigurationScalar => {
          if (
            typeof candidate !== property.type ||
            (typeof candidate === 'number' && !Number.isFinite(candidate))
          )
            throw invalidProtocolFrame('Invalid Extension configuration property value');
          return candidate as ExtensionConfigurationScalar;
        };
        return [
          requireUtf8String(key, 'Extension configuration property key', 128),
          {
            type: property.type,
            ...(property.title === undefined
              ? {}
              : { title: requireUtf8String(property.title, 'Extension configuration title', 128) }),
            ...(property.description === undefined
              ? {}
              : {
                  description: requireUtf8String(
                    property.description,
                    'Extension configuration description',
                    1024,
                  ),
                }),
            ...(property.default === undefined ? {} : { default: scalar(property.default) }),
            ...(property.enum === undefined
              ? {}
              : {
                  enum:
                    Array.isArray(property.enum) && property.enum.length <= 64
                      ? property.enum.map(scalar)
                      : (() => {
                          throw invalidProtocolFrame('Invalid Extension configuration enum');
                        })(),
                }),
            secret: decodeBoolean(property.secret, 'Extension configuration secret'),
          } satisfies ExtensionContractConfigurationProperty,
        ];
      }),
    );
  const required = configuration.required.map((key) =>
    requireUtf8String(key, 'Extension required configuration key', 128),
  );
  return {
    extensionId: decodeExtensionId(contract.extensionId),
    displayName: requireUtf8String(contract.displayName, 'Extension package displayName', 128),
    description:
      typeof contract.description === 'string' &&
      Buffer.byteLength(contract.description, 'utf8') <= 4096
        ? contract.description
        : (() => {
            throw invalidProtocolFrame('Invalid Extension package description');
          })(),
    dependencies: contract.dependencies.map((value) => {
      const dependency = requireExactRecord(value, 'Extension dependency', ['id']);
      return { id: decodeExtensionId(dependency.id) };
    }),
    configuration: { properties: decodedProperties, required },
    contributions: contract.contributions.map(decodeContractContribution),
  };
}

function decodeContractContribution(value: unknown): ExtensionContractContribution {
  const source = requireRecord(value, 'Extension contract contribution');
  const fields = [
    'kind',
    'id',
    ...(Object.hasOwn(source, 'name') ? ['name'] : []),
    ...(Object.hasOwn(source, 'description') ? ['description'] : []),
    ...(Object.hasOwn(source, 'surface') ? ['surface'] : []),
    ...(Object.hasOwn(source, 'slot') ? ['slot'] : []),
    ...(Object.hasOwn(source, 'slots') ? ['slots'] : []),
    ...(Object.hasOwn(source, 'event') ? ['event'] : []),
    ...(Object.hasOwn(source, 'mode') ? ['mode'] : []),
  ];
  const contribution = requireExactRecord(source, 'Extension contract contribution', fields);
  if (
    contribution.kind !== 'tool' &&
    contribution.kind !== 'ui' &&
    contribution.kind !== 'hook' &&
    contribution.kind !== 'event' &&
    contribution.kind !== 'listener' &&
    contribution.kind !== 'service' &&
    contribution.kind !== 'timer'
  ) {
    throw invalidProtocolFrame('Invalid Extension contract contribution kind');
  }
  const isHookEvent =
    contribution.event === 'UserPromptSubmit' ||
    contribution.event === 'RunStart' ||
    contribution.event === 'PreToolUse' ||
    contribution.event === 'PostToolUse' ||
    contribution.event === 'RunEnd';
  const isPluginEvent =
    typeof contribution.event === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(contribution.event) &&
    Buffer.byteLength(contribution.event, 'utf8') <= 192;
  const hookMode =
    contribution.mode === 'observe' ||
    contribution.mode === 'gate' ||
    contribution.mode === 'transform';
  const eventMode =
    contribution.mode === 'emit' ||
    contribution.mode === 'parallel' ||
    contribution.mode === 'serial' ||
    contribution.mode === 'bail' ||
    hookMode;
  if (contribution.mode !== undefined && !eventMode)
    throw invalidProtocolFrame('Invalid Extension contract dispatch mode');
  if (
    (contribution.kind === 'hook' && (!isHookEvent || !hookMode)) ||
    (contribution.kind === 'event' &&
      (!isPluginEvent || (contribution.mode !== undefined && !eventMode))) ||
    (contribution.kind === 'listener' && (!isPluginEvent || contribution.mode !== undefined)) ||
    (contribution.kind !== 'hook' &&
      contribution.kind !== 'event' &&
      contribution.kind !== 'listener' &&
      (contribution.event !== undefined || contribution.mode !== undefined))
  ) {
    throw invalidProtocolFrame('Invalid Extension contract Hook fields');
  }
  return {
    kind: contribution.kind,
    id: requireUtf8String(contribution.id, 'Extension contribution id', 128),
    ...(contribution.name === undefined
      ? {}
      : { name: requireUtf8String(contribution.name, 'Extension Tool name', 128) }),
    ...(contribution.description === undefined
      ? {}
      : {
          description: requireUtf8String(
            contribution.description,
            'Extension Tool description',
            4096,
          ),
        }),
    ...(contribution.event === undefined ? {} : { event: contribution.event as string }),
    ...(contribution.mode === undefined
      ? {}
      : { mode: contribution.mode as ExtensionContractContribution['mode'] }),
  };
}

function decodeConfigurationValues(
  value: unknown,
): Readonly<Record<string, ExtensionConfigurationScalar>> {
  const source = requireRecord(value, 'Extension configuration values');
  if (Object.keys(source).length > 128)
    throw invalidProtocolFrame('Too many Extension configuration values');
  const result: Record<string, ExtensionConfigurationScalar> = {};
  for (const [key, configured] of Object.entries(source)) {
    if (
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key) ||
      (typeof configured !== 'string' &&
        typeof configured !== 'boolean' &&
        !(typeof configured === 'number' && Number.isFinite(configured)))
    )
      throw invalidProtocolFrame('Invalid Extension configuration value');
    result[key] = configured;
  }
  requireEncodedByteLimit(result, 'Extension configuration values', 64 * 1024);
  return result;
}

function decodeUiContributionProjection(value: unknown): ExtensionUiContributionProjection {
  const item = requireExactRecord(value, 'extension UI contribution', [
    'entryId',
    'extensionId',
    'generation',
    'id',
    'bundle',
    'bundleSha256',
    'inject',
    'external',
    'tools',
  ]);
  return {
    entryId: requireEntityId(item.entryId, 'extension entryId'),
    extensionId: decodeExtensionId(item.extensionId),
    generation: decodeGeneration(item.generation),
    id: requireUtf8String(item.id, 'extension UI contribution id', 128),
    bundle: requireUtf8String(item.bundle, 'extension UI client bundle', 1024 * 1024),
    bundleSha256: requireUtf8String(item.bundleSha256, 'extension UI bundle digest', 128),
    inject: decodeClientDependencyIds(item.inject, 'extension UI inject'),
    external: decodeClientDependencyIds(item.external, 'extension UI external'),
    tools: decodeClientToolNames(item.tools),
  };
}

function decodeClientToolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw invalidProtocolFrame('Invalid extension UI Client Tool allowlist');
  }
  const names = value.map((item) => requireUtf8String(item, 'extension UI Client Tool', 128));
  if (
    names.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name)) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  ) {
    throw invalidProtocolFrame('Invalid extension UI Client Tool allowlist');
  }
  return names;
}

function cloneClientJson(value: unknown, label: string): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`${label} is not JSON`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) {
    throw invalidProtocolFrame(`${label} is invalid or too large`);
  }
  return JSON.parse(encoded) as unknown;
}

function decodeClientDependencyIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw invalidProtocolFrame(`Invalid ${label}`);
  const ids = value.map((item) => requireUtf8String(item, label, 128));
  if (new Set(ids).size !== ids.length) throw invalidProtocolFrame(`Invalid ${label}`);
  return ids;
}

function decodeEntryProjection(value: unknown): ExtensionCompositionEntryProjection {
  const entry = requireExactRecord(value, 'extension entry', [
    'entryId',
    'scopeId',
    'extensionId',
    'generation',
    'enabled',
    'status',
    'error',
  ]);
  return {
    entryId: requireEntityId(entry.entryId, 'extension entryId'),
    scopeId: decodeExtensionScopeId(entry.scopeId, 'extension scopeId'),
    extensionId: decodeExtensionId(entry.extensionId),
    generation: decodeGeneration(entry.generation),
    enabled: decodeBoolean(entry.enabled, 'extension enabled'),
    status: decodeEntryStatus(entry.status),
    error:
      entry.error === null
        ? null
        : requireUtf8String(entry.error, 'extension error', EXTENSION_ERROR_MAX_BYTES),
  };
}

function decodeGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw invalidProtocolFrame('Invalid extension Fiber generation');
  return value as number;
}

function decodeExtensionId(value: unknown): string {
  if (!isCanonicalExtensionId(value)) {
    throw invalidProtocolFrame('Invalid extension extensionId');
  }
  return value;
}

function decodeExtensionScopeId(value: unknown, label: string): string {
  if (!isCanonicalExtensionScopeId(value)) throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function decodeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function decodeEntryStatus(value: unknown): ExtensionCompositionEntryStatus {
  if (value !== 'disabled' && value !== 'active' && value !== 'waiting' && value !== 'failed') {
    throw invalidProtocolFrame('Invalid extension entry status');
  }
  return value;
}
