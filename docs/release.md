# Releasing Motel

Motel uses Tegami for changelogs, versioning, npm publication, Git tags, and GitHub Releases. The
default release path runs from the `dev` branch through GitHub Actions and npm trusted publishing.

## Queue a change

Run `bun run tegami` to create a file under `.tegami/`, or write one directly:

```md
---
packages:
  "@aryasaatvik/motel": minor
---

## Describe the change

Describe the user-visible result.
```

Commit the changelog entry with the implementation that it describes.

## Prepare a version pull request

Start from a clean, current `dev` branch with GitHub CLI authentication:

```sh
bun install --frozen-lockfile
GH_TOKEN="$(gh auth token)" bun run version:packages
```

Tegami consumes the pending changelog entries, updates `package.json` and `CHANGELOG.md`, writes its
publish lock, pushes `tegami/version-packages`, and opens or updates a pull request against `dev`.
Review and merge that pull request before publishing.

## Publish

After the version pull request is merged, the `publish.yml` workflow runs from the clean merged
`dev` branch. It installs dependencies, runs the complete release checks, and then runs:

```sh
bun run release:check && bun run tegami ci
```

The workflow grants GitHub's OIDC token to npm and has no `NPM_TOKEN` secret. Tegami uses npm to
publish the package, creates and pushes the `v<version>` Git tag, and creates the matching GitHub
Release.

The npm trusted publisher must be configured as:

- Repository: `aryasaatvik/motel`
- Workflow filename: `publish.yml`
- Environment: blank
- Publishing method: npm publish only

Verify the result:

```sh
npm view @aryasaatvik/motel version
npm view @aryasaatvik/motel dist-tags --json
gh release view "v$(bun -e 'console.log(require("./package.json").version)')"
```

Do not merge a version pull request or rerun a partially completed workflow without first checking
the npm version, Git tag, GitHub Release, and Tegami publish status.

Publishing does not install or restart the machine-global Motel service. The maintained checkout and
LaunchAgent cutover are separate, explicitly attended operations.
