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

## Publishing a prerelease

An InvokeSmith maintainer must have two-factor authentication enabled on npm. Prefer npm trusted publishing from this GitHub repository so releases can use short-lived identity rather than a long-lived automation token and receive automatic provenance.

Until trusted publishing is configured, publication is intentionally manual and must be run only after the release commit and tag are reviewed:

```sh
npm publish --access public --tag next
```

Local publication cannot produce npm provenance; do not pass `--provenance` outside a supported cloud CI/CD runner. Use the `next` distribution tag for alpha releases. npm may also initialize `latest` to the only available version when a package is published for the first time; move `latest` to the first stable release as soon as one exists.

After publication, verify the consumer path from outside the repository:

```sh
npx invokesmith@next --version
npx invokesmith@next --help
```

Publishing is irreversible for a given name and version. Never publish from the private technology workspace; publish only from the sanitized public repository.
