# Security Policy

## Supported Versions

Photon is developed on `main`. Security fixes are applied to `main` and shipped
in the next release. Older releases are not patched separately.

## Reporting a Vulnerability

Please do **not** open a public issue, pull request, or discussion for a
security vulnerability.

Report it privately through GitHub instead: open the repository's **Security**
tab and choose **Report a vulnerability**. If private reporting is unavailable
to you, contact a maintainer privately through the `quantum-box` GitHub
organization.

Please include:

- What the issue is and why it is a security problem
- The affected component (client, engine, server, worker, or desktop shell)
- Steps to reproduce, or a proof of concept
- The version or commit you tested

## What to Expect

- We aim to acknowledge a report within a few business days.
- We will tell you whether we consider the report in scope, and what we plan to
  do about it.
- We will let you know when a fix is released, and credit you if you want to be
  credited.

Please give us a reasonable opportunity to release a fix before disclosing the
issue publicly.

## Scope

In scope: this repository's source code, its published packages, and the
example server and worker deployments it contains.

Out of scope: findings that require a compromised device or account, issues in
third-party dependencies that already have a public advisory (report those
upstream), and Quantum Box production services that are not built from this
repository.
