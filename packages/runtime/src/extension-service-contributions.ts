import { z } from 'zod';
import type { MakaContributionContext } from './plugin-runtime.js';

export interface ExtensionServiceInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly origin: 'provider' | 'code_mode' | 'host';
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  readonly callerExtensionId?: string;
  readonly serviceDepth?: number;
}

export interface ExtensionServiceMethodDefinition {
  readonly name: string;
  readonly description: string;
  readonly handler: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface ExtensionServiceContribution {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly methods: readonly ExtensionServiceMethodDefinition[];
  invoke(
    method: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown>;
}

export interface ExtensionServiceContributionInspection extends ExtensionServiceContribution {
  readonly entryId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly generation: number;
}

export interface ProvidedExtensionService {
  readonly identity: Readonly<{
    readonly entryId: string;
    readonly scopeId: string;
    readonly extensionId: string;
    readonly generation: number;
  }>;
  readonly contribution: ExtensionServiceContribution;
}

export class ExtensionServiceContributionError extends Error {
  readonly name = 'ExtensionServiceContributionError';
  constructor(
    readonly code:
      | 'invalid_service'
      | 'service_conflict'
      | 'service_not_found'
      | 'method_not_found'
      | 'invalid_input'
      | 'invalid_output',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Invokes one Service implementation already resolved by the caller's Context.
 * Scope and lifecycle authority deliberately stay in Context/Fiber; this helper
 * owns only the JSON boundary validation required by package code.
 */
export async function invokeExtensionServiceContribution(
  contribution: ExtensionServiceContribution,
  method: string,
  input: unknown,
  context: ExtensionServiceInvocationContext,
): Promise<unknown> {
  const definition = contribution.methods.find((candidate) => candidate.name === method);
  if (!definition) {
    throw new ExtensionServiceContributionError(
      'method_not_found',
      `Service method is not defined: ${contribution.name}.${method}`,
    );
  }
  let inputValidator: z.ZodType;
  let outputValidator: z.ZodType;
  try {
    inputValidator = z.fromJSONSchema(definition.inputSchema);
    outputValidator = z.fromJSONSchema(definition.outputSchema);
  } catch (error) {
    throw new ExtensionServiceContributionError(
      'invalid_service',
      `Service JSON Schema is unsupported: ${contribution.name}`,
      { cause: error },
    );
  }
  const parsedInput = inputValidator.safeParse(input);
  if (!parsedInput.success) {
    throw new ExtensionServiceContributionError(
      'invalid_input',
      `Service input does not match ${contribution.name}.${method}: ${z.prettifyError(parsedInput.error)}`,
    );
  }
  const result = await contribution.invoke(method, structuredClone(parsedInput.data), context);
  const parsedOutput = outputValidator.safeParse(result);
  if (!parsedOutput.success) {
    throw new ExtensionServiceContributionError(
      'invalid_output',
      `Service output does not match ${contribution.name}.${method}: ${z.prettifyError(parsedOutput.error)}`,
    );
  }
  return structuredClone(parsedOutput.data);
}

export function contributeExtensionService(
  context: MakaContributionContext,
  contribution: ExtensionServiceContribution,
): void {
  validateExtensionServiceContribution(context.extensionId, contribution);
  validateSchemas(contribution);
  const provided: ProvidedExtensionService = Object.freeze({
    identity: Object.freeze({
      entryId: context.entryId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      generation: context.generation,
    }),
    contribution: Object.freeze({
      ...contribution,
      methods: Object.freeze(contribution.methods.map((method) => Object.freeze({ ...method }))),
    }),
  });
  context.runtimeContext.provideService(
    {
      name: `service:${contribution.name}`,
      role: 'seam',
      permissions: Object.freeze([]),
      isolate: true,
    },
    provided,
  );
}

function validateSchemas(contribution: ExtensionServiceContribution): void {
  try {
    for (const method of contribution.methods) {
      z.fromJSONSchema(method.inputSchema);
      z.fromJSONSchema(method.outputSchema);
    }
  } catch (error) {
    throw new ExtensionServiceContributionError(
      'invalid_service',
      `Service JSON Schema is unsupported: ${contribution.name}`,
      { cause: error },
    );
  }
}

export function validateExtensionServiceContribution(
  extensionId: string,
  contribution: ExtensionServiceContribution,
): void {
  if (!contribution || typeof contribution !== 'object')
    invalid('Service contribution is required');
  if (!canonicalName(contribution.name) || !contribution.name.startsWith(`${extensionId}.`)) {
    invalid(`Service name must be owned by the Extension namespace: ${extensionId}.`);
  }
  if (
    typeof contribution.version !== 'string' ||
    contribution.version.length === 0 ||
    contribution.version.length > 128
  )
    invalid('Service version is invalid');
  if (
    typeof contribution.description !== 'string' ||
    Buffer.byteLength(contribution.description, 'utf8') > 4096
  )
    invalid('Service description is invalid');
  if (
    !Array.isArray(contribution.methods) ||
    contribution.methods.length === 0 ||
    contribution.methods.length > 64
  )
    invalid('Service methods are invalid');
  const methods = new Set<string>();
  for (const method of contribution.methods) {
    if (!canonicalId(method.name) || !canonicalId(method.handler))
      invalid('Service method identity is invalid');
    if (methods.has(method.name)) invalid(`Service method repeats: ${method.name}`);
    methods.add(method.name);
    if (
      typeof method.description !== 'string' ||
      Buffer.byteLength(method.description, 'utf8') > 4096
    )
      invalid('Service method description is invalid');
    if (!jsonSchema(method.inputSchema) || !jsonSchema(method.outputSchema))
      invalid('Service method schemas are invalid');
    if (
      !Number.isSafeInteger(method.timeoutMs) ||
      method.timeoutMs < 10 ||
      method.timeoutMs > 120_000
    )
      invalid('Service method timeout is invalid');
  }
  if (typeof contribution.invoke !== 'function') invalid('Service invoke function is required');
}

function jsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, 'utf8') <= 64 * 1024;
  } catch {
    return false;
  }
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function canonicalName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 192 &&
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(value)
  );
}

function invalid(message: string): never {
  throw new ExtensionServiceContributionError('invalid_service', message);
}
