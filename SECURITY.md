# Security

Kadhai runs AI agents that read and write files and can run commands on your computer, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately instead:

1. Open the [Security tab](https://github.com/Madhuhas/kadhai/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker could do with it.

Only the maintainer sees the report. You will get a first answer within a week. Once a fix is released, the advisory is published, with credit to you if you want it.

## What is in scope

Anything that breaks a promise Kadhai makes, for example:

- the server answering another machine or another website (it should accept only `localhost`),
- the crew reading or writing outside its folder, or into `.git` or `memory.md`,
- a command running without approval while commands are set to *ask*,
- an API key, token or credential leaving the server, appearing in a log, or being saved unencrypted,
- a page the crew built reaching the dashboard's controls,
- a flow, trigger, connection or the desktop app getting around any of the above.

## What is not a vulnerability

These are documented limits, not bugs (see *Safety and privacy* in the [user guide](docs/USER-GUIDE.md)):

- A command you approved runs with your account's permissions unless you turn on the Docker sandbox.
- Prompts go to the model providers you added keys for.
- On high flame, a subscription CLI you allowed to run commands for one task runs them outside Kadhai's approval.

## Supported versions

Kadhai is in beta. Fixes go into the latest version only.
