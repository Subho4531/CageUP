# CageUP Threat Model

## Security objective

Allow an autonomous agent to perform useful coding work while reducing the chance that untrusted instructions, dependencies, or generated code can access host credentials, unrelated files, or host auto-execution surfaces.

## Assets

- Host source code outside the selected project.
- API keys and other credentials.
- SSH keys and cloud credentials.
- Git hooks and package lifecycle scripts.
- Shell and PowerShell profiles.
- CI/CD, build, IDE, MCP, and agent configuration.
- Approved workspace state.
- Runtime and promotion evidence.

## Trust boundaries

### Trusted components

- The developer-controlled CageUP control plane.
- The trusted ZK egress gateway and its credential store.
- The host promotion gate.
- The Daytona provider boundary, subject to provider assumptions.

### Untrusted components

- The agent prompt and generated instructions.
- Agent-created code.
- Packages installed or executed by the agent.
- Files and commands inside the sandbox.
- Remote API responses.
- Any workspace output before promotion review.

## Threats and mitigations

### Credential theft

**Threat:** The agent reads environment variables, files, logs, or command history to steal a real credential.

**Mitigations:**

- Give the agent only ZK placeholders.
- Keep real credentials in the trusted gateway.
- Exclude `.env`, credential files, and host profiles from the staged workspace.
- Redact gateway headers and error output.
- Bind injection to a run, lease, domain, method, and path.

**Limit:** The gateway still handles the real secret. This is boundary secrecy, not cryptographic zero-knowledge.

### Credential forwarding abuse

**Threat:** The agent sends a placeholder to an attacker-controlled destination and causes the gateway to inject the real key.

**Mitigations:**

- Strict destination allowlists.
- Method and path allowlists.
- Run-scoped placeholder mapping.
- Request size and rate limits.
- No arbitrary forwarding or unrestricted CONNECT behavior.

### Host filesystem escape

**Threat:** The agent reads or writes outside the selected project workspace.

**Mitigations:**

- Stage only the selected workspace.
- Make CageBridge path-rooted and lease-scoped.
- Reject absolute paths, traversal, and symlink escapes.
- Do not expose a Windows drive share.
- Do not expose unrestricted host shell execution.

### Dormant promotion payload

**Threat:** The agent remains quiet in the sandbox but plants a payload in a hook, lifecycle script, profile, build file, CI workflow, or MCP configuration.

**Mitigations:**

- Keep host writes behind promotion review.
- Hash every changed file.
- Quarantine protected execution surfaces.
- Inspect package lifecycle scripts and suspicious command patterns.
- Keep rejected files outside the host workspace.

**Limit:** Static scanning cannot prove that code is malware-free.

### TOCTOU and mutable paths

**Threat:** A file or process changes between inspection and action.

**Mitigations:**

- Use run and sandbox IDs rather than trusting PIDs alone.
- Hash files immediately before promotion.
- Revalidate the staged source and destination.
- Promote from a controlled staging area.
- Make the evidence record include creation time and content hash.

**Limit:** A Node/TypeScript proof does not provide complete kernel-level TOCTOU elimination.

### Malicious API response

**Threat:** An approved external API returns content that instructs the agent to perform an unsafe action.

**Mitigations:**

- Treat API responses as untrusted input.
- Keep lease and promotion controls independent of agent output.
- Preserve protected-zone checks even for agent-requested files.

### Evidence tampering

**Threat:** A compromised process alters local logs to hide an action.

**Mitigations:**

- Use hash-chained events.
- Redact secrets at event creation.
- Record policy decisions before promotion.
- Optionally export signed summaries after a run.

**Limit:** Local hash chains are tamper-evident, not immutable against a fully compromised host.

## Out of scope for the hackathon

- Custom Windows kernel drivers.
- Universal malware classification.
- Full host filesystem or process management.
- Protection from a malicious Daytona provider.
- Cryptographic zero-knowledge proofs.
- Automatic approval of protected execution surfaces.

## Assumptions

- Daytona provides the primary sandbox lifecycle.
- The developer explicitly opts into remote workspace execution.
- The ZK gateway is trusted and separately protected.
- The host project is unchanged until promotion.
- Provider credentials are supplied out of band and never committed.
