# Publishing InvokeSmith

The public npm artifact is the `invokesmith` CLI package. It contains one self-contained Node.js executable plus the README, license, and notice. Workspace source, tests, internal state, GitHub configuration, and development dependencies are deliberately excluded.

## Release preflight

From a clean checkout:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run package:check
```

`package:check` is the authoritative packaging check. It builds the CLI, creates the npm tarball, rejects unexpected files, installs the tarball into an isolated temporary project, checks the reported version, and validates a real action contract using Node.js.

Inspect the public contents before any release:

```sh
npm pack --dry-run --ignore-scripts
```

## Versioning

InvokeSmith follows semantic versioning for the CLI package. During the developer preview, releases use an `alpha` prerelease such as `0.1.0-alpha.1`. The action-contract API remains separately versioned as `invokesmith.dev/v0alpha1`; a package release does not imply that the contract format is stable.

The CLI reads its version from the root `package.json`, so `invokesmith --version` and the npm artifact cannot drift when the normal build runs.

## First publication

Before publishing, an InvokeSmith maintainer must own or create the `invokesmith` package on npm and enable two-factor authentication. Prefer npm trusted publishing from this GitHub repository so releases can use short-lived identity rather than a long-lived automation token.

Until trusted publishing is configured, publication is intentionally manual and must be run only after the release commit and tag are reviewed:

```sh
npm publish --access public --provenance --tag next
```

Use the `next` distribution tag for alpha releases. Do not move `latest` to an alpha release. After publication, verify the consumer path from outside the repository:

```sh
npx invokesmith@next --version
npx invokesmith@next --help
```

Publishing is irreversible for a given name and version. Never publish from the private technology workspace; publish only from the sanitized public repository.
