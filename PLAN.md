# CageUP Implementation Plan

## Status

**Current phase:** documentation and reproducibility scaffold.

The repository currently defines the product boundary and demo contract. Runtime code is intentionally not started until the control-plane interfaces and security assumptions are agreed.

## Product goal

CageUP is a Node/TypeScript CLI and control plane for running OpenCode inside an ephemeral Daytona sandbox while exposing only a capability-scoped project workspace.

The primary command is:

```bash
cageup opencode
```

The agent should be able to work autonomously inside its lease, call approved APIs through ZK Key Injection, and submit changes for promotion without receiving raw credentials or unrestricted host access.

## Hackathon promise

> CageUP gives an autonomous coding agent a disposable workspace, boundary-injected credentials, and a promotion gate that keeps dangerous execution surfaces out of the host project.

## Core flow

1. Detect the selected project workspace.
2. Build a baseline file manifest and exclude secrets.
3. Create an ephemeral Daytona sandbox.
4. Start CageBridge with a run-scoped capability lease.
5. Launch OpenCode inside the sandbox and forward its arguments.
6. Route approved API calls through the ZK egress gateway.
7. Collect changed files, hashes, and runtime evidence.
8. Quarantine protected or suspicious changes.
9. Promote only reviewed files back to the host.
10. Revoke and destroy the sandbox on rollback or policy violation.

## Components

### `cageup-cli`

The user-facing command-line wrapper. It owns command parsing, workspace detection, provider selection, terminal output, and OpenCode argument forwarding.

### Control plane

Owns run lifecycle, policy evaluation, leases, event collection, promotion state, and rollback decisions.

### CageBridge

The bridge is a capability gateway, not a drive mount. It exposes workspace-scoped MCP tools and a separate policy API. The default scope is the selected project directory only.

### Daytona provider

Creates, initializes, executes, collects, and destroys ephemeral Daytona sandboxes. It is the primary demo provider.

### Simulator provider

Implements the same provider interface locally so core behavior and tests work without Daytona credentials or network access.

### ZK egress gateway

Maps run-scoped placeholder keys to real credentials at an approved network boundary. It validates run identity, lease state, destination, method, and path before injecting a secret.

### Promotion scanner

Compares manifests, computes SHA-256 hashes, classifies protected zones, inspects scripts, and produces `allow`, `quarantine`, or `deny` decisions.

### Evidence log

Stores redacted, hash-chained run events such as lease grants, ZK requests, blocked egress, quarantine, promotion, revocation, and rollback.

## Milestones

### 1. Contracts and configuration

- Define run, lease, provider, bridge, ZK route, manifest, promotion, and event types.
- Add configuration validation and provider selection.
- Preserve the pinned Node.js runtime and lockfile.

**Exit condition:** all packages can import shared contracts without provider-specific types leaking into core policy code.

### 2. Local simulator

- Run a deterministic fixture in a disposable local workspace.
- Produce the same lifecycle events expected from Daytona.
- Exercise command forwarding, workspace collection, and destruction.

**Exit condition:** the complete happy path works offline.

### 3. ZK Key Injection

- Provide run-scoped placeholder keys to the sandbox.
- Implement an allowlisted egress gateway.
- Substitute real credentials only on matching routes.
- Redact credentials from logs and errors.
- Add blocked-destination and wrong-route tests.

**Exit condition:** a fixture can call an approved test API without the real key appearing in its environment, files, stdout, or evidence log.

### 4. CageBridge

- Implement workspace list/read/write/diff operations.
- Normalize paths and prevent traversal or symlink escapes.
- Enforce lease scope and expiry.
- Expose the agent-facing surface through MCP.
- Keep lifecycle and policy actions on the control API.

**Exit condition:** the fixture cannot read outside the selected workspace or execute a host shell command.

### 5. Promotion and rollback

- Generate baseline and result manifests.
- Hash changed files.
- Detect protected paths and lifecycle scripts.
- Stage output outside the host workspace.
- Promote only reviewed files.
- Destroy the sandbox and preserve the last approved state on rollback.

**Exit condition:** a fixture that creates a Git hook or `postinstall` script is quarantined and cannot modify the host project automatically.

### 6. Daytona adapter

- Implement real sandbox creation and teardown.
- Upload the sanitized workspace.
- Inject placeholders only.
- Run OpenCode in the sandbox.
- Collect output and evidence.

**Exit condition:** the same contract-level scenario can run with Daytona by configuration, with remote-workspace behavior documented.

### 7. Operator experience

- Add `status`, `diff`, `review`, `promote`, `revoke`, `rollback`, `policy`, and `doctor` commands.
- Add a lightweight local console only if CLI evidence is insufficient for the demo.
- Make ZK injection, quarantine, lease, and rollback states obvious.

**Exit condition:** the demo can be run from a clean checkout using the documented commands.

## Security acceptance criteria

- The agent receives only placeholders, never real credentials.
- Unapproved destinations cannot receive injected credentials.
- The agent sees only the selected workspace by default.
- Host writes are staged until promotion review.
- Protected execution surfaces are quarantined.
- Every promotion decision includes file hashes and a reason.
- Revocation destroys the ephemeral worker and preserves the approved host state.
- Logs never contain raw secrets.

## Explicit non-goals

- A Windows kernel driver or custom kernel security boundary.
- Guaranteed detection of every dormant trojan.
- Full host filesystem exposure.
- Unrestricted host process control.
- Cryptographic zero-knowledge proofs.
- Claiming that a hash chain makes a compromised host tamper-proof.

## Verification

The canonical local check is:

```bash
make test
```

Core tests must remain offline. Daytona integration checks are opt-in and must fail clearly when credentials or provider configuration are missing; they must not silently fall back while claiming to have tested Daytona.
