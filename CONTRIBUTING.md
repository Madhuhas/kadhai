# Contributing to Kadhai

Thank you for helping. A few things to know before you send a change.

## Sign the contributor agreement once

Before your first pull request can be merged, please sign the [Contributor License Agreement](CLA.md). It is short and in plain English. You keep the copyright in your work; you give the project a licence to use it; and the project promises that your contribution will always stay available under an open-source licence (today the GNU AGPL-3.0). It covers everything you contribute afterwards.

To sign, post this comment on your first pull request:

> I have read the CLA Document and I hereby sign the CLA

## Do not copy code or artwork

Write your change yourself. Do not paste code, icons, images or text from other projects, products or websites, even with changes, unless its licence clearly allows it and you say where it came from in the pull request. Code written by an AI assistant is welcome if you have read it, understand it and can stand behind it.

## Before you send a change

- Read [docs/DEVELOPERS.md](docs/DEVELOPERS.md): how Kadhai is built and the rules that keep it safe (the hard constraints come first).
- Keep the constraints: free to run, one dependency, no build step, local only, no emoji or images in the interface.
- Run `npm test`. Add a test for new behaviour. The same tests run automatically on every pull request, on Windows and Linux, and must pass before it is merged.
- For a change to the interface, try it with `npm run demo` and check it at a phone's width.
- Never commit keys, tokens or the files that hold them (`.env`, `*.local.json`, `secret.local.key`).

## Reporting a security problem

Please do not open a public issue. Contact the maintainer privately first, so it can be fixed before it is known.
