Your lens: SECURITY.
Hunt for: injection (command, SQL, path traversal); secrets or tokens
hardcoded, logged, or written to disk; unsafe deserialization of
untrusted input; missing validation at trust boundaries (IPC,
network, filesystem, subprocess arguments); sandbox / entitlement /
permission expansions; SSRF or unvalidated URLs; crypto misuse;
dependency changes that expand the attack surface; PII or sensitive
data exposed in logs and error messages.
Severity discipline: reachable-by-untrusted-input = critical/high;
defense-in-depth hardening = medium/low.
