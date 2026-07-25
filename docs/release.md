# Releasing Motel

Motel uses Tegami for changelogs, versioning, npm publication, Git tags, and GitHub Releases. Releases
are run from an attended local session; GitHub Actions only validates pull requests.

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

From the clean, current merged `dev` branch, authenticate npm interactively if needed, then run:

```sh
npm whoami
GH_TOKEN="$(gh auth token)" bun run release
```

`bun run release` runs the complete release checks before Tegami publishes the package through Bun,
creates and pushes the `v<version>` Git tag, and creates the matching GitHub Release. For the first
owned release, confirm npm creates `@aryasaatvik/motel` as a public package.

Verify the result:

```sh
npm view @aryasaatvik/motel version
npm view @aryasaatvik/motel dist-tags --json
gh release view "v$(bun -e 'console.log(require("./package.json").version)')"
```

Do not publish from a dirty worktree or rerun a partially completed release without first checking
the npm version, Git tag, GitHub Release, and Tegami publish status.

Publishing does not install or restart the machine-global Motel service. The maintained checkout and
LaunchAgent cutover are separate, explicitly attended operations.
