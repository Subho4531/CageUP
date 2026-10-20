export type GatewayMethod = string;

export type GatewayErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_DESTINATION'
  | 'PLACEHOLDER_UNKNOWN'
  | 'RUN_MISMATCH'
  | 'LEASE_MISMATCH'
  | 'DESTINATION_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'PATH_NOT_ALLOWED'
  | 'CREDENTIAL_RESOLUTION_FAILED'
  | 'CREDENTIAL_INJECTION_FAILED'
  | 'EGRESS_FORWARD_FAILED';

export interface CredentialResolver {
  resolve(credentialName: string): string | undefined | Promise<string | undefined>;
}

export class InMemoryCredentialResolver implements CredentialResolver {
  private readonly credentials: ReadonlyMap<string, string>;

  constructor(credentials: ReadonlyMap<string, string> | Readonly<Record<string, string>>) {
    this.credentials = credentials instanceof Map ? new Map(credentials) : new Map(Object.entries(credentials));
  }

  resolve(credentialName: string): string | undefined {
    return this.credentials.get(credentialName);
  }
}

export interface GatewayRoute {
  readonly runId: string;
  readonly leaseId: string;
  readonly placeholder: string;
  readonly credentialName: string;
  readonly domains: readonly string[];
  readonly methods: readonly GatewayMethod[];
  readonly paths: readonly string[];
  readonly headerName?: string;
  readonly headerPrefix?: string;
}

export interface GatewayRequest {
  readonly runId: string;
  readonly leaseId: string;
  readonly credentialPlaceholder: string;
  readonly url: string;
  readonly method?: GatewayMethod;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
  readonly signal?: AbortSignal;
}

export type GatewayEventType = 'EGRESS_ALLOWED' | 'EGRESS_BLOCKED';

export interface GatewayEvent {
  readonly type: GatewayEventType;
  readonly occurredAt: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly method: string;
  readonly domain: string;
  readonly path: string;
  readonly code?: GatewayErrorCode;
}

export interface GatewayRouteDiagnostics {
  readonly runId: string;
  readonly leaseId: string;
  readonly placeholder: '[REDACTED]';
  readonly credentialName: string;
  readonly domains: readonly string[];
  readonly methods: readonly string[];
  readonly paths: readonly string[];
  readonly headerName: string;
}

export interface GatewayDiagnostics {
  readonly routeCount: number;
  readonly eventCount: number;
  readonly allowedCount: number;
  readonly blockedCount: number;
  readonly routes: readonly GatewayRouteDiagnostics[];
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(`ZK gateway ${code}: ${message}`);
    this.name = 'GatewayError';
    this.code = code;
  }
}

interface NormalizedRoute {
  readonly runId: string;
  readonly leaseId: string;
  readonly placeholder: string;
  readonly credentialName: string;
  readonly domains: readonly string[];
  readonly methods: readonly string[];
  readonly paths: readonly string[];
  readonly headerName: string;
  readonly headerPrefix: string;
}

export interface ZkEgressGatewayOptions {
  readonly credentialResolver: CredentialResolver;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
  readonly onEvent?: (event: GatewayEvent) => void;
}

interface GatewayContext {
  readonly url: URL | undefined;
  readonly domain: string;
  readonly path: string;
}

const errorMessages: Readonly<Record<GatewayErrorCode, string>> = {
  INVALID_REQUEST: 'request fields are invalid',
  INVALID_DESTINATION: 'destination must be an HTTP or HTTPS URL',
  PLACEHOLDER_UNKNOWN: 'credential placeholder is not assigned',
  RUN_MISMATCH: 'credential placeholder is assigned to a different run',
  LEASE_MISMATCH: 'credential placeholder is assigned to a different lease',
  DESTINATION_NOT_ALLOWED: 'destination is not allowed for this route',
  METHOD_NOT_ALLOWED: 'method is not allowed for this route',
  PATH_NOT_ALLOWED: 'path is not allowed for this route',
  CREDENTIAL_RESOLUTION_FAILED: 'credential could not be resolved',
  CREDENTIAL_INJECTION_FAILED: 'credential could not be injected',
  EGRESS_FORWARD_FAILED: 'outbound request failed'
};

function normalizedNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeMethods(methods: readonly GatewayMethod[]): string[] {
  return [...new Set(methods.map((method) => method.trim().toUpperCase()).filter(Boolean))];
}

function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
}

function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path.startsWith('/')))];
}

function routeIsValid(route: NormalizedRoute): boolean {
  return Boolean(
    route.runId &&
      route.leaseId &&
      route.placeholder &&
      route.credentialName &&
      route.domains.length > 0 &&
      route.methods.length > 0 &&
      route.paths.length > 0
  );
}

export class ZkEgressGateway {
  private readonly routes: NormalizedRoute[] = [];
  private readonly recordedEvents: GatewayEvent[] = [];
  private readonly options: {
    readonly credentialResolver: CredentialResolver;
    readonly fetchImpl: typeof fetch;
    readonly clock: () => Date;
    readonly onEvent: ((event: GatewayEvent) => void) | undefined;
  };
  private allowedCount = 0;
  private blockedCount = 0;

  constructor(options: ZkEgressGatewayOptions) {
    this.options = {
      credentialResolver: options.credentialResolver,
      fetchImpl: options.fetchImpl ?? fetch,
      clock: options.clock ?? (() => new Date()),
      onEvent: options.onEvent
    };
  }

  registerRoute(route: GatewayRoute): void {
    const normalized: NormalizedRoute = {
      runId: route.runId.trim(),
      leaseId: route.leaseId.trim(),
      placeholder: route.placeholder.trim(),
      credentialName: route.credentialName.trim(),
      domains: normalizeDomains(route.domains),
      methods: normalizeMethods(route.methods),
      paths: normalizePaths(route.paths),
      headerName: normalizedNonEmpty(route.headerName)?.toLowerCase() ?? 'authorization',
      headerPrefix: route.headerPrefix ?? 'Bearer '
    };

    if (!routeIsValid(normalized)) {
      throw new GatewayError('INVALID_REQUEST', 'route fields are invalid');
    }
    this.routes.push(normalized);
  }

  async forward(request: GatewayRequest): Promise<Response> {
    const method = request.method?.trim().toUpperCase() || 'GET';
    const context = this.destinationContext(request.url, method);

    if (!normalizedNonEmpty(request.runId) || !normalizedNonEmpty(request.leaseId) || !normalizedNonEmpty(request.credentialPlaceholder)) {
      throw this.block(request, context, 'INVALID_REQUEST');
    }

    if (!context.url) {
      throw this.block(request, context, 'INVALID_DESTINATION');
    }
    const url = context.url;

    const placeholderRoutes = this.routes.filter((route) => route.placeholder === request.credentialPlaceholder);
    if (placeholderRoutes.length === 0) {
      throw this.block(request, context, 'PLACEHOLDER_UNKNOWN');
    }

    const runRoutes = placeholderRoutes.filter((route) => route.runId === request.runId);
    if (runRoutes.length === 0) {
      throw this.block(request, context, 'RUN_MISMATCH');
    }

    const leaseRoutes = runRoutes.filter((route) => route.leaseId === request.leaseId);
    if (leaseRoutes.length === 0) {
      throw this.block(request, context, 'LEASE_MISMATCH');
    }

    const destinationRoutes = leaseRoutes.filter((route) => route.domains.includes(url.hostname.toLowerCase()));
    if (destinationRoutes.length === 0) {
      throw this.block(request, context, 'DESTINATION_NOT_ALLOWED');
    }

    const methodRoutes = destinationRoutes.filter((route) => route.methods.includes(method));
    if (methodRoutes.length === 0) {
      throw this.block(request, context, 'METHOD_NOT_ALLOWED');
    }

    const matchingRoutes = methodRoutes.filter((route) => route.paths.includes(url.pathname));
    if (matchingRoutes.length === 0) {
      throw this.block(request, context, 'PATH_NOT_ALLOWED');
    }

    const route = matchingRoutes[0];
    if (!route) {
      throw this.block(request, context, 'PATH_NOT_ALLOWED');
    }

    let credential: string | undefined;
    try {
      credential = await this.options.credentialResolver.resolve(route.credentialName);
    } catch {
      throw this.block(request, context, 'CREDENTIAL_RESOLUTION_FAILED');
    }

    if (!credential) {
      throw this.block(request, context, 'CREDENTIAL_RESOLUTION_FAILED');
    }

    const headers = new Headers(request.headers);
    try {
      headers.set(route.headerName, `${route.headerPrefix}${credential}`);
    } catch {
      throw this.block(request, context, 'CREDENTIAL_INJECTION_FAILED');
    }

    this.emit({
      type: 'EGRESS_ALLOWED',
      occurredAt: this.options.clock().toISOString(),
      runId: request.runId,
      leaseId: request.leaseId,
      method,
      domain: context.url.hostname,
      path: context.url.pathname
    });

    const init: RequestInit = { method, headers };
    if (request.body !== undefined) init.body = request.body;
    if (request.signal !== undefined) init.signal = request.signal;

    try {
      return await this.options.fetchImpl(context.url, init);
    } catch {
      throw new GatewayError('EGRESS_FORWARD_FAILED', errorMessages.EGRESS_FORWARD_FAILED);
    }
  }

  events(): readonly GatewayEvent[] {
    return [...this.recordedEvents];
  }

  diagnostics(): GatewayDiagnostics {
    return {
      routeCount: this.routes.length,
      eventCount: this.recordedEvents.length,
      allowedCount: this.allowedCount,
      blockedCount: this.blockedCount,
      routes: this.routes.map((route) => ({
        runId: route.runId,
        leaseId: route.leaseId,
        placeholder: '[REDACTED]',
        credentialName: route.credentialName,
        domains: [...route.domains],
        methods: [...route.methods],
        paths: [...route.paths],
        headerName: route.headerName
      }))
    };
  }

  private destinationContext(rawUrl: string, _method: string): GatewayContext {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { domain: 'unknown', path: '/', url: undefined };
      }
      return { url, domain: url.hostname, path: url.pathname || '/' };
    } catch {
      return { domain: 'unknown', path: '/', url: undefined };
    }
  }

  private block(
    request: GatewayRequest,
    context: GatewayContext,
    code: GatewayErrorCode
  ): GatewayError {
    this.emit({
      type: 'EGRESS_BLOCKED',
      occurredAt: this.options.clock().toISOString(),
      runId: request.runId || '[unknown]',
      leaseId: request.leaseId || '[unknown]',
      method: request.method?.trim().toUpperCase() || 'GET',
      domain: context.url?.hostname ?? context.domain,
      path: context.url?.pathname || context.path,
      code
    });
    return new GatewayError(code, errorMessages[code]);
  }

  private emit(event: GatewayEvent): void {
    this.recordedEvents.push(event);
    if (event.type === 'EGRESS_ALLOWED') this.allowedCount += 1;
    if (event.type === 'EGRESS_BLOCKED') this.blockedCount += 1;
    this.options.onEvent?.(event);
  }
}
