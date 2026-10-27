# Code signing policy

This page says how the Windows installer of Kadhai is signed, who may change the code that goes into it, and who approves each signed release.

## Status

Kadhai has applied to the SignPath Foundation for free code signing. Until that is in place, the installers on the [releases page](https://github.com/Madhuhas/kadhai/releases) are **not signed**, and Windows SmartScreen may show "Windows protected your PC" (choose *More info*, then *Run anyway*). Versions up to and including 1.0.0 beta 2 are unsigned. This page will say from which version on the installers are signed.

Signed releases: Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

Only files built from this repository's own source code:

- the Windows installer, `Kadhai-Beta-Setup-<version>.exe` (or `Kadhai-Setup-<version>.exe` after the beta), made by electron-builder;
- the Kadhai program inside it.

Each one is built by the [Desktop build](../.github/workflows/desktop.yml) workflow on GitHub Actions, from the tagged commit of the release, never on a personal computer. Every signed file carries the product name Kadhai and the release's version. Libraries made by other projects (Electron, Express and what they use) are not signed by Kadhai.

## Team roles

| Role | Who | What the role allows |
| --- | --- | --- |
| Authors (committers) | [Madhuhas](https://github.com/Madhuhas) | Change the source code without further review |
| Reviewers | [Madhuhas](https://github.com/Madhuhas) | Review and accept pull requests from everyone else |
| Approvers | [Madhuhas](https://github.com/Madhuhas) | Approve each signing request |

Only the people in this table have write access to the repository; this page is updated whenever that changes. Changes from anyone outside the team come as pull requests, are reviewed by a reviewer before they are merged, and need a signed [contributor agreement](../CLA.md). The `main` branch is protected. Every member of the team uses multi-factor authentication for GitHub and for SignPath.

Every signing request is approved by hand, one release at a time.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Kadhai has no telemetry: it contacts only the AI providers, services and addresses the user sets up. [Privacy](PRIVACY.md) lists everything that can leave the computer, when, and to whom.

## Reporting a problem

If you think a signed Kadhai file was misused, or was not built from this repository, please [report it privately](https://github.com/Madhuhas/kadhai/security/advisories/new) (see [SECURITY.md](../SECURITY.md)).
