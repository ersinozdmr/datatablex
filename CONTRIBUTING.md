# Contributing

Thanks for your interest in DataTableX. This guide covers how to set the project up, what a pull request should contain and the conventions the codebase follows.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

You need Node 22 (see `.nvmrc`) and pnpm. The pnpm version is pinned in `package.json`; Corepack picks it up:

```sh
corepack enable
pnpm install
```

The repository is a pnpm workspace driven by Turborepo. Published packages live in `packages/`, and applications that are not published live in `apps/`.

## Commands

Run these from the repository root:

| Command               | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm build`          | Builds every package                                    |
| `pnpm typecheck`      | Type-checks every package                               |
| `pnpm lint`           | Lints every package                                     |
| `pnpm test`           | Runs the unit tests                                     |
| `pnpm check`          | Runs typecheck, lint and test                           |
| `pnpm check:language` | Checks that Turkish text stays in the allowlisted files |
| `pnpm size`           | Checks the gzip size of each build against its budget   |
| `pnpm smoke`          | Installs the packed packages into clean projects        |

`pnpm size` and `pnpm smoke` need a build first (`pnpm build`). The smoke test also type-checks the code examples of the root `README.md`, so an example that no longer matches the API fails there.

CI runs the same checks on every pull request.

## End-to-end tests

The end-to-end tests drive the [example application](apps/example) in a real browser against a real PostgreSQL database. Docker provides the database:

```sh
pnpm build
pnpm --filter example db:up              # starts PostgreSQL on port 55432
cp apps/example/.env.example apps/example/.env
pnpm --filter example playwright:install # once, downloads the browser
pnpm --filter example test:e2e           # migrates, seeds, builds the client and runs Playwright
```

`test:e2e` re-creates the example data on every run. The example application uses the built output of the packages, so rebuild (`pnpm build`) after changing a package.

## Pull requests

1. Create a branch from `main`.
2. Make the change, with tests that cover it.
3. Add a changeset if you changed a published package (see below).
4. Run `pnpm check` and `pnpm check:language`.
5. Open a pull request against `main` and fill in the template.

Keep a pull request focused on one change. A bug fix comes with a test that fails without the fix. A change to behavior or to the public API updates the documentation in the same pull request.

For a larger change, open an issue first so the approach can be agreed before you write the code.

## Changesets

Releases are managed with [Changesets](https://github.com/changesets/changesets). A pull request that changes a published package (`packages/*`) carries a changeset:

```sh
pnpm changeset
```

Pick the packages the change affects and the kind of release: `patch` for a fix, `minor` for a new feature or a breaking change while the packages are in `0.x` (see [STABILITY.md](STABILITY.md)). Write one sentence for the changelog, addressed to someone who uses the package. For a change that needs no release, such as a test or an internal refactor, run `pnpm changeset --empty`. CI fails a pull request that changes a package without a changeset.

The four packages are released together and always share one version.

## Commit messages

Commit messages are in English and follow [Conventional Commits](https://www.conventionalcommits.org/): a type, an optional scope naming the package, and a summary of what the commit adds or changes.

```
feat(core): add a between operator for date filters
fix(antd): keep the column menu open while a filter is edited
docs: describe the export size limits
```

## Code conventions

- **Language.** Code, comments, messages, test names and documentation are written in English. Turkish text belongs only in the Turkish locale and in tests that cover Turkish-character handling; those files are listed in `scripts/language-allowlist.txt`.
- **Formatting and linting.** Prettier and ESLint settings are in the repository root. Format the files you touch with Prettier.
- **Public API.** Every exported type, function and option carries a TSDoc comment. Read [STABILITY.md](STABILITY.md) before changing an exported symbol: it says which parts of the surface are stable, experimental or internal, and what kind of release each change needs.
- **Comments.** A comment explains why the code is the way it is. It should make sense on its own, without the history of the change.

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
