# Development and release guide

This document covers local validation, package inspection, GitHub Actions, and npm release automation for maintainers.

## Requirements

- Node.js `>= 22.19.0`
- pnpm through Corepack
- A checkout of this repository

## Local workflow

Install with the lockfile:

```powershell
corepack pnpm install --frozen-lockfile
```

Validate JavaScript syntax:

```powershell
corepack pnpm run build
```

Run the full test suite:

```powershell
corepack pnpm test
```

Inspect the package archive:

```powershell
corepack pnpm pack
npm pack --dry-run --json
```

The package has no generated build output. `build` runs `node --check` over `index.js`, `client.js`, and `app.js`.

## GitHub Actions

Three workflows live under `.github/workflows/`.

### Pull request tests

`pr-tests.yml` runs for pull requests targeting `main` when they are opened, reopened, updated, or marked ready for review.

The workflow:

1. Checks out the pull request revision.
2. Installs pnpm 10 and Node.js 22.19.0.
3. Runs `pnpm install --frozen-lockfile`.
4. Runs `pnpm run build`.
5. Runs `pnpm test`.

A per-PR concurrency group cancels obsolete runs after a newer commit arrives.

### Main branch tests

`main-tests.yml` runs for every push to `main`, including direct commits and merged pull requests. It executes the same frozen installation, build validation, and full test suite.

### npm publishing

`npm-publish.yml` runs for pushed tags matching the broad GitHub pattern `v*.*.*`. The job then validates the tag strictly before publishing.

Accepted forms include:

```text
v0.4.0
v0.4.0-rc1
v0.4.0-rc.2
```

The tag without the leading `v` must exactly equal `package.json.version`. A mismatch fails before installation or publication.

| Version | Git tag | npm dist-tag |
|---|---|---|
| `0.4.0-rc1` | `v0.4.0-rc1` | `next` |
| `0.4.0` | `v0.4.0` | `latest` |

Every release tag reruns installation, build validation, and the complete test suite before calling `pnpm publish`.

## Configure npm authentication

Create a GitHub Actions repository secret named `NPM_TOKEN` in the repository where the tag workflow will run:

```powershell
gh secret set NPM_TOKEN --repo OWNER/dsh-synapse
```

The token's npm account must have permission to create or publish the public, unscoped `dsh-synapse` package. The workflow passes the secret to the publish step as `NODE_AUTH_TOKEN`; pull request and ordinary test workflows never receive it.

## Release checklist

1. Confirm the full test suite passes on `main`.
2. Update `package.json.version` to the intended release version.
3. Commit and merge the version change.
4. Create a matching tag on that commit.
5. Push the tag.
6. Confirm the **Publish to npm** workflow passes.
7. Verify the npm dist-tag:
   - prerelease versions use `next`
   - stable versions use `latest`

Example stable release:

```powershell
# package.json already contains 0.4.0
git tag v0.4.0
git push origin v0.4.0
```

Example prerelease:

```powershell
# package.json already contains 0.4.0-rc1
git tag v0.4.0-rc1
git push origin v0.4.0-rc1
```

## Publication failure conditions

The publish job stops without publishing when:

- the tag is not a supported version form;
- the tag and `package.json.version` differ;
- frozen installation fails;
- syntax validation or tests fail;
- `NPM_TOKEN` is missing, expired, or lacks package permissions;
- npm rejects the package name or an already-published version.

## Documentation

- [Chinese user guide](zh-CN/README.md)
- [English user guide](en/README.md)
- [Architecture and runtime boundaries](architecture.md)
- [Project overview](../README.md)
