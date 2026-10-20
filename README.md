# CageUP

**CageUP** is a local-first control plane for running autonomous coding agents inside ephemeral Daytona sandboxes without handing them the host filesystem or raw API credentials.

The intended entrypoint is:

```bash
cageup opencode
```

The runtime modules now cover the provider lifecycle, capability-scoped workspace access, boundary credential substitution, evidence, promotion, and rollback. The CLI exposes the operator surface and remains honest when no live run daemon is connected.

> **Project status:** CageUP now has provider-neutral contracts, an offline simulator, an injectable Daytona adapter, CageBridge, ZK egress routing, hash-chained evidence, promotion quarantine/rollback, and an operator CLI. Live Daytona deployment and a persistent run daemon remain opt-in integration work.

## Why CageUP exists

Autonomous coding agents need to run commands, install dependencies, test integrations, and change files. Direct host execution gives an agent access to credentials, local files, processes, and startup surfaces. A wrapper that asks for approval on every action destroys autonomy and encourages approval fatigue.

CageUP uses four boundaries instead:

1. **ZK Key Injection** — the agent receives a credential-shaped placeholder; a trusted egress gateway substitutes the real credential only for an allowlisted request.
2. **Ephemeral execution** — OpenCode runs in a disposable Daytona sandbox rather than directly on the host.
3. **CageBridge capabilities** — the agent sees only the selected workspace and lease-approved operations, not the whole Windows filesystem.
4. **Promotion quarantine** — changed files are hashed and inspected before anything is copied back to the host project.

## Security language

“ZK Keys” is CageUP product terminology. The implementation is boundary credential substitution, not a cryptographic zero-knowledge proof:

- The real credential is held by a trusted egress gateway.
- The agent receives only a run-scoped placeholder.
- The gateway verifies the run, lease, destination, method, and path before injection.
- Substituted headers are never logged or returned to the agent.

The project does not claim universal malware detection, a custom Windows kernel boundary, or absolute protection from a fully compromised host.

## Architecture

```text
                         Operator / CLI
                               |
                               v
                      CageUP control plane
                      Node.js + TypeScript
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
    Policy + leases       ZK egress gateway     Promotion gate
          |                    |                    |
          +--------------------+--------------------+
                               |
                               v
                   Ephemeral Daytona sandbox
                   OpenCode + staged workspace
```

### CageBridge

CageBridge is a capability gateway, not a full filesystem mount. Its default scope is the selected project directory.

Implemented agent-facing operations include:

```text
workspace.list
workspace.read
workspace.write
workspace.diff
promotion.submit
run.status
```

It must never expose the entire Windows filesystem, host credentials, SSH keys, `.env` files, or unrestricted host shell execution.

### Providers

CageUP will use a provider interface so the security logic can be tested without cloud access:

- **Daytona provider:** primary ephemeral execution path for the hackathon demo.
- **Simulator provider:** deterministic local worker for offline tests and development.

## Repository layout

```text
AGENTS.md                 OpenCode session instructions
PLAN.md                   Implementation sequence and acceptance criteria
README.md                 Setup, boundaries, and usage
docs/architecture.md     Component and data-flow design
docs/threat-model.md     Threats, mitigations, and honest limits
docs/demo-script.md       Repeatable hackathon walkthrough
scripts/                  Reproducibility and validation scripts
tests/                    Offline documentation and contract checks
```

## Requirements

The project is pinned to Node.js `22.23.3` in `.nvmrc`.

Required for the documentation scaffold:

- Node.js `22.23.3` or a compatible Node 22 installation.
- npm with the committed lockfile.
- GNU Make for the canonical command.

Daytona execution will additionally require provider credentials and configuration. Do not put those credentials in the repository.

## Quick start

From a clean checkout:

```bash
npm ci
make test
npm run pack:check
```

`make test` is offline and runs the TypeScript build plus the provider, bridge, gateway, evidence, promotion, rollback, and CLI tests. `npm run pack:check` verifies the npm package contents without publishing. No live provider or daemon is required for these checks.

The current operator workflow is:

```bash
cageup doctor
cageup config
cageup policy
cageup opencode -- --model <model>
```

The package smoke check is:

```bash
npm run build
node dist/cli.js doctor
```

All arguments after `--` should be forwarded to OpenCode:

```bash
cageup opencode -- --model <model>
```

## Configuration

Copy the configuration shape without adding secrets:

```bash
cp .env.example .env
```

The simulator should be the safe default. Daytona must be explicitly selected and must fail clearly when required configuration is missing.

Important configuration concepts:

```text
CAGEUP_PROVIDER=simulator|daytona
CAGEUP_WORKSPACE=<selected project directory>
CAGEUP_ZK_GATEWAY_URL=<trusted egress gateway>
DAYTONA_API_URL=<provider endpoint>
DAYTONA_API_TOKEN=<local secret, never committed>
```

## CLI surface

```bash
cageup opencode -- [args...]    # Preserve explicit OpenCode arguments
cageup status                   # Show active run and lease
cageup diff                     # Show staged changes and hashes
cageup review                   # Explain promotion decisions
cageup promote                  # Promote reviewed files only
cageup reject                   # Reject staged changes
cageup revoke                   # Revoke the active lease
cageup rollback                 # Discard the run and restore approved state
cageup policy                   # Inspect the active capability policy
cageup doctor                   # Check local prerequisites

The operator commands return a clear unavailable-state message when no persistent run daemon is connected; they do not fabricate a successful live run.
```

## Demo scenario

The planned demo runs one normal task and one adversarial fixture:

1. `cageup opencode` creates an ephemeral Daytona sandbox.
2. OpenCode receives ZK placeholders, not real API keys.
3. An allowlisted API request succeeds through the gateway.
4. An unapproved destination is blocked.
5. The agent changes application code.
6. A fixture creates a Git hook and a `postinstall` script.
7. CageUP quarantines the protected files before promotion.
8. The operator rejects the promotion.
9. CageUP revokes and destroys the sandbox.
10. The approved host workspace remains unchanged.

The complete walkthrough is in [`docs/demo-script.md`](docs/demo-script.md).

## Security boundaries

### Host boundary

The host should provide only the selected workspace and explicitly granted capabilities. By default, host writes occur only after promotion review.

### Credential boundary

Real credentials belong to the trusted egress gateway. They must not appear in sandbox files, environment variables, stdout, request logs, fixtures, or screenshots.

### Promotion boundary

Protected execution surfaces include Git hooks, package lifecycle scripts, shell and PowerShell profiles, CI/CD, build files, IDE configuration, MCP configuration, and agent configuration.

### Evidence boundary

Hash-chained events are tamper-evident evidence. They are not proof that a compromised host is impossible to alter.

## npm package readiness

The package is configured for a future public npm release:

- command name: `cageup`;
- executable entrypoint: `dist/cli.js` built from `src/cli.ts`;
- package contents are restricted through the `files` allowlist;
- `LICENSE` is included;
- `prepublishOnly` builds and runs the offline checks;
- real provider credentials are not included in the package.

Do not run `npm publish` until the runtime entrypoint is implemented, the package name has been checked on npm, repository metadata has been set, and a release version has been reviewed.

## Documentation

- [`PLAN.md`](PLAN.md) — implementation milestones and acceptance criteria.
- [`docs/architecture.md`](docs/architecture.md) — components, providers, bridge, and data flows.
- [`docs/threat-model.md`](docs/threat-model.md) — threats, mitigations, assumptions, and non-goals.
- [`docs/demo-script.md`](docs/demo-script.md) — repeatable hackathon demonstration.
- [`AGENTS.md`](AGENTS.md) — instructions for future OpenCode sessions.

## Contributing workflow

Before changing existing work:

```bash
git status --short
git diff -- README.md PLAN.md docs/ AGENTS.md
```

After changes:

```bash
make test
```

Keep changes focused, keep provider-specific behavior behind interfaces, and update the relevant documentation whenever a boundary or command changes.
