# Changesets

This folder holds the pending release notes. A changeset is a small Markdown file that names the packages a change affects, the kind of release it needs (patch or minor) and a sentence for the changelog.

Add one with `pnpm changeset` in every pull request that changes a published package. For a change that needs no release, such as a test or an internal refactor, add an empty one with `pnpm changeset --empty`.

The four packages are released together and always share one version.
