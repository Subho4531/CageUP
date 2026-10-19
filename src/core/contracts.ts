export type ProviderName = 'simulator' | 'daytona';

export type LeaseOperation =
  | 'workspace.list'
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.stat'
  | 'workspace.diff'
  | 'promotion.submit'
  | 'run.status';

export type Decision = 'allow' | 'quarantine' | 'deny';

export interface RunSpec {
  readonly workspaceRoot: string;
  readonly provider: ProviderName;
  readonly command: string;
  readonly commandArgs: readonly string[];
}

export interface SandboxHandle {
  readonly provider: ProviderName;
  readonly id: string;
  readonly createdAt: string;
}

export interface CapabilityLease {
  readonly id: string;
  readonly runId: string;
  readonly sandboxId: string;
  readonly workspaceRoot: string;
  readonly operations: readonly LeaseOperation[];
  readonly allowedDomains: readonly string[];
  readonly expiresAt: string;
  readonly policyHash: string;
}

export interface ZkRoute {
  readonly placeholder: string;
  readonly credentialName: string;
  readonly domains: readonly string[];
  readonly methods: readonly string[];
  readonly paths: readonly string[];
}

export interface FileManifestEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly sha256?: string;
}

export interface WorkspaceManifest {
  readonly root: string;
  readonly createdAt: string;
  readonly entries: readonly FileManifestEntry[];
  readonly hash: string;
}

export interface PromotionDecision {
  readonly path: string;
  readonly decision: Decision;
  readonly reasons: readonly string[];
  readonly sha256?: string;
}

export type RuntimeEventType =
  | 'RUN_CREATED'
  | 'SANDBOX_CREATED'
  | 'LEASE_GRANTED'
  | 'ZK_ROUTE_ASSIGNED'
  | 'EGRESS_ALLOWED'
  | 'EGRESS_BLOCKED'
  | 'FILE_CHANGED'
  | 'FILE_QUARANTINED'
  | 'PROMOTION_BLOCKED'
  | 'LEASE_REVOKED'
  | 'ROLLBACK_COMPLETED'
  | 'SANDBOX_DESTROYED';

export interface RuntimeEvent {
  readonly id: string;
  readonly type: RuntimeEventType;
  readonly runId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  readonly previousHash: string | null;
  readonly hash: string;
}

export interface CageUpConfig {
  readonly provider: ProviderName;
  readonly workspace: string;
  readonly zkGatewayUrl: string;
  readonly logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  readonly daytonaApiUrl?: string;
  readonly daytonaApiToken?: string;
}

export interface SandboxProvider {
  createRun(spec: RunSpec): Promise<SandboxHandle>;
  uploadWorkspace(handle: SandboxHandle, source: string): Promise<void>;
  execute(handle: SandboxHandle, command: string, args: readonly string[]): AsyncIterable<RuntimeEvent>;
  collectWorkspace(handle: SandboxHandle): Promise<WorkspaceManifest>;
  destroy(handle: SandboxHandle): Promise<void>;
}
