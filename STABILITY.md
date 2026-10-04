# API stability and versioning

This policy applies from the first published release.

## Versioning

- The packages follow SemVer and are released with Changesets. They are in `0.x`: a range such as `^0.1.0` covers patch releases only, and a breaking change may ship in a minor release. That is not a licence to break things; the table below says how each part of the surface may change.
- The four packages are released together and share one version number. `@datatablex/react` and `@datatablex/fastify` depend on `@datatablex/core` with a caret range. `@datatablex/antd` has `@datatablex/react` and `@datatablex/core` as peer dependencies and accepts any `0.x` version of them, so the package manager does not stop a mismatch. Only packages with the same version are tested together: install the same version of each and upgrade them together.
- Adding an error code, a locale key, an optional option or an optional `TableInstance` member is a minor change.

## Surface classes

### Stable

Breaking changes ship only in a minor release and are called out in the changelog.

`DataTableQuery`, `DataTableResult`, `Filter`, `FilterGroup`, `DataSource.fetch`, `DataTableErrorBody`, `DataTableErrorCode`, the `useDataTable` options, `createRestDataSource`, `createLocalDataSource`, `UrlStateAdapter`, both forms of `<DataTable>` (hook options, or a ready `table` instance), `datatableRoute`, `DataTableEndpointConfig`, `describeDataTableEndpoint`.

### Experimental

Marked `@experimental`. The shape may change even in a patch release while the packages are in `0.x`. Pin the version if you use it in production.

- **Server-side export requests:** `DataSource.requestExport`, `DataTableExportRequest`, `DataTableExportTicket`, `DataTableExportDownload`, and the `ticketStore` and `onExport` parts of the `export` block. These may change when a job queue is introduced.
- **The `@datatablex/react/filter-model` subpath.** Its only consumer is `@datatablex/antd`; it has not been validated against a second UI kit.
- **`DocumentExporter`.**
- **Server-provided enum options:** `FieldConfig.options`, `FieldConfig.maxOptions`, `handler.options`, `DataTableFieldOption`, `DataTableFieldOptions`, `isDataTableFieldOptions`, the `hasOptions` meta flag, `DataSource.getOptions`, `DataSource.invalidateOptions`, `RestDataSourceOptions.optionsEndpoint`, `ReactDataTableColumn.optionsState`, `TableInstance.loadOptions`.

### Internal

Outside SemVer and not exported from the package root, for example `handleDataTableQuery`, `openDataTableExport` and `filterExpression`.

## `TableInstance`

`TableInstance<T>` is a two-way contract: `useDataTable` **returns** it, and consumers may **implement** it (a mock, a test wrapper, a bridge to another state library).

- **New members are added only as optional (`?`) in minor releases**, and `<DataTable>` tolerates their absence by falling back to a default. Adding a required member would be a major change (in `0.x`: an announced minor) and a compile error for everyone who implements `TableInstance` by hand, so it is not done.
- The reverse also holds: the object returned by `useDataTable` fills in every member, including the optional ones.
- If you implement a member yourself, the reference-stability and memoization rules documented on `TableInstance` are yours to uphold.

## Locale

New keys may be added to `DataTableLocale` in minor releases. The `locale` prop accepts `Partial<DataTableLocale>`, so this does not break a consumer that passes a partial override. Code that declares a complete `DataTableLocale` object (`const l: DataTableLocale = {...}`) gets a compile error for the new key. For a full translation, spread a shipped locale: `{ ...enUS, ...overrides }`.

## Error codes and the wire format

`DataTableErrorCode` grows as a closed union (a new code is a minor change); recognizers fall back to `message` for a code they do not know. The wire shape (`DataTableQuery`, endpoint metadata, the error body) changes with the protocol version, sent in the `x-datatablex-protocol` header.
