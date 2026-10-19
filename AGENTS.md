# CageUP Repository Instructions

## Current state

- This is a documentation-first scaffold for CageUP; the runtime, Daytona adapter, CageBridge, ZK gateway, and operator console are not implemented yet.
- `PLAN.md` defines the agreed implementation sequence; `docs/architecture.md`, `docs/threat-model.md`, and `docs/demo-script.md` are the current design references.
- Do not claim kernel-level enforcement, universal malware detection, cryptographic zero-knowledge, or host-wide filesystem access. The hackathon target is a Node/TypeScript control plane around an ephemeral Daytona worker.

## Runtime and commands

- Use the pinned Node.js version in `.nvmrc` and the committed npm lockfile; do not rely on globally installed packages.
- `make test` is the canonical offline verification command. It currently validates the documentation scaffold; update it as implementation code is added.
- The intended user entrypoint is `cageup opencode`; keep CLI argument forwarding and provider selection explicit when implementing it.

## Security boundaries

- CageBridge must expose only the selected workspace by default. Never mount or expose the entire Windows filesystem, host credentials, SSH keys, `.env` files, or unrestricted host shell execution.
- ZK Keys are product terminology for boundary credential substitution: the agent receives a run-scoped placeholder, while a trusted egress gateway injects the real credential only for an allowlisted request. Never commit real credentials or log substituted headers.
- Host writes happen only after manifest, SHA-256, protected-zone, and promotion checks. Protected execution surfaces include Git hooks, package lifecycle scripts, shell/PowerShell profiles, CI/CD, build, IDE, MCP, and agent configuration.
- Treat audit hashes as tamper-evident evidence, not proof that a compromised host is impossible to alter.

## Reproducibility

- Keep source files, scripts, runtime configuration, lockfiles, and Docker build inputs inside this repository.
- Use `.env.example` for configuration shape; never commit secrets or machine-specific absolute paths.
- Keep Daytona execution opt-in and provide a local simulator for offline tests.
- Update `README.md` and the relevant design document whenever a command, boundary, or provider behavior changes.

## Verification workflow

- Inspect `git status` and the relevant diff before changing existing work.
- Treat executable scripts and configuration as the source of truth when they conflict with prose.
- Run `make test` after each change and report missing or failing checks explicitly.
