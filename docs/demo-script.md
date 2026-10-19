# CageUP Hackathon Demo Script

## Demo claim

> CageUP lets an autonomous coding agent use a real approved API and modify a project inside an ephemeral sandbox, while keeping raw credentials and host auto-execution surfaces outside the agent's reach.

## Preparation

1. Start from a clean project workspace.
2. Configure the simulator or Daytona provider explicitly.
3. Configure a test-only credential in the trusted ZK gateway.
4. Verify that the credential is not present in the workspace or agent environment.
5. Prepare two deterministic fixtures:
   - a normal coding task;
   - a safe dormant-payload simulation.

Never use production credentials in the demo.

## Act 1: Start a governed run

Run:

```bash
cageup opencode
```

Show:

```text
Provider: Daytona
Run: run_...
Lease: active
Workspace: selected project only
ZK keys: placeholders only
Host writes: disabled until promotion
```

Explain that OpenCode is running in the ephemeral worker and that the host project is still unchanged.

## Act 2: Use an approved API

Ask the agent to run the integration fixture.

Show the agent-side environment:

```text
OPENAI_API_KEY=zk_openai_run_...
```

Explain that this is a placeholder, not a usable production credential.

Show the gateway event:

```text
run: run_...
destination: api.example.test
route: allowed
credential: injected at boundary
raw credential logged: no
```

The test API should return a normal successful response.

## Act 3: Block exfiltration

Run the fixture that attempts to send data to an unapproved destination.

Expected result:

```text
destination: attacker.example.test
decision: denied
reason: domain not in lease
credential injected: no
```

Do not use a real attacker endpoint. Use a local simulator or controlled test domain.

## Act 4: Detect a dormant payload

The fixture creates:

```text
.git/hooks/pre-commit
package.json with a postinstall script
MCP configuration change
```

Run:

```bash
cageup diff
cageup review
```

Show that the files are quarantined with:

- relative path;
- SHA-256 hash;
- protected-zone classification;
- reason for quarantine;
- promotion decision.

## Act 5: Reject and rollback

Reject the promotion:

```bash
cageup reject
cageup revoke
cageup rollback
```

Show:

```text
Lease: revoked
Sandbox: destroyed
Host project: unchanged
Rollback: completed
```

Explain that unapproved sandbox output was discarded and the last approved host state was preserved.

## Closing message

The demo proves four bounded capabilities:

1. ZK Key Injection enables API access without exposing raw credentials.
2. Daytona provides disposable agent execution.
3. Capability leases avoid approval fatigue inside a defined boundary.
4. Promotion quarantine prevents known auto-execution surfaces from crossing back to the host automatically.

Do not claim that the demo detects every malware sample or creates a custom Windows kernel boundary.
