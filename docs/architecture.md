# CageUP Architecture

## Scope

CageUP is a Node/TypeScript control plane around an ephemeral Daytona worker. The control plane owns lifecycle, capability policy, ZK Key routing, evidence, and promotion. Daytona supplies the primary disposable execution boundary.

The project does not currently implement a Windows kernel driver or claim to replace the isolation guarantees of the provider.

## Runtime topology

```text
Developer terminal
        |
        v
  cageup opencode
        |
        v
  CageUP CLI
        |
        +------------------------------+
        |                              |
        v                              v
 Control plane                 Local evidence store
        |
        +-------------------+--------------------+
        |                   |                    |
        v                   v                    v
 Policy / leases      ZK egress gateway    Promotion gate
        |                   |                    |
        +-------------------+--------------------+
                            |
                            v
                 Daytona ephemeral sandbox
                 OpenCode + staged workspace
```

## Run lifecycle

1. The CLI resolves the selected project directory.
2. The control plane creates a run ID and baseline manifest.
3. Sensitive paths are excluded from the staged workspace.
4. A Daytona sandbox is created.
5. The workspace is uploaded to a sandbox path such as `/workspace/project`.
6. A run-scoped capability lease and ZK placeholders are created.
7. OpenCode starts inside the sandbox; CLI arguments are forwarded explicitly.
8. Runtime, network, and workspace events are recorded in redacted form.
9. The sandbox output is collected and compared with the baseline manifest.
10. The promotion scanner produces `allow`, `quarantine`, or `deny` decisions.
11. Only reviewed files are promoted to the host.
12. The sandbox is destroyed; rollback discards unapproved output.

## CageBridge

CageBridge is a capability gateway, not an unrestricted host filesystem mount. The agent-facing surface is intended to be exposed through MCP. Lifecycle and policy actions remain on the control API.

### Default operations

```text
workspace.list
workspace.read
workspace.write
workspace.stat
workspace.diff
promotion.submit
run.status
```

### Required checks

- Normalize every path relative to the lease workspace root.
- Reject absolute paths outside the root.
- Reject traversal and symlink escapes.
- Enforce read/write operation grants.
- Enforce lease expiry and revocation.
- Do not expose raw environment variables.
- Do not expose arbitrary host shell execution.
- Keep host promotion separate from sandbox writes.

For a remote Daytona worker, the bridge should use an authenticated connector or relay. A Windows drive share must not be used as a shortcut around policy.

## Capability leases

A lease binds a run to a sandbox, workspace, operation set, domain set, and expiration:

```json
{
  "runId": "run_8f21",
  "sandboxId": "daytona_4921",
  "workspaceRoot": "/workspace/project",
  "operations": ["workspace.read", "workspace.write", "promotion.submit"],
  "allowedDomains": ["api.openai.com", "api.stripe.com"],
  "expiresAt": "2026-10-19T18:00:00Z",
  "policyHash": "sha256:..."
}
```

The policy engine should produce a decision event for every denied action. Origin-scoped autonomy means the agent can act without repeated prompts inside this lease; it does not mean the agent receives broad host privileges.

## ZK Key Injection

ZK Keys are a product term for run-scoped credential placeholders. They are not cryptographic zero-knowledge proofs.

```text
Agent request with placeholder
        |
        v
Trusted ZK egress gateway
  - validate run and lease
  - validate domain, method, and path
  - map placeholder to secret
  - inject upstream credential
  - redact logs
        |
        v
Approved API
```

The gateway must reject an approved placeholder used against an unapproved destination. It must not perform unrestricted string replacement or log the substituted request.

The first implementation should use an explicit gateway endpoint or proxy contract. A normal end-to-end HTTPS request cannot be modified by a proxy without a deliberate termination and re-encryption design.

## Workspace manifests and promotion

The host workspace is treated as approved state. The sandbox receives a staged copy. A manifest records relative path, type, size, and SHA-256.

Promotion steps:

1. Collect sandbox output outside the host workspace.
2. Recompute the manifest.
3. Compare added, changed, deleted, and renamed files.
4. Classify protected paths.
5. Inspect package lifecycle and command content.
6. Produce a reasoned decision per file.
7. Promote only approved files atomically.

Protected zones include Git hooks, package lifecycle scripts, shell and PowerShell profiles, CI/CD workflows, build files, `.env` and credential files, IDE settings, MCP configuration, and agent configuration.

## Evidence

Events should be append-only records containing run ID, sandbox ID, lease ID, timestamp, event type, redacted payload, and previous event hash. The current event hash is derived from the previous hash and canonical event payload.

This makes changes to the local evidence stream detectable. It is tamper-evident evidence, not a guarantee against a host that is already fully compromised.

## Provider interface

Core policy code must depend on a provider interface rather than Daytona-specific calls:

```ts
interface SandboxProvider {
  createRun(spec: RunSpec): Promise<SandboxHandle>;
  uploadWorkspace(handle: SandboxHandle, source: string): Promise<void>;
  execute(handle: SandboxHandle, command: string): AsyncIterable<RuntimeEvent>;
  collectWorkspace(handle: SandboxHandle): Promise<WorkspaceArchive>;
  destroy(handle: SandboxHandle): Promise<void>;
}
```

The simulator implements this contract locally for offline checks. The Daytona implementation is opt-in and must report missing configuration instead of silently pretending to have run in Daytona.

## Planned package boundaries

```text
apps/cageup-cli
apps/control-plane
packages/core
packages/policy-engine
packages/cagebridge
packages/daytona-provider
packages/simulator-provider
packages/zk-egress-gateway
packages/workspace-manifest
packages/promotion-scanner
packages/evidence-log
```
