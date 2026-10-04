# @datatablex/react

The UI-library-independent React layer of DataTableX: the headless `useDataTable` hook, REST and in-memory `DataSource`s, URL sync and the export engine. For a ready-made Ant Design interface, see [`@datatablex/antd`](https://www.npmjs.com/package/@datatablex/antd); if you build a table with your own design system, this package and [`@datatablex/react/filter-model`](#filter-building-blocks-datatablexreactfilter-model) are enough.

## Installation

```bash
npm install @datatablex/react @datatablex/core react react-dom
```

`@datatablex/core` is a `dependencies` entry; `react` and `react-dom` are **peer dependencies**. The package does not depend on `antd`. Excel and PDF export are optional: `exceljs` and `pdfmake` are **optional peers**, so install them only if you use the matching adapter (see "Export" below).

| Peer                  | Supported range                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react` / `react-dom` | `^18.2.0 \|\| ^19.0.0`                                                                                                                                                                                                                                                                   |
| `exceljs` (optional)  | `^4.4.0`, only for `@datatablex/react/excel`                                                                                                                                                                                                                                             |
| `pdfmake` (optional)  | `0.2.20` (exact), only for `@datatablex/react/pdf`. The PDF adapter loads pdfmake's browser build files (`pdfmake/build/pdfmake.js` and `pdfmake/build/vfs_fonts.js`) and uses the callback form of `getBlob`. It is tested only against `0.2.20`, and pdfmake 0.3 is not supported yet. |

## Usage

```tsx
import { createRestDataSource, useDataTable } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";

interface AccessLog {
  id: number;
  accessDate: string;
  stadiumName: string;
}

const columns: ReactDataTableColumn<AccessLog>[] = [
  { key: "id", title: "ID" },
  { key: "accessDate", title: "Date", type: "datetime", sortable: true },
  { key: "stadiumName", title: "Stadium", type: "text", sortable: true, searchable: true },
];

const dataSource = createRestDataSource<AccessLog>({ endpoint: "/api/access-logs/query" });

export function AccessLogsList() {
  const table = useDataTable({ dataSource, columns, rowKey: "id", tableId: "access-logs" });
  // table.data, table.loading, table.pagination, table.setSorting, table.setFilters, table.setSearch …
  // Ready-made interface: <DataTable table={table} /> (@datatablex/antd)
  return <MyTable table={table} />;
}
```

The `dataSource` and `columns` references must be stable (constant at module level, or wrapped in `useMemo`). On a screen that changes `dataSource` on purpose, pass `dataSourceKey`; a change of identity alone does not trigger a new query.

For serverless prototypes and tests, `createLocalDataSource(rows, columns)` implements the same `DataSource` interface in memory. Its semantics are approximate: text matching and sorting are independent of locale, and limits are not applied. See the [`@datatablex/core` README](https://github.com/ersinozdemir/datatablex/blob/main/packages/core/README.md#queryinmemory-is-approximate) for the differences.

When `createRestDataSource` is given a `metaEndpoint` (see `@datatablex/fastify`, "Meta route"), the table reads the backend's limits and field allowlist and only **narrows** itself with them: `maxSearchLength` and the chunk size of a selected-rows export cannot exceed the backend value; operators the backend does not allow are removed from the column (for example, a sensitive field that opens only `eq` offers only "equals"); sorting is turned off for a column the backend does not sort, and filtering is turned off for a column that has no operator left. By default the first query does not wait for the meta; when the meta arrives, the query is brought within the limits. With `awaitMeta: true` (or `{ timeoutMs }`) the first query waits for the meta, so a shared link opens with a single, already normalized request; if the meta cannot be read or the time (3 s by default) runs out, the table continues with the values given by hand. `createRestDataSource` fetches the meta once per instance (`dataSource.invalidateMeta()` empties the cache) and adds the `x-datatablex-protocol` header to every request; the meta of a server that reports a protocol we do not support is ignored. In development mode, columns that were turned off and a mismatch between `rowKey` and the backend `primaryKey` are reported as warnings.

```ts
createRestDataSource<AccessLog>({
  endpoint: "/api/access-logs/query",
  metaEndpoint: "/api/access-logs/query/meta",
});
```

### Enum options from the server

> **Experimental** (`@experimental`): the shape may change during 0.x. This covers `optionsEndpoint`, `optionsState` on a column and `table.loadOptions`. See [STABILITY.md](https://github.com/ersinozdmr/datatablex/blob/main/STABILITY.md).

If you do not give `options` on a `type: "enum"` column and the backend defines options for that field (see `@datatablex/fastify`, "Filter options"), the list comes from the server. Priority: hand-written `options`, then the server, then not filterable.

```ts
createRestDataSource<AccessLog>({
  endpoint: "/api/access-logs/query",
  metaEndpoint: "/api/access-logs/query/meta",
  // When optionsEndpoint is omitted and metaEndpoint is given, `${endpoint}/options` is used; `false` turns it off.
});
const columns = [{ key: "status", title: "Status", type: "enum", filterable: true }]; // no options
```

- The list is fetched **lazily**: `table.loadOptions(field)` starts the request (`@datatablex/antd` calls it when the value editor opens). If the column already has an active rule (for example a filter that came from the URL), the hook fetches it itself once the meta arrives.
- The result is written to the column in `table.columns`: `options` and `optionsState` (`"idle" | "loading" | "ready" | "error"`). Read these two fields in your own interface; while the options are awaited, `ruleKindOf` also returns `"enum"`.
- An empty list or an error turns off only that column's filter; the table keeps working. `loadOptions` retries after an error.
- `createRestDataSource` fetches the list **once** per instance and field: reopening the same select does not produce a request. When the user or role changes, call `dataSource.invalidateMeta?.()` (it empties the options too) or `invalidateOptions?.(field)`, and change `dataSourceKey`.
- `hasOptions` comes from the meta, so `metaEndpoint` (or your own `getMeta`) is required. On your own `DataSource`, implement `getOptions(field, { signal })`.

### `TableInstance`

> **Version policy:** if you implement `TableInstance` by hand (a mock, a test wrapper), new members are added only as _optional_ in minor releases, and `<DataTable>` tolerates their absence. `DataSource.requestExport`, `DocumentExporter` and `/filter-model` are **experimental** (their shape may change during 0.x). Details: [API stability](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md).

The `TableInstance` returned by `useDataTable` is memoized: it gets a new identity only when something it carries changes. It is a complete controller contract for interfaces outside the table as well: `table.columns` (the columns narrowed by the endpoint meta), `table.rowKey`, `table.tableId`, `table.limits` (`maxSearchLength`; `maxFilterCount`, `maxFilterDepth` and `maxInValues` when there is a meta, otherwise `null`) and `table.searchRevision`. If you write your own search box:

```tsx
function ExternalSearch({ table }: { table: TableInstance<AccessLog> }) {
  const [value, setValue] = useState(table.search);
  // Sync the box when `reset()` or the URL changes the search (even if the value stays the same).
  useEffect(() => setValue(table.search), [table.search, table.searchRevision]);
  return (
    <Input.Search
      value={value}
      maxLength={table.limits.maxSearchLength}
      onChange={(e) => setValue(e.target.value)}
      onSearch={table.setSearch}
    />
  );
}
```

If you build a `TableInstance` by hand (a mock, a test, a bridge to another state manager), fill in these members and `lockedFilters` as well; `<DataTable table>` reads only the public members. The optional members (`exportSelectionBlocked`, `loadOptions`) may be left out. `columns` and `limits` should get a new reference only when their sources change, not on every render, and `searchRevision` must increase every time a search change is requested (`setSearch`, `reset()`, the URL), even when the value stays the same.

### Locked filters (`lockedFilters`)

Filters given by the application that the user cannot remove: context that comes from a dashboard ("the records of this stadium"), per-tab pre-filters.

```tsx
const locked = useMemo<FilterGroup | null>(
  () =>
    tab === "active"
      ? { operator: "AND", filters: [{ field: "active", operator: "eq", value: true }] }
      : null,
  [tab],
);
const table = useDataTable({ dataSource, columns, rowKey: "id", lockedFilters: locked });
```

- In the query and in an `allFiltered` export they are combined with the user's `filters` using `AND` (`andFilterGroups`). They do not enter `table.filters`; `table.lockedFilters` is read-only.
- They are not written to the URL, and `reset()` and `setFilters(null)` do not touch them. When their content changes the page returns to 1; passing a new object on every render does not produce a new query.
- A `selected` export fetches only the selected keys; the selection is not combined with the locked filter.
- Limits are counted on the combined tree: `checkFilterTree(tree, { maxRules, maxDepth, locked: table.lockedFilters })`.
- **This is not a security boundary.** For data the user must not see, use the backend `scope` (`@datatablex/fastify`).

## Filter building blocks (`@datatablex/react/filter-model`)

The UI-independent filter model; `@datatablex/antd` uses it as well. **Experimental** (`@experimental`): its shape may change during 0.x, even in a patch release, so pin the version if you use it in production ([API stability](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md)). If you build a filter bar or builder with another UI kit:

- **Column roles:** rules and nodes are bound to a column by `field`; `columnsByField(columns)` gives this mapping (columns with `field: null` are left out; of columns that share a field, the first one wins).
- **Rule model:** `FilterRule` (field + operator + value), `ruleOperatorsFor(column)` (the conditions to offer, by column type and `filterOperators`), `ruleToNode`/`nodeToRule` (rule to wire node and back; `datetime` day rules are compiled into a half-open `gte` + `lt` group in the column's `timezone`, and reversed ranges are put in order), `readEntries`/`writeEntries` (the rules of the root `AND` and the external nodes that are preserved).
- **Advanced builder draft:** `toDraft`/`fromDraft`, `insertNode`/`removeNode`/`replaceNode`/`duplicateNode`/`setGroupOperator`, `validateDraft` and `checkFilterTree` (the same leaf and depth counting as the backend).

```ts
import { ruleOperatorsFor, ruleToNode } from "@datatablex/react/filter-model";

const node = ruleToNode(
  { field: "accessDate", operator: "dayBetween", value: ["2026-09-01", "2026-09-10"] },
  accessDateColumn,
);
table.setFilters(node ? { operator: "AND", filters: [node] } : null);
```

## URL sync (`syncWithUrl`)

The query (page, page size, sorting, search and filter tree) is synchronized with the URL in both directions; when a link with filters is shared, the table opens with the same query.

```tsx
useDataTable({ ...options, syncWithUrl: true }); // without a router: window.history
useDataTable({ ...options, syncWithUrl: true, urlParamPrefix: "logs" }); // several tables on one page: logs.page, logs.f
```

- URL format: `?page=2&pageSize=50&sort=accessDate:desc&search=Ahmet&f=<base64url>`. The filter tree, including nested groups, travels in the single `f` parameter (`encodeFilterParam` from core). Default values are not written, and the application's own parameters are preserved.
- When it is on, the first query waits until the URL has been read; the default query is not sent first.
- A page change adds an entry to the browser history (the back button returns to the previous page); search, filter and sorting replace the current entry.
- The URL is untrusted input: a malformed `f` is ignored, a field that cannot be sorted is dropped, the page and page size are corrected, and the table opens in every case. Corrected values are also cleaned from the URL without creating a history entry (`replace`). A filter outside the allowlist gets a 400 from the backend; the UI's clear-query action also clears the URL.
- If `metaEndpoint` is given, the first query does not wait for the meta. When the meta arrives, the query is brought within the backend limits: the page size is clamped, sorting that the meta turned off is dropped, the search is shortened and the URL is corrected. If a query that went out before the meta got a 400 for this reason, the table recovers on its own.
- If the adapter changes (for example a router adapter that is rebuilt on a route change), the URL of the new adapter is read and applied to the table.
- Column state, density and selected rows are not written to the URL.
- Applications that use a router pass a `UrlStateAdapter` (`get` / `set(params, { replace })` / `subscribe`); writing to `window.history` without the router knowing leaves its parameters stale. Keep the adapter stable with `useMemo`.

### React Router

Tried with React Router 6.30, 7.18 and 8.4. Import from `react-router-dom` in v6 and v7, and from `react-router` in v8 (in v7 both work).

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom"; // React Router 8: "react-router"
import type { UrlStateAdapter } from "@datatablex/react";

export function useReactRouterUrlAdapter(): UrlStateAdapter {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  const navigateRef = useRef(navigate);
  const listeners = useRef(new Set<() => void>());

  // When the router location changes (back/forward, another link), the table is notified.
  useEffect(() => {
    locationRef.current = location;
    navigateRef.current = navigate;
    listeners.current.forEach((onChange) => onChange());
  }, [location, navigate]);

  return useMemo<UrlStateAdapter>(
    () => ({
      get: () => new URLSearchParams(locationRef.current.search),
      set: (params, options) => {
        const search = params.toString();
        navigateRef.current({ search: search ? `?${search}` : "" }, { replace: options?.replace });
      },
      subscribe: (onChange) => {
        listeners.current.add(onChange);
        return () => listeners.current.delete(onChange);
      },
    }),
    [],
  );
}

// Usage
const urlAdapter = useReactRouterUrlAdapter();
useDataTable({ ...options, syncWithUrl: urlAdapter }); // or <DataTable {...props} syncWithUrl={urlAdapter} /> (@datatablex/antd)
```

### Next.js (App Router)

Tried with Next.js 16. The component that contains the table must be a client component (`"use client"`). Because it uses `useSearchParams`, this component must be wrapped in `<Suspense>` on the page; otherwise `next build` stops while generating the static page ("useSearchParams() should be wrapped in a suspense boundary").

```tsx
"use client";
import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { UrlStateAdapter } from "@datatablex/react";

export function useNextUrlAdapter(): UrlStateAdapter {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const stateRef = useRef({ router, pathname, search: searchParams.toString() });
  const listeners = useRef(new Set<() => void>());

  useEffect(() => {
    stateRef.current = { router, pathname, search: searchParams.toString() };
    listeners.current.forEach((onChange) => onChange());
  }, [router, pathname, searchParams]);

  return useMemo<UrlStateAdapter>(
    () => ({
      get: () => new URLSearchParams(stateRef.current.search),
      set: (params, options) => {
        const { router, pathname } = stateRef.current;
        const search = params.toString();
        const url = search ? `${pathname}?${search}` : pathname;
        if (options?.replace) router.replace(url, { scroll: false });
        else router.push(url, { scroll: false });
      },
      subscribe: (onChange) => {
        listeners.current.add(onChange);
        return () => listeners.current.delete(onChange);
      },
    }),
    [],
  );
}
```

Both templates were verified against real routers for these behaviors: applying the initial URL, a page change adding a history entry and the back button, filtering and sorting not adding an entry, external navigation through the router's `Link`, coming back from another route, preserving the application's own parameters and a nested route path, and no echo loop. These two examples add no dependency to the package; they are templates to adapt in your own project. If the router has settings such as hash or `basename`, the URL built in `set` must be built accordingly.

## Export

`table.exportData(format, scope?, { filename?, title? })` downloads the file and returns `"started"` or `"cancelled"`; `table.cancelExport()` stops it. For the toolbar menu, see [`@datatablex/antd`](https://www.npmjs.com/package/@datatablex/antd). There are two paths:

**Server path (recommended).** If the source offers `requestExport` and the endpoint meta announces the format in `export.formats`, CSV, Excel and PDF are streamed on the server for all three scopes (see `@datatablex/fastify`, "Server export"):

```ts
const dataSource = createRestDataSource({
  endpoint: "/api/access-logs/query",
  metaEndpoint: "/api/access-logs/query/meta",
  // When omitted and metaEndpoint is given, `${endpoint}/export`; give a full URL for a different origin. `false` turns it off.
  exportEndpoint: "/api/access-logs/query/export",
});
const table = useDataTable({ dataSource, columns, rowKey: "id" });

table.exportFormats; // once the meta arrives: ["csv", "excel", "pdf"], no adapter needed
await table.exportData("excel", "allFiltered"); // "started"
```

1. A single-use ticket is obtained with `POST ${exportEndpoint}/ticket` (with the table's column headings; identity, authorization and the row ceiling are checked on the server).
2. `${exportEndpoint}/download?ticket=…` is opened with a hidden `<a download>`: the browser downloads the file itself, and the rows never enter the page's JavaScript or memory. The download request does not carry `headers`; the identity comes from the ticket.

- `isExporting` is true only until the ticket is obtained, and `exportProgress` is `null`; progress and cancellation are in the browser's download UI. `cancelExport()` aborts the ticket request.
- The request carries the combination of the user's filters and the locked filters, the search and the sorting. `currentPage` sends the current page and page size, and `selected` sends the selected keys (without filter and search; `rowKey` must be the name of the backend `primaryKey`).
- The field of the value shown is what is sent to the server (the string `accessor`, otherwise `field`); computed columns and columns that the endpoint does not open to export are skipped, with a warning in development mode. The cell format is the server's `export.formatter`; `exportValue` does not run on this path.
- The server ceiling of the format (`export.formats`) is checked against the known total before any request is sent; if it is exceeded, or if the server returns 413, the result is `ExportRowLimitError` (`source: "server"`). If the server is producing too many exports at once (429), the result is `ExportBusyError`.

**Client path.** For sources with no server export (`createLocalDataSource`, an older server that does not announce tickets, a source without a meta), the file is produced in the browser. CSV is always available; Excel and PDF are enabled by adapters, which load their libraries dynamically themselves:

```bash
npm install exceljs pdfmake@0.2.20   # only the libraries of the formats you will use
```

```ts
import { excelExporter } from "@datatablex/react/excel";
import { pdfExporter } from "@datatablex/react/pdf";

const exporters = [excelExporter, pdfExporter]; // a module constant; an inline array also works
const table = useDataTable({
  dataSource: createLocalDataSource(rows, columns),
  columns,
  rowKey: "id",
  exporters,
});
await table.exportData("pdf", "currentPage", { title: "Access logs" });
```

- The rows are collected in memory and the file is downloaded as a Blob. The export calls the same endpoint page by page; the first `allFiltered` request gets the total, and later requests carry `skipCount: true`. The selected-rows chunk size is `exportChunkSize: 500`. `exportProgress` reports progress.
- **Ceiling:** if an `allFiltered`/`selected` export exceeds `maxClientExportRows`, the result is `ExportRowLimitError` (`source: "client"`, `format`). The defaults are 100 000 for CSV, 50 000 for Excel and 10 000 for PDF (measured: an Excel file of 100K rows takes about 700 MB, PDF generation freezes the tab, and CSV also keeps all rows, the row arrays, the single text and the Blob in memory). A number applies to all three formats, an object (`{ csv, excel, pdf }`) applies per format, and `Infinity` removes the ceiling on purpose. With wide cells the row count alone is not the memory limit; for large data, use the server path.
- A format that has no registered adapter and is not produced by the server is rejected with an explicit error before any request is sent. For your own format you can implement `DocumentExporter` (`format`, `extension`, `mimeType`, `description`, `build(columns, rows, { title }) → Promise<Blob>`). **`DocumentExporter` is experimental** and may change during 0.x; see [STABILITY.md](https://github.com/ersinozdemir/datatablex/blob/main/STABILITY.md).
- The libraries of Excel (`excelExporter`) and PDF (`pdfExporter`, `pdfmake` + the embedded Roboto font) are loaded dynamically only on first use; the build of an application that never imports `@datatablex/react/excel` or `@datatablex/react/pdf` does not see them. With four or fewer visible columns the page is portrait A4, with more it is landscape A4.

**On both paths:**

- The default scope is `allFiltered`; if `selected` is empty, it is rejected before any request is sent with a `DataTableExportError` (code `no_rows_selected`, message `[datatablex] No row is selected.`). `currentPage` is rejected while the table is loading (code `export_table_loading`), because the data on the screen may belong to the previous query.
- `cancelExport()` or an unmount aborts pending requests with an `AbortSignal`; `exportData` returns `"cancelled"` without an error.
- The order and the set of columns come from the user's visible `columnState`; columns that are `hidden` or `exportable: false` are not written. This is not an access control: on the server path the boundary is `export.fields`, and not sending sensitive data to the browser at all is the responsibility of the backend or view.
- CSV is written with a UTF-8 BOM and with every cell quoted in the RFC 4180 style; text that starts with a formula character is safely prefixed with `'`. In Excel, text cells are written as strings.

For the wire contract of the server path, see the [`@datatablex/fastify` README](https://github.com/ersinozdemir/datatablex/blob/main/packages/fastify/README.md) ("Server export") and [`@datatablex/core`](https://www.npmjs.com/package/@datatablex/core).

## License

MIT
