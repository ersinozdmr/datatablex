/**
 * Text operators, which take only a `string` value (an `ILIKE` pattern). The
 * negated ones follow SQL three-valued logic: a row whose value is NULL is NOT
 * in the result (`NOT ILIKE` yields NULL), consistent with `neq` and `notIn`.
 */
export type TextOperator = "contains" | "startsWith" | "endsWith" | "notContains" | "notStartsWith" | "notEndsWith";

/** Comparison operators, which take a `string | number | boolean` value. */
export type ComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

/** Every operator that takes a single scalar value: the text and comparison operators. */
export type ScalarOperator = TextOperator | ComparisonOperator;

/** Operators that take no value. */
export type NullaryOperator = "isNull" | "isNotNull";

/** Every filter operator the wire contract knows. */
export type FilterOperator = ScalarOperator | NullaryOperator | "between" | "in" | "notIn";

/**
 * Discriminated by `operator`: text operators take a `string`, comparison
 * operators a scalar, `isNull`/`isNotNull` carry no value, `between` is a
 * two-element tuple, `in`/`notIn` expect an array. The backend rejects a
 * non-string text value with 400; the type says so at compile time.
 */
export type Filter =
  | { field: string; operator: TextOperator; value: string }
  | { field: string; operator: ComparisonOperator; value: string | number | boolean }
  | { field: string; operator: "between"; value: [string | number, string | number] }
  | { field: string; operator: "in" | "notIn"; value: Array<string | number> }
  | { field: string; operator: NullaryOperator };

/** A group of filters and nested groups combined with one logical operator. */
export interface FilterGroup {
  /** How the entries of `filters` are combined. */
  operator: "AND" | "OR";
  /** The leaves and nested groups of this group. */
  filters: Array<Filter | FilterGroup>;
}

/** One sort criterion. */
export interface Sort {
  /** Backend field to sort by. */
  field: string;
  /** Sort direction. */
  direction: "asc" | "desc";
}

/**
 * The query a data source receives: pagination, sorting, filters and an
 * optional global search.
 *
 * @example
 * ```ts
 * const query: DataTableQuery = {
 *   pagination: { page: 1, pageSize: 25 },
 *   sorting: [{ field: "createdAt", direction: "desc" }],
 *   filters: {
 *     operator: "AND",
 *     filters: [
 *       { field: "name", operator: "contains", value: "ada" },
 *       { field: "status", operator: "in", value: ["open", "pending"] },
 *     ],
 *   },
 *   search: "invoice",
 * };
 * ```
 */
export interface DataTableQuery {
  /** The requested page and its size. */
  pagination: { page: number; pageSize: number };
  /** Sort criteria, in priority order. */
  sorting: Sort[];
  /** The filter tree, or `null` for no filtering. */
  filters: FilterGroup | null;
  /** Global search text. */
  search?: string;
  /**
   * When true, the backend skips the COUNT query.
   *
   * @default false
   */
  skipCount?: boolean;
}

/** The response to a `DataTableQuery`: one page of records and its pagination. */
export interface DataTableResult<T> {
  /** The records of the requested page. */
  data: T[];
  /**
   * `pageSize` is the EFFECTIVE value the backend APPLIED (clamped to
   * `maxPageSize`), not the one the request sent. `total` is null for
   * requests with `skipCount: true`.
   */
  pagination: { page: number; pageSize: number; total: number | null };
}

/** Where a table gets its data: a required `fetch` and optional capabilities. */
export interface DataSource<T> {
  /** Fetches one page of records for `query`; `options.signal` aborts the request. */
  fetch(query: DataTableQuery, options?: { signal?: AbortSignal }): Promise<DataTableResult<T>>;
  /**
   * The endpoint's limits and field metadata. Optional; if it is not
   * implemented or it rejects, the client falls back to its own defaults.
   */
  getMeta?(options?: { signal?: AbortSignal }): Promise<DataTableEndpointMeta>;
  /** On sources that cache the `getMeta` result, clears the cache (for example when the role changes on the same instance). */
  invalidateMeta?(): void;
  /**
   * The filter options of an enum field, fetched from the server. Called only
   * when the meta reports `hasOptions` for that field and the column has no
   * hand-written `options`. Optional; if it rejects, only that column's filter
   * is turned off.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  getOptions?(field: string, options?: { signal?: AbortSignal }): Promise<DataTableFieldOption[]>;
  /**
   * On sources that cache the `getOptions` result, clears the cache: only the
   * given field if one is passed, otherwise all fields. `invalidateMeta` does
   * this too.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  invalidateOptions?(field?: string): void;
  /**
   * Server-side export: obtains a ticket and returns the address from which the
   * browser's own download fetches the file; the file never enters browser
   * memory. When it exists and the meta declares the format in
   * `export.formats`, `exportData` uses it for all three scopes.
   *
   * @experimental May change in any release while the package is in 0.x.
   */
  requestExport?(request: DataTableExportRequest, options?: { signal?: AbortSignal }): Promise<DataTableExportDownload>;
}

/** The validation category of a backend field; the same as `FieldType` in `@datatablex/fastify`. */
export type DataTableFieldType = "text" | "number" | "boolean" | "date" | "datetime" | "enum";

/**
 * A single filter option of an enum field: the displayed label and the wire value.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DataTableFieldOption {
  /** The text shown to the user. */
  label: string;
  /** The value sent on the wire. */
  value: string | number;
}

/**
 * The response body of the options route (`datatableRoute(...).options`).
 * It is specific to the user and, unlike the meta, is not cached on the server.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DataTableFieldOptions {
  /** Version of the body schema; only known versions are read. */
  version: 1;
  /** The options of the field. */
  options: DataTableFieldOption[];
}

/** What the endpoint meta says about one field. */
export interface DataTableEndpointFieldMeta {
  /** The validation category of the field. */
  type: DataTableFieldType;
  /** The operators the backend accepts on this field; if empty, the field cannot be filtered. */
  filterOperators: FilterOperator[];
  /** Whether the field can be sorted. */
  sortable: boolean;
  /** Whether the global `search` covers this field. */
  searchable: boolean;
  /**
   * The filter options of the field can be fetched from the options route.
   * Treated as `false` when absent.
   *
   * @default false
   * @experimental May change in any release while the package is in 0.x.
   */
  hasOptions?: boolean;
}

/**
 * The EFFECTIVE limits (defaults applied) and the field whitelist of a query
 * endpoint. `describeDataTableEndpoint` in `@datatablex/fastify` produces it
 * and the `GET` meta route serves it.
 *
 * It is for ergonomics only: the client narrows its limits and column options
 * accordingly so the user does not run into predictable 400s. The security
 * boundary is always the validation on the server. Internal details such as
 * the database column mapping and the `sensitive` flag are deliberately not
 * carried.
 */
export interface DataTableEndpointMeta {
  /** Version of the meta schema; only known versions are read. */
  version: 1;
  /** The wire protocol: the server's default version and the versions it supports (see `DATATABLEX_PROTOCOL_VERSION`). */
  protocol: { version: number; supported: number[] };
  /** The field that uniquely identifies a record. */
  primaryKey: string;
  /**
   * Present when server-side export (the `/export` route) is enabled: the
   * supported formats and the row ceiling of a single export. Absent when the
   * endpoint has not enabled export.
   */
  export?: DataTableEndpointExportMeta;
  /** The effective limits of the endpoint. */
  limits: {
    /** Largest accepted `pageSize`. */
    maxPageSize: number;
    /** Deepest accepted nesting of the filter tree. */
    maxFilterDepth: number;
    /** Largest accepted number of filter leaves. */
    maxFilterCount: number;
    /** Largest accepted number of values in an `in`/`notIn` filter. */
    maxInValues: number;
    /** Longest accepted `search` text. */
    maxSearchLength: number;
    /** Largest accepted number of sort criteria. */
    maxSortCount: number;
    /** `null` = only the safe-integer bound applies. */
    maxOffset: number | null;
  };
  /** Per-field metadata, keyed by field name. */
  fields: Record<string, DataTableEndpointFieldMeta>;
}

/** Which formats and scopes an export offers. */
export interface ExportDefinition {
  /** The formats on offer. */
  formats: DataTableServerExportFormat[];
  /** The scopes on offer. */
  scopes: DataTableServerExportScope[];
}

/**
 * A column definition. It is serializable and carries no rendering, which is
 * what keeps this package free of a React dependency.
 */
export interface DataTableColumn<T> {
  /**
   * The column's IDENTITY: column state, persistence and menus. When neither
   * `field` nor `accessor` is given, it is also the backend field and the way
   * the value is read. If it changes, the saved layout is reset for that column.
   */
  key: Extract<keyof T, string> | (string & {});
  /**
   * The backend field: `Filter.field`, `Sort.field`, the URL and the endpoint
   * meta. `null` means the column has no backend counterpart (a computed
   * column): filtering and sorting are off.
   *
   * @default key
   */
  field?: string | null;
  /**
   * The raw value that is displayed and exported: a field name or a function.
   *
   * @default record[field ?? key]
   */
  accessor?: Extract<keyof T, string> | ((record: T) => unknown);
  /** The column heading. */
  title: string;
  /** The column's data type. */
  type?:
    | "text"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "time"
    | "currency"
    | "enum"
    | "custom";
  /** Whether the column can be sorted. */
  sortable?: boolean;
  /** Whether the column can be filtered. */
  filterable?: boolean;
  /**
   * Narrows WHICH operator the automatic filter component produces a leaf
   * with. It is UI metadata only and grants NO permission; the final authority
   * is `FieldConfig.filterOperators` on the backend. When absent, the default
   * for the type is used (for example text uses `contains`).
   * Example: for a backend that allows only exact matches on a sensitive field
   * (`sensitive: true`), `filterOperators: ["eq"]` makes the text box produce
   * `eq` instead of `contains`.
   */
  filterOperators?: FilterOperator[];
  /** Whether the global `search` scans this column; binding only in `LocalDataSource`. */
  searchable?: boolean;
  /** Column width. */
  width?: number;
  /** Pins the column to one side of the table. */
  fixed?: "left" | "right";
  /** Whether the column starts out hidden on first load. */
  defaultHidden?: boolean;
  /**
   * Only for type: "enum" - the automatic select/multi-select filter. When
   * given, no options are fetched from the server; when absent and the
   * endpoint meta reports `hasOptions` for the field, the list comes from the
   * server.
   */
  options?: DataTableFieldOption[];
  /** Only for type: "currency" - an ISO 4217 code (for example "EUR"). */
  currency?: string;
  /** Only for type: "date" | "datetime" - a DISPLAY conversion; the wire format is still UTC ISO 8601. */
  timezone?: string;
}

/**
 * The fields `queryInMemory` and `LocalDataSource` need for querying. A full
 * `DataTableColumn` is not required so that
 * `ReactDataTableColumn<T>` (title: ReactNode) can be passed without any
 * conversion or cast.
 */
export type QueryableColumn<T> = Pick<DataTableColumn<T>, "key" | "field" | "accessor" | "type" | "searchable">;

/** The export block of the endpoint meta. */
export interface DataTableEndpointExportMeta {
  /**
   * The formats the server produces and the row ceiling of each. The keys are
   * the enabled formats; the server does not produce a format that has no key.
   *
   * Export always works through the ticket and native download routes
   * (`<export>/ticket`, `<export>/download`): the file never enters browser
   * memory. The presence of the `export` block reports that these two routes
   * are registered.
   */
  formats: Partial<Record<DataTableServerExportFormat, number>>;
  /** The fields open to export; the client sends only these to the server export. */
  fields: string[];
}

/**
 * The response of `POST <export>/ticket`: a single-use download ticket.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DataTableExportTicket {
  /** The single-use ticket value. */
  ticket: string;
  /** The row count at the time of the ticket; the authoritative count is in the download's own snapshot (`x-datatablex-total`). */
  total: number;
  /** The name of the file to download. */
  filename: string;
  /** When the ticket expires, as an ISO 8601 timestamp. */
  expiresAt: string;
}

/**
 * The result of `DataSource.requestExport`: the ticket and the download
 * address derived from it.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DataTableExportDownload extends DataTableExportTicket {
  /** `GET <export>/download?ticket=…`; single-use. */
  downloadUrl: string;
}

/** The formats the server can produce by streaming. */
export type DataTableServerExportFormat = "csv" | "excel" | "pdf";

/** The scope of a server export; the same values as `ExportDefinition.scopes`. */
export type DataTableServerExportScope = "allFiltered" | "currentPage" | "selected";

/**
 * A server-side export request (`POST <endpoint>/export`). The query goes
 * through the same validation as `/query`; there is no pagination and the
 * result is streamed from a single snapshot. The order and headings of the
 * columns come from the client; the fields are validated against the
 * endpoint's export whitelist.
 *
 * @experimental May change in any release while the package is in 0.x.
 */
export interface DataTableExportRequest {
  /**
   * Goes through the same validation as `/query`. `pagination` is used only
   * in the `currentPage` scope; in the `selected` scope `filters` and `search`
   * are ignored (the file carries only the rows in `keys`, in the order of
   * `sorting`).
   */
  query: Omit<DataTableQuery, "pagination" | "skipCount"> & { pagination?: DataTableQuery["pagination"] };
  /** The format of the file to produce. */
  format: DataTableServerExportFormat;
  /**
   * The scope of the export.
   *
   * @default "allFiltered"
   */
  scope?: DataTableServerExportScope;
  /** Primary key values in the `selected` scope (required, at least one). */
  keys?: Array<string | number>;
  /** The PDF document title and metadata. */
  title?: string;
  /** The columns to export, in order, with the heading for each. */
  columns: Array<{ field: string; title: string }>;
  /**
   * The name of the downloaded file; the extension is added according to the
   * format.
   *
   * @default "export"
   */
  filename?: string;
}
