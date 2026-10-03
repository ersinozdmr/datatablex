# Security policy

## Supported versions

The packages are in `0.x`. Security fixes are released for the latest minor version of each `@datatablex/*` package; older minors do not receive fixes.

| Version              | Supported |
| -------------------- | --------- |
| Latest `0.x` minor   | Yes       |
| Earlier `0.x` minors | No        |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to <https://github.com/ersinozdmr/datatablex/security/advisories/new>.

Do not open a public issue or pull request for a suspected vulnerability.

A useful report includes:

- the affected package and version
- a description of the problem and its impact
- steps to reproduce it, or a minimal proof of concept
- any configuration that is required to trigger it

We aim to acknowledge a report within a week. Once the problem is confirmed, a fix is prepared in a private advisory and released as a patch version, and the advisory is published together with the release.

## Scope

The policy covers the four published packages: `@datatablex/core`, `@datatablex/fastify`, `@datatablex/react` and `@datatablex/antd`. Example applications in this repository are for demonstration and are not meant to be deployed as they are.
