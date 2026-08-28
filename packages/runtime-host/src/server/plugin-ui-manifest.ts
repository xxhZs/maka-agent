import { posix } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';

const PACKAGE_ID_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;

export interface UiPackageClientManifest {
  readonly entry: string;
  readonly inject: readonly string[];
  readonly external: readonly string[];
  readonly tools: readonly string[];
}

export interface UiPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly client: UiPackageClientManifest;
}

export interface InstalledUiPackage {
  readonly extensionId: string;
  readonly root: string;
  readonly manifest: UiPackageManifest;
}

export class PluginUiManifestError extends Error {
  readonly name = 'PluginUiManifestError';
  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Decode the trusted Renderer half from the unified Extension manifest. */
export function decodeUiPackageManifest(value: unknown): UiPackageManifest {
  const root = exactRecord(value, [
    'schemaVersion',
    'id',
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'displayName')
      ? ['displayName']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'description')
      ? ['description']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'dependencies')
      ? ['dependencies']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'configuration')
      ? ['configuration']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'runtime') ? ['runtime'] : []),
    'ui',
  ]);
  if (root.schemaVersion !== 1) throw invalidPackage('Extension schemaVersion must be 1');
  const id = requireId(root.id);
  const ui = exactRecord(root.ui, ['client']);
  const candidate = ui.client as Record<string, unknown> | null;
  const client = exactRecord(ui.client, [
    'entry',
    ...(candidate && Object.hasOwn(candidate, 'inject') ? ['inject'] : []),
    ...(candidate && Object.hasOwn(candidate, 'external') ? ['external'] : []),
    ...(candidate && Object.hasOwn(candidate, 'tools') ? ['tools'] : []),
  ]);
  const entry = packagePath(client.entry, 'ui.client.entry');
  if (!entry.endsWith('.js')) throw invalidPackage('UI client entry must be a .js file');
  return Object.freeze({
    schemaVersion: 1,
    id,
    client: Object.freeze({
      entry,
      inject: packageIds(client.inject, 'ui.client.inject'),
      external: packageIds(client.external, 'ui.client.external'),
      tools: toolNames(client.tools, 'ui.client.tools'),
    }),
  });
}

function toolNames(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw invalidPackage(`${label} must be a string array`);
  }
  const names = value.map((item) => item as string);
  if (
    names.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name)) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  ) {
    throw invalidPackage(`${label} contains an invalid or duplicate Tool name`);
  }
  return Object.freeze(names);
}

function packageIds(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw invalidPackage(`${label} must be a string array`);
  }
  const ids = value.map((item) => item as string);
  if (ids.some((id) => !PACKAGE_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw invalidPackage(`${label} contains an invalid or duplicate package id`);
  }
  return Object.freeze(ids);
}

function packagePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return path;
}

function requireId(value: unknown): string {
  const id = boundedString(value, 'id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('UI package id is invalid');
  return id;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\r\n\0]/u.test(value)
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return value;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPackage('UI package object is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw invalidPackage(`UI package fields are invalid; expected ${fields.join(', ')}`);
  }
  return record;
}

function invalidPackage(message: string): PluginUiManifestError {
  return new PluginUiManifestError('invalid_package', message);
}
