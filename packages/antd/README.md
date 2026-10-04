# @datatablex/antd

The Ant Design v5 interface of DataTableX: `<DataTable>`, a filter bar and an advanced filter builder, a column header menu, column management and an export menu. State and data access live in the `useDataTable` hook of [`@datatablex/react`](https://github.com/ersinozdemir/datatablex/blob/main/packages/react/README.md); this package only renders its public contract (`TableInstance`).

## Installation

```bash
npm install @datatablex/antd @datatablex/react @datatablex/core antd react react-dom
```

`@datatablex/react`, `@datatablex/core`, `antd`, `react` and `react-dom` are **peer dependencies**: your application must have exactly ONE copy of each (the error classes and the hook of `@datatablex/react` are shared between your application and this package). The command above installs all of them. If you upgrade `@datatablex/react` later, a `^0.x` range covers patch releases only, so move `@datatablex/antd` to the same minor.

| Peer                                     | Supported range                                  |
| ---------------------------------------- | ------------------------------------------------ |
| `@datatablex/react` / `@datatablex/core` | `^` (the patch range of the version you install) |
| `react` / `react-dom`                    | `^18.2.0 \|\| ^19.0.0`                           |
| `antd`                                   | `^5.20.0`                                        |

Ant Design 5 is supported. Ant Design 6 is not supported yet.

> **Version policy:** a minor release may add new keys to `DataTableLocale`. For a full translation use `{ ...enUS, ...overrides }` (a partial `locale` is not affected). Details: [API stability](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md).

### If you use React 19

Ant Design v5 is not fully compatible with React 19. If you run on React 19, install [`@ant-design/v5-patch-for-react-19`](https://www.npmjs.com/package/@ant-design/v5-patch-for-react-19) in your application and import it as documented there. This is the responsibility of the consuming application, not of `datatablex`.

## Usage

```tsx
import { DataTable } from "@datatablex/antd";
import { createRestDataSource } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";

const columns: ReactDataTableColumn<AccessLog>[] = [
  { key: "id", title: "ID" },
  { key: "accessDate", title: "Date", type: "datetime", sortable: true },
  { key: "stadiumName", title: "Stadium", type: "text", sortable: true, searchable: true },
];

const dataSource = createRestDataSource<AccessLog>({
  endpoint: "/api/access-logs/query",
  metaEndpoint: "/api/access-logs/query/meta",
});

export function AccessLogsTable() {
  return (
    <DataTable
      dataSource={dataSource}
      columns={columns}
      rowKey="id"
      tableId="access-logs" // when given, the column state is persisted in localStorage
      searchable
      columnManagement
    />
  );
}
```

`<DataTable>` takes one of two forms: the options of `useDataTable` (the component calls the hook itself) or a ready-made `table={useDataTable(...)}`. With the second form, `table.reload()`, `table.reset()` and controls outside the table are within reach. For URL sync (`syncWithUrl`) and `DataSource` details, see the [`@datatablex/react`](https://github.com/ersinozdemir/datatablex/blob/main/packages/react/README.md#url-sync-syncwithurl) documentation.

## Column roles

A column definition can separate three roles:

```tsx
const columns: ReactDataTableColumn<AccessLog>[] = [
  // Show the masked value, filter by the raw field: key = field = "nationalId", the cell shows nationalIdMasked
  {
    key: "nationalId",
    accessor: "nationalIdMasked",
    title: "National ID",
    type: "text",
    filterable: true,
    filterOperators: ["eq"],
  },
  // The backend field was renamed; users' saved column layouts survive thanks to `key`
  { key: "stadium", field: "stadiumName", title: "Stadium", type: "text", sortable: true },
  // Computed column: no backend counterpart, sorting and filtering are off
  {
    key: "summary",
    field: null,
    accessor: (r) => `${r.stadiumName} · ${r.status}`,
    title: "Summary",
  },
];
```

- **`key`**: the identity of the column. Column state, the localStorage record, the header menu and the column panel use it.
- **`field`**: the backend field; defaults to `key`. Sorting, filtering (bar and builder), the URL and the endpoint meta use it. With `null`, the column can be neither sorted nor filtered.
- **`accessor`**: the value shown in the cell and exported (a field name or a function); defaults to `record[field ?? key]`. `render` receives this value as its first argument.

In development mode, `field: null` combined with `sortable`/`filterable`, and different columns that share the same `field`, produce a warning.

## Filters

The filter bar is the table's only filter interface. If there is a column with `filterable: true`, it is shown above the table by default; active filters appear as chips. `+ Add filter` adds a rule by choosing field, then condition, then value. Clicking a chip edits the rule, `×` deletes it, and `Clear all` removes every filter. Each chip makes a single `setFilters` call with its own "Apply". "Filter" in the column header menu opens the rule editor for that field in the bar and focuses its value box; if the field already has a single rule, that rule is opened for editing.

```tsx
<DataTable {...props} />                              // the bar is on by default (simple mode)
<DataTable {...props} filterBar={{ maxRules: 20 }} />
<DataTable {...props} filterBar={false} />            // no filter interface on the table
```

The value editor and the conditions come from the column's `type` automatically; you do not write a filter component per screen:

| `type`                         | Editor                         | Conditions                                                                                                           |
| ------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| none, `text`                   | text                           | contains, does not contain, equals, does not equal, starts with / does not start with, ends with / does not end with |
| `number`, `currency`           | number (two boxes for a range) | equals, does not equal, greater than, less than, greater than or equal, less than or equal, between                  |
| `date`, `datetime`             | day                            | on, on or after, on or before, between dates                                                                         |
| `enum` (`options` is required) | multi-select                   | is any of, is none of                                                                                                |
| `boolean`                      | Yes / No                       | equals                                                                                                               |
| all                            | -                              | Empty (NULL), Not empty (NOT NULL)                                                                                   |

```tsx
const columns: ReactDataTableColumn<AccessLog>[] = [
  { key: "stadiumName", title: "Stadium", type: "text", filterable: true },
  { key: "amount", title: "Amount", type: "currency", currency: "TRY", filterable: true },
  {
    key: "accessDate",
    title: "Date",
    type: "datetime",
    timezone: "Europe/Istanbul",
    filterable: true,
  },
  {
    key: "status",
    title: "Status",
    type: "enum",
    filterable: true,
    options: [{ label: "Open", value: "open" }],
  },
];
```

Things to know:

- **The conditions offered depend on `filterOperators`.** A condition is offered if all the wire operators it compiles to are enabled in the column's `filterOperators`. A column without `filterOperators` offers the default set: `contains` for text; `between`/`gte`/`lte` for numbers and for `date`; `gte`/`lt` for `datetime`; `in` for enum; `eq` for boolean. If you use `metaEndpoint`, the list is intersected with the backend permissions; a column left with no condition cannot be filtered.
- **Enum options can come from the server** (experimental, see [API stability](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md)). If a `type: "enum"` column has no `options` and the backend defines `options` for the field, the list is fetched once, when the value editor is first opened; while it waits, "Loading options…" is shown (`locale.optionsLoading`). If the list is empty or cannot be fetched, only the filter of that column is turned off (`locale.optionsUnavailable`). Options given by hand always take precedence.
- **`filterOperators` does not grant permission.** For a field that is `sensitive: true` on the backend (open to exact match only), give `filterOperators: ["eq"]`; the bar then offers only "equals".
- **Keeping in line with the backend whitelist is the developer's contract.** If the operator of an offered condition is not enabled in `fields[field].filterOperators`, the request gets a `400`.
- **Date conditions work at day granularity.** A `date` column sends the day as it is (`YYYY-MM-DD`). A `datetime` column produces a HALF-OPEN range in the column's `timezone`: "on a day" becomes `AND(gte start of day, lt start of next day)` (so that PostgreSQL microseconds do not slip through). For this reason, the `filterOperators` of a `datetime` field on the backend must include `gte` and `lt`.
- **Negative conditions exclude rows with NULL values**; the editor says so with "(empty values excluded)".
- **A rule with a missing value cannot be applied.** An empty selection is not "no rows" (`in: []`); "Apply" stays disabled.
- **Columns of type `time` or `custom`, and `enum` columns without `options`, get no automatic filter**; a warning is printed in development builds.
- **Filters the bar cannot represent are kept.** Nodes passed from outside the table with `table.setFilters(...)` that the bar cannot read as rules (for example an `OR` group) are shown as an "External filter" chip; new rules are added next to them with `AND`. Their content cannot be edited, but the user can remove the chip with an explicit action ("Clear all" removes it too). A scope the user must not be able to remove (tenant, authorization) must not be given as a UI filter; apply it on the backend with `scope`.
- **Locked filters** (`lockedFilters`, see `@datatablex/react`) appear at the start of the bar as a non-removable summary with a lock icon; "Clear all" does not touch them. The rule limit counts locked leaves too. The `<DataTable lockedFilters={...}>` shorthand works as well.
- **Limits:** if `maxRules` is not given, the `maxFilterCount` of the endpoint meta is used, and if `maxDepth` is not given, `maxFilterDepth`; with no meta, 50 and 3. Both limits apply in simple mode too: `datetime` day rules compile to a `gte` + `lt` group, so they count as one level.

### Advanced builder (`mode: "advanced"`)

> Nested filters travel through the URL without loss with `syncWithUrl`; to share a filter built in advanced mode as a link, turn on `syncWithUrl` as well.

```tsx
<DataTable {...props} filterBar={{ mode: "advanced", maxDepth: 3 }} />
```

An "Advanced" button is added to the bar, and a panel opens below the bar to build nested `and`/`or` groups. Edits collect in a draft: "Apply" makes a single `setFilters` call, and "Cancel" discards the draft.

- Incomplete rules (missing field, condition or value) are highlighted and block "Apply".
- `maxDepth` and `maxRules` are checked on the compiled tree, with the backend's counting. `datetime` day rules compile to a `gte` + `lt` group, so they count as one more level.
- If the filters change from outside while the panel is open and the draft has no changes, the draft is silently refreshed. If it has changes, a warning and "Reload" are shown; the user's edit is not overwritten.
- Nested groups appear in the bar as a readable summary chip, for example "(Status is any of Closed or Amount >= 400)"; clicking it opens it in the builder. The "⋯" menu of every chip has Edit, Duplicate, Open in builder and Remove. This menu does not exist in simple mode.

## Cell appearance

The default UI font of DataTable is `Segoe UI`; where it is not available on the platform, the system sans-serif font is used (it can be changed with the `fontFamily` prop). Cell appearance can be set per column: `monospace: true` applies the code font, and `tabularNums: true` gives numeric characters equal-width digits (`font-variant-numeric: tabular-nums`). `tabularNums` helps align the digits of date columns. Both options affect body cells only.

## Localization

The table's own texts (toolbar, column menu, filter inputs, export menu, the default error and empty views) are read from the `locale` prop. The default is `enUS`: a `<DataTable>` without a `locale` prop shows English texts. The package also ships `trTR` (Turkish) as a ready option:

```tsx
import { DataTable, trTR } from "@datatablex/antd";

<DataTable {...props} locale={trTR} />;
```

The given keys are merged with the default, so you do not need to write the whole object to change a single text:

```tsx
<DataTable {...props} locale={{ searchPlaceholder: "Search stadiums" }} />
```

For a full translation, spread a shipped locale and override what you need:

```tsx
import { enUS, type DataTableLocale } from "@datatablex/antd";

const overrides: Partial<DataTableLocale> = { apply: "Apply filters", cancel: "Dismiss" };
export const myLocale: DataTableLocale = { ...enUS, ...overrides };
```

Ant Design's own texts (pagination buttons, the page size selector, the empty-state illustration, the date picker) are not covered by this prop; they follow the `locale` of Ant Design's `ConfigProvider`.

The texts that take a column name (`columnMenu`, `minInput`, `moveUp` and so on) are functions and receive the column's plain-text name: `exportTitle`, otherwise the `title` if it is a string, otherwise `key` (a screen reader says "Stadium column menu"). Server errors arrive with a machine code (`code`) and are shown through `errorMessages[code]`; for an unknown code, the server's message is shown. Because the generic text of a `validation` error does not say what the problem is, the server's message is appended below it with `errorDetail(serverMessage)` ("Details (server): ..."); this message is in the server's language and is not translated. The range summary on the left of the pagination bar ("Showing 21–40 of 125") is `paginationTotal(from, to, total)`; when there are no records, `from` and `to` are 0. The `[datatablex] ...` developer errors thrown by `useDataTable` are not translated.

## Error, search and selection behavior

- **An error does not remove the table.** While `table.error` is set, the default view is an `Alert` above the table; the toolbar, the column menus and the last data stay in place. `createRestDataSource` also validates the envelope of a 2xx response: a body that is not JSON, or that does not match the `data`/`pagination` shape, surfaces as an explicit error. The shape of the rows is not validated. On `!res.ok` it throws a `DataTableRequestError` that carries the HTTP status: on 4xx, "Retry" is hidden and "Clear Query" is shown, which clears filters, search and sorting. If `errorRender` is given, it is rendered in the same place (above the table).
- **`maxSearchLength`** (default 200) truncates the search box and trims `setSearch`; if there is no `metaEndpoint`, give the same value as the backend's `maxSearchLength`.
- **Layout:** the filter bar and the toolbar (search, selection counter, Columns, Export) share one row: the bar fills the left side and the toolbar sits at the right end; on a narrow screen it wraps below. The toolbar buttons are the same (small) size as the filter bar's. Pagination is under the table, with the range summary on the left and the buttons on the right.
- **"No" column:** a virtual row number column, hidden by default and shown at the far left, turned on with the "No" row in the `columnManagement` panel. The number is the position in the server order (it continues across pages); the column cannot be sorted, because the number is not a backend field.
- **Selection counter:** when `selectable` is on and there is a selection, "N selected" and "Clear Selection" appear in the toolbar, to the left of the buttons (the selection is kept across filter and page changes).
- **Column width:** the handle on the right edge of the header runs along the whole table; it can also be grabbed and dragged over the rows, and a thin line appears at the column edge on hover. It is also adjusted with the left/right arrow keys; the width is written to `columnState` and stored with `tableId`.
- **Header appearance:** the header row has no background, and there are no vertical dividers between column names.
- **Font:** the `fontFamily` prop replaces the default `Segoe UI` stack; `fontFamily={false}` inherits the font of the consumer's theme (the header appearance still applies).

## Export menu

The `export` prop opens a menu in the toolbar where the user first chooses a scope (This page / Filtered rows / Selected rows) and then a format (CSV / Excel / PDF). The behavior of the engine (the server path and the native download, the client path, formula escaping, PDF layout) is in [the `@datatablex/react` README](https://github.com/ersinozdemir/datatablex/blob/main/packages/react/README.md#export).

On an endpoint with server export enabled (`export.formats` of `@datatablex/fastify`), no adapter is needed for Excel and PDF; the server produces the file and the browser downloads it itself:

```tsx
<DataTable
  dataSource={createRestDataSource({ endpoint, metaEndpoint })}
  columns={columns}
  rowKey="id"
  selectable
  export={{ formats: ["csv", "excel", "pdf"], scopes: ["currentPage", "allFiltered", "selected"] }}
/>
```

With a source that has no server (for example `createLocalDataSource`), Excel and PDF are enabled with adapters:

```tsx
import { excelExporter } from "@datatablex/react/excel"; // requires exceljs
import { pdfExporter } from "@datatablex/react/pdf"; // requires pdfmake

<DataTable
  dataSource={localSource}
  columns={columns}
  rowKey="id"
  exporters={[excelExporter, pdfExporter]}
  export={{ formats: ["csv", "excel", "pdf"], scopes: ["allFiltered"] }}
/>;
```

- The menu shows only the available formats: CSV, those registered with `exporters`, and those the server produces (once the meta arrives). A format that has neither a registered adapter nor server support is not shown; after the first load finishes, a warning is printed once in development mode.
- When a download starts, the `locale.exportStarted` notification ("Download started. You can find the file in your browser's downloads.") appears. If the row limit is exceeded (`ExportRowLimitError`), `exportRowLimitClient` ("Choose CSV or narrow the filters") or `exportRowLimitServer` is shown; if the server is busy (`ExportBusyError`, 429), `exportBusy` is shown.

- `selected` is disabled when there is no selection; when there is one, "Selected rows (n)" is shown.
- While the table is loading, the formats are disabled for "This page" and a warning is shown.
- While an export runs, the button shows a loading state and "Cancel" appears next to it (`table.cancelExport()`). On the client path, the button shows progress; on the server path, this state lasts only until the ticket is obtained, and progress and cancellation are in the browser's download interface.
- The PDF title is `locale.exportDocumentTitle`.

For the server side of export, see [`@datatablex/fastify`](https://github.com/ersinozdemir/datatablex/blob/main/packages/fastify/README.md#server-export-export). Server export requests are experimental; see [API stability](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md).

## License

MIT
