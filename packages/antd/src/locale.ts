import { createContext, useContext } from "react";
import type { DataTableErrorCode } from "@datatablex/core";
import type { ExportFormat } from "@datatablex/react";

/**
 * Every user-visible text that `<DataTable>` produces itself. Ant Design's own
 * component texts (pagination, the empty-state illustration and so on) are not
 * covered by this object; they are set with `ConfigProvider.locale`.
 *
 * The keys are deliberately flat: a partial override such as
 * `locale={{ apply: "Apply" }}` does not require rewriting a nested object.
 * Functions that take a column name receive the column's PLAIN TEXT NAME
 * (`columnLabel`): `exportTitle`, or `title` when it is a string, otherwise
 * `key`. Because a column title can be a `ReactNode`, this text is what screen
 * readers announce (for example "Stadium column menu").
 *
 * @example
 * Override a few texts; the rest comes from the default `enUS`:
 * ```tsx
 * <DataTable locale={{ apply: "Apply filters", emptyText: "Nothing here" }} ... />
 * ```
 *
 * @example
 * Build a full translation from an existing locale:
 * ```ts
 * import { enUS, type DataTableLocale } from "@datatablex/antd";
 *
 * const overrides: Partial<DataTableLocale> = { apply: "Apply", cancel: "Dismiss" };
 * export const myLocale: DataTableLocale = { ...enUS, ...overrides };
 * ```
 */
export interface DataTableLocale {
  // Toolbar
  /** Placeholder of the search box. */
  searchPlaceholder: string;
  /** Label of the column management button. */
  columns: string;
  /** Selection summary in the toolbar. */
  selectedCount: (count: number) => string;
  /** Label of the button that clears the row selection. */
  clearSelection: string;
  /** Text of the empty state when no row matches. */
  emptyText: string;
  /** Range summary in the pagination bar. `from`/`to` are 1-based; both are 0 when there are no records. */
  paginationTotal: (from: number, to: number, total: number) => string;

  // Default error view
  /** Title of the default error view. */
  errorTitle: string;
  /** Label of the button that retries the failed request. */
  retry: string;
  /** Label of the button that resets the query after an error. */
  clearQuery: string;
  /**
   * User-facing text for errors that carry a machine code (`DataTableErrorCode`).
   * The server's `message` is in the server's language: if the code has an entry
   * here, that text is shown; otherwise (a new or unknown code, a backend that
   * sends no code) it falls back to the `message`. `exportRowLimitClient`,
   * `exportRowLimitServer` and `exportBusy` are separate, parameterized keys.
   */
  errorMessages: Partial<Record<DataTableErrorCode, string>>;
  /**
   * Line with the server message that is appended below the generic text of a
   * `validation` error. The message is in the server's language and is not
   * translated (for example "filters.nationalId: a query can contain at most one
   * sensitive filter").
   */
  errorDetail: (serverMessage: string) => string;

  // Column management panel
  /** Name of the virtual selection column in the column panel. */
  selectionColumn: string;
  /** Header of the virtual row number column and its row in the panel. */
  rowNumberColumn: string;
  /** Accessible name of the button that moves a column up in the panel. */
  moveUp: (columnLabel: string) => string;
  /** Accessible name of the button that moves a column down in the panel. */
  moveDown: (columnLabel: string) => string;
  /** Label of the button that restores the default column layout. */
  resetView: string;
  /** Accessible name of a column's resize handle. */
  resizeHandle: (columnLabel: string) => string;

  // Column header menu
  /** Accessible name of the column header menu trigger. */
  columnMenu: (columnLabel: string) => string;
  /** Header menu item that opens the filter editor. */
  filter: string;
  /** Header menu item that opens the sort options. */
  sort: string;
  /** Sort option row. `direction` is one of the type-specific labels below. */
  sortOption: (direction: string) => string;
  /** Ascending sort label for text columns. */
  sortTextAsc: string;
  /** Descending sort label for text columns. */
  sortTextDesc: string;
  /** Ascending sort label for number columns. */
  sortNumberAsc: string;
  /** Descending sort label for number columns. */
  sortNumberDesc: string;
  /** Ascending sort label for date columns. */
  sortDateAsc: string;
  /** Descending sort label for date columns. */
  sortDateDesc: string;
  /** Header menu item that removes the sort of the column. */
  removeSort: string;
  /** Header menu item that turns on text wrapping for the column. */
  wrapContent: string;
  /** Header menu item that turns text wrapping off again. */
  unwrapContent: string;

  // Filter value editors (bar and builder)
  /** Placeholder of the lower bound input of a range filter. */
  minPlaceholder: string;
  /** Placeholder of the upper bound input of a range filter. */
  maxPlaceholder: string;
  /** Accessible name of the lower bound input. */
  minInput: (columnLabel: string) => string;
  /** Accessible name of the upper bound input. */
  maxInput: (columnLabel: string) => string;
  /** Accessible name of the start date input. */
  dateFromInput: (columnLabel: string) => string;
  /** Accessible name of the end date input. */
  dateToInput: (columnLabel: string) => string;
  /** Label of the true option of a boolean filter. */
  yes: string;
  /** Label of the false option of a boolean filter. */
  no: string;
  /** Label of the button that applies a filter. */
  apply: string;

  // Export menu
  /** Label of the export menu button. */
  export: string;
  /** Progress text while an export is running. */
  exporting: (current: number, total: number) => string;
  /** Heading of the export scope choices. */
  exportScope: string;
  /** Heading of the export format choices. */
  exportFormat: string;
  /** Scope option: the rows of the current page. */
  scopeCurrentPage: string;
  /** Scope option: all rows that match the current filters. */
  scopeAllFiltered: string;
  /** Scope option: the selected rows. */
  scopeSelected: string;
  /** Message shown when an export fails. */
  exportFailed: string;
  /** The browser limit (`maxClientExportRows`) was exceeded; `format` is the format that exceeds it. */
  exportRowLimitClient: (maxRows: number, format?: ExportFormat) => string;
  /** The server export limit (`export.maxRows`) was exceeded. */
  exportRowLimitServer: (maxRows: number) => string;
  /** The server is at its limit of concurrent streaming exports (HTTP 429). */
  exportBusy: string;
  /** The download has started. The file is in the browser's download list; on the server path, progress and cancellation are there too. */
  exportStarted: string;
  /** Label of the button that stops a long export (next to the menu button while an export runs). */
  cancelExport: string;
  /** Title and metadata of the PDF document. */
  exportDocumentTitle: string;
  /** While the table is loading, the "This page" export is disabled because it is not clear which query the rows on screen belong to. */
  exportWaitForLoad: string;

  // Filter bar
  /** Accessible name of the filter bar. */
  filterBar: string;
  /** Label of the button that adds a filter rule. */
  addFilter: string;
  /** Label of the button that removes all filters. */
  clearAllFilters: string;
  /** Accessible name of a chip's edit button. `summary` is the "field condition value" text. */
  editFilter: (summary: string) => string;
  /** Accessible name of a chip's remove button. */
  removeFilter: (summary: string) => string;
  /** Read-only summary of a filter node that the bar cannot represent (for example `OR` or nested filters). */
  externalFilter: (count: number) => string;
  /** Accessible name of a locked filter chip. */
  lockedFilter: (summary: string) => string;
  /** Tooltip of a locked filter chip. */
  lockedFilterHint: string;
  /** Label of the field selector of a rule. */
  filterField: string;
  /** Label of the operator selector of a rule. */
  filterOperator: string;
  /** Label of the value editor of a rule. */
  filterValue: string;
  /** Shown in the value editor while the enum options are awaited from the server. */
  optionsLoading: string;
  /** Shown in the editor when the selected field's options could not be loaded or came back empty. */
  optionsUnavailable: string;
  /** Message shown when the maximum number of rules is reached. */
  filterLimitReached: (max: number) => string;
  /** Shown next to negative operators: rows with NULL are excluded because of SQL three-valued logic. */
  nullsExcludedHint: string;
  /** Operator label: contains. */
  opContains: string;
  /** Operator label: does not contain. */
  opNotContains: string;
  /** Operator label: equals. */
  opEq: string;
  /** Operator label: does not equal. */
  opNeq: string;
  /** Operator label: starts with. */
  opStartsWith: string;
  /** Operator label: does not start with. */
  opNotStartsWith: string;
  /** Operator label: ends with. */
  opEndsWith: string;
  /** Operator label: does not end with. */
  opNotEndsWith: string;
  /** Operator label: greater than. */
  opGt: string;
  /** Operator label: greater than or equal. */
  opGte: string;
  /** Operator label: less than. */
  opLt: string;
  /** Operator label: less than or equal. */
  opLte: string;
  /** Operator label: between. */
  opBetween: string;
  /** Operator label: on a given day. */
  opOnDay: string;
  /** Operator label: on or after a given day. */
  opOnOrAfter: string;
  /** Operator label: on or before a given day. */
  opOnOrBefore: string;
  /** Operator label: between two dates. */
  opDayBetween: string;
  /** Operator label: is any of. */
  opIn: string;
  /** Operator label: is none of. */
  opNotIn: string;
  /** Operator label: is empty (NULL). */
  opIsNull: string;
  /** Operator label: is not empty. */
  opIsNotNull: string;

  // Advanced builder
  /** Label of the button that opens the advanced builder. */
  advancedFilter: string;
  /** Label of the first row of a group. */
  where: string;
  /** Label of the `AND` connective. */
  connectiveAnd: string;
  /** Label of the `OR` connective. */
  connectiveOr: string;
  /** Accessible name of a group's connective selector. */
  connective: string;
  /** Accessible name of a group that requires all conditions; it states the connective. */
  groupAll: string;
  /** Accessible name of a group that requires any condition; it states the connective. */
  groupAny: string;
  /** Label of a freshly added rule that is not filled in yet. */
  newRule: string;
  /** Label of the button that adds a rule to a group. */
  addRule: string;
  /** Label of the button that adds a nested group. */
  addGroup: string;
  /** Accessible name of the button that duplicates a rule or group. */
  duplicateNode: (label: string) => string;
  /** Accessible name of the button that deletes a rule or group. */
  deleteNode: (label: string) => string;
  /** Label of a condition that the builder cannot edit. */
  externalCondition: string;
  /** Label of the button that discards the draft. */
  cancel: string;
  /** Message shown when the draft contains rules that are not filled in. */
  incompleteRules: (count: number) => string;
  /** Datetime day rules are compiled into a `gte` + `lt` group, so they count as one more level. */
  depthLimitReached: (max: number) => string;
  /** Message shown when the filters changed outside the builder while a draft is open. */
  filtersChangedElsewhere: string;
  /** Label of the button that reloads the draft from the current filters. */
  reloadDraft: string;

  // Chip action menu (advanced mode)
  /** Accessible name of the chip action menu trigger. */
  chipActions: (summary: string) => string;
  /** Chip menu item: edit the rule in place. */
  menuEdit: string;
  /** Chip menu item: duplicate the rule. */
  menuDuplicate: string;
  /** Chip menu item: open the rule in the advanced builder. */
  menuOpenInBuilder: string;
  /** Chip menu item: remove the rule. */
  menuRemove: string;
}

/**
 * Turkish texts for `<DataTable>`. This is a shipped option; the default locale
 * is `enUS`.
 *
 * @example
 * ```tsx
 * import { DataTable, trTR } from "@datatablex/antd";
 *
 * <DataTable locale={trTR} ... />
 * ```
 */
export const trTR: DataTableLocale = {
  searchPlaceholder: "Ara...",
  columns: "Kolonlar",
  selectedCount: (count) => `${count} kayıt seçili`,
  clearSelection: "Seçimi Temizle",
  emptyText: "Kayıt bulunamadı",
  paginationTotal: (from, to, total) => `Toplam ${total} kayıttan ${from}–${to} arası gösteriliyor`,

  errorTitle: "Bir hata oluştu",
  retry: "Yeniden Dene",
  clearQuery: "Sorguyu Temizle",
  errorMessages: {
    unsupported_protocol: "İstemci ve sunucu paketleri farklı protokol sürümlerinde. Paketleri aynı sürüme yükseltin.",
    forbidden: "Bu işlem için yetkiniz yok.",
    export_forbidden: "Dışa aktarma yetkiniz yok.",
    validation: "Sorgu geçersiz. Filtreleri, aramayı ya da sıralamayı değiştirin.",
    field_not_allowed: "Sorgu bu tabloda izin verilmeyen bir alan ya da koşul içeriyor.",
    invalid_filter_value: "Bir filtre değeri geçersiz.",
    search_not_supported: "Bu tabloda arama yapılamaz.",
    export_disabled: "Bu tabloda dışa aktarma kapalı.",
    export_too_large: "Dışa aktarma çok fazla satır içeriyor. Filtreleri daraltın.",
    export_busy: "Sunucu şu an başka dışa aktarımları hazırlıyor. Biraz sonra yeniden deneyin.",
    ticket_gone: "İndirme bağlantısının süresi doldu. Dışa aktarmayı yeniden başlatın.",
    export_failed: "Dışa aktarma başlatılamadı.",
    options_too_large: "Bu alanın seçenek listesi sunucu sınırını aşıyor.",
    internal_error: "Sunucuda beklenmeyen bir hata oluştu. Biraz sonra yeniden deneyin.",
    no_rows_selected: "Seçili satır yok.",
    export_table_loading: "Tablo yüklenirken bu sayfa dışa aktarılamaz.",
    export_no_columns: "Dışa aktarılacak görünür kolon yok.",
    export_selection_key: "Seçili satırlar dışa aktarılamaz: satır anahtarı sunucunun birincil anahtarıyla eşleşmiyor.",
    export_incomplete: "Dışa aktarma tamamlanamadı: sunucu beklenen tüm satırları döndürmedi.",
  },
  errorDetail: (serverMessage) => `Ayrıntı (sunucu): ${serverMessage}`,

  selectionColumn: "Seçim",
  rowNumberColumn: "No",
  moveUp: (key) => `${key} yukarı taşı`,
  moveDown: (key) => `${key} aşağı taşı`,
  resetView: "Görünümü Sıfırla",
  resizeHandle: (key) => `${key} kolon genişliği — ok tuşlarıyla ayarlayın`,

  columnMenu: (key) => `${key} kolon menüsü`,
  filter: "Filtrele",
  sort: "Sırala",
  sortOption: (direction) => `Sırala ${direction}`,
  sortTextAsc: "A → Z",
  sortTextDesc: "Z → A",
  sortNumberAsc: "Küçükten Büyüğe",
  sortNumberDesc: "Büyükten Küçüğe",
  sortDateAsc: "Eskiden Yeniye",
  sortDateDesc: "Yeniden Eskiye",
  removeSort: "Sıralamayı Kaldır",
  wrapContent: "İçeriği Kaydır",
  unwrapContent: "Kaydırmayı Kaldır",

  minPlaceholder: "En az",
  maxPlaceholder: "En çok",
  minInput: (key) => `${key} en az`,
  maxInput: (key) => `${key} en çok`,
  dateFromInput: (key) => `${key} başlangıç tarihi`,
  dateToInput: (key) => `${key} bitiş tarihi`,
  yes: "Evet",
  no: "Hayır",
  apply: "Uygula",

  export: "Dışa Aktar",
  exporting: (current, total) => `İndiriliyor (${current}/${total})`,
  exportScope: "Kapsam",
  exportFormat: "Biçim",
  scopeCurrentPage: "Bu sayfa",
  scopeAllFiltered: "Filtrelenenler",
  scopeSelected: "Seçililer",
  exportFailed: "Export oluşturulamadı.",
  exportRowLimitClient: (maxRows, format) =>
    format === "csv"
      ? `Tarayıcıda en fazla ${maxRows.toLocaleString("tr-TR")} satır CSV olarak dışa aktarılabilir. Filtreleri daraltın.`
      : `Bu biçim en fazla ${maxRows.toLocaleString("tr-TR")} satır üretir. CSV seçin ya da filtreleri daraltın.`,
  exportRowLimitServer: (maxRows) => `Export en fazla ${maxRows.toLocaleString("tr-TR")} satır olabilir. Filtreleri daraltın.`,
  exportBusy: "Sunucu şu an başka dışa aktarımları hazırlıyor. Biraz sonra yeniden deneyin.",
  exportStarted: "İndirme başladı. Dosyayı tarayıcının indirmelerinde bulabilirsiniz.",
  cancelExport: "İptal",
  exportDocumentTitle: "Dışa Aktarım",
  exportWaitForLoad: "Tablo yüklenirken bu sayfa dışa aktarılamaz.",

  // Filter bar
  filterBar: "Filtreler",
  addFilter: "Filtre ekle",
  clearAllFilters: "Tümünü temizle",
  editFilter: (summary) => `${summary} — düzenle`,
  removeFilter: (summary) => `${summary} filtresini kaldır`,
  externalFilter: (count) => `Harici filtre (${count} kural)`,
  lockedFilter: (summary) => `Kilitli filtre: ${summary}`,
  lockedFilterHint: "Bu filtre uygulama tarafından verilir ve kaldırılamaz.",
  filterField: "Alan",
  filterOperator: "Koşul",
  filterValue: "Değer",
  optionsLoading: "Seçenekler yükleniyor…",
  optionsUnavailable: "Bu alanın seçenekleri alınamadı; filtre kullanılamıyor.",
  filterLimitReached: (max) => `En fazla ${max} kural eklenebilir.`,
  nullsExcludedHint: "(boş değerler hariç)",
  opContains: "içerir",
  opNotContains: "içermez",
  opEq: "eşittir",
  opNeq: "eşit değil",
  opStartsWith: "ile başlar",
  opNotStartsWith: "ile başlamaz",
  opEndsWith: "ile biter",
  opNotEndsWith: "ile bitmez",
  opGt: "büyüktür",
  opGte: "büyük veya eşit",
  opLt: "küçüktür",
  opLte: "küçük veya eşit",
  opBetween: "arasında",
  opOnDay: "şu gün",
  opOnOrAfter: "şu günden itibaren",
  opOnOrBefore: "şu güne kadar",
  opDayBetween: "tarihleri arasında",
  opIn: "şunlardan biri",
  opNotIn: "şunların hiçbiri",
  opIsNull: "Boş (NULL)",
  opIsNotNull: "Boş değil (NULL değil)",

  advancedFilter: "Gelişmiş",
  where: "Nerede",
  connectiveAnd: "ve",
  connectiveOr: "veya",
  connective: "Bağlaç",
  groupAll: "Grup: koşulların tümü",
  groupAny: "Grup: koşulların herhangi biri",
  newRule: "Yeni kural",
  addRule: "Kural ekle",
  addGroup: "Grup ekle",
  duplicateNode: (label) => `${label} — çoğalt`,
  deleteNode: (label) => `${label} — sil`,
  externalCondition: "Harici koşul",
  cancel: "Vazgeç",
  incompleteRules: (count) => `${count} kural eksik`,
  depthLimitReached: (max) => `En fazla ${max} seviye iç içe grup kurulabilir; tarih aralığı kuralları bir seviye daha sayılır.`,
  filtersChangedElsewhere: "Filtreler başka bir yerden değişti.",
  reloadDraft: "Yeniden yükle",

  chipActions: (summary) => `${summary} — işlemler`,
  menuEdit: "Düzenle",
  menuDuplicate: "Çoğalt",
  menuOpenInBuilder: "Kurucuda aç",
  menuRemove: "Sil",
};

/**
 * English texts for `<DataTable>`. This is the default locale.
 *
 * @example
 * ```ts
 * const myLocale: DataTableLocale = { ...enUS, apply: "Apply" };
 * ```
 */
export const enUS: DataTableLocale = {
  searchPlaceholder: "Search...",
  columns: "Columns",
  selectedCount: (count) => `${count} selected`,
  clearSelection: "Clear Selection",
  emptyText: "No records found",
  paginationTotal: (from, to, total) => `Showing ${from}–${to} of ${total}`,

  errorTitle: "Something went wrong",
  retry: "Retry",
  clearQuery: "Clear Query",
  errorMessages: {
    unsupported_protocol: "The client and server packages use different protocol versions. Upgrade them to the same version.",
    forbidden: "You do not have permission for this action.",
    export_forbidden: "You do not have permission to export.",
    validation: "The query is invalid. Change the filters, search or sorting.",
    field_not_allowed: "The query uses a field or condition that is not allowed on this table.",
    invalid_filter_value: "A filter value is invalid.",
    search_not_supported: "This table cannot be searched.",
    export_disabled: "Export is turned off for this table.",
    export_too_large: "The export contains too many rows. Narrow the filters.",
    export_busy: "The server is preparing other exports. Try again shortly.",
    ticket_gone: "The download link has expired. Start the export again.",
    export_failed: "The export could not be started.",
    options_too_large: "The option list for this field exceeds the server limit.",
    internal_error: "An unexpected server error occurred. Try again shortly.",
    no_rows_selected: "No rows are selected.",
    export_table_loading: "This page cannot be exported while the table is loading.",
    export_no_columns: "There are no visible columns to export.",
    export_selection_key: "The selected rows cannot be exported: the row key does not match the server primary key.",
    export_incomplete: "The export could not be completed: the server did not return all expected rows.",
  },
  errorDetail: (serverMessage) => `Details (server): ${serverMessage}`,

  selectionColumn: "Selection",
  rowNumberColumn: "No",
  moveUp: (key) => `Move ${key} up`,
  moveDown: (key) => `Move ${key} down`,
  resetView: "Reset View",
  resizeHandle: (key) => `${key} column width — adjust with arrow keys`,

  columnMenu: (key) => `${key} column menu`,
  filter: "Filter",
  sort: "Sort",
  sortOption: (direction) => `Sort ${direction}`,
  sortTextAsc: "A → Z",
  sortTextDesc: "Z → A",
  sortNumberAsc: "smallest to largest",
  sortNumberDesc: "largest to smallest",
  sortDateAsc: "oldest to newest",
  sortDateDesc: "newest to oldest",
  removeSort: "Remove Sort",
  wrapContent: "Wrap Content",
  unwrapContent: "Unwrap Content",

  minPlaceholder: "Min",
  maxPlaceholder: "Max",
  minInput: (key) => `${key} min`,
  maxInput: (key) => `${key} max`,
  dateFromInput: (key) => `${key} start date`,
  dateToInput: (key) => `${key} end date`,
  yes: "Yes",
  no: "No",
  apply: "Apply",

  export: "Export",
  exporting: (current, total) => `Exporting (${current}/${total})`,
  exportScope: "Scope",
  exportFormat: "Format",
  scopeCurrentPage: "This page",
  scopeAllFiltered: "Filtered rows",
  scopeSelected: "Selected rows",
  exportFailed: "Export failed.",
  exportRowLimitClient: (maxRows, format) =>
    format === "csv"
      ? `At most ${maxRows.toLocaleString("en-US")} rows can be exported as CSV in the browser. Narrow the filters.`
      : `This format supports at most ${maxRows.toLocaleString("en-US")} rows. Choose CSV or narrow the filters.`,
  exportRowLimitServer: (maxRows) => `An export can contain at most ${maxRows.toLocaleString("en-US")} rows. Narrow the filters.`,
  exportBusy: "The server is busy with other exports. Try again in a moment.",
  exportStarted: "Download started. You can find the file in your browser's downloads.",
  cancelExport: "Cancel",
  exportDocumentTitle: "Export",
  exportWaitForLoad: "This page cannot be exported while the table is loading.",

  filterBar: "Filters",
  addFilter: "Add filter",
  clearAllFilters: "Clear all",
  editFilter: (summary) => `${summary} — edit`,
  removeFilter: (summary) => `Remove filter ${summary}`,
  externalFilter: (count) => `External filter (${count} rules)`,
  lockedFilter: (summary) => `Locked filter: ${summary}`,
  lockedFilterHint: "This filter is set by the application and cannot be removed.",
  filterField: "Field",
  filterOperator: "Condition",
  filterValue: "Value",
  optionsLoading: "Loading options…",
  optionsUnavailable: "The options for this field could not be loaded; the filter is unavailable.",
  filterLimitReached: (max) => `At most ${max} rules can be added.`,
  nullsExcludedHint: "(empty values excluded)",
  opContains: "contains",
  opNotContains: "does not contain",
  opEq: "equals",
  opNeq: "does not equal",
  opStartsWith: "starts with",
  opNotStartsWith: "does not start with",
  opEndsWith: "ends with",
  opNotEndsWith: "does not end with",
  opGt: "greater than",
  opGte: "greater than or equal",
  opLt: "less than",
  opLte: "less than or equal",
  opBetween: "between",
  opOnDay: "on",
  opOnOrAfter: "on or after",
  opOnOrBefore: "on or before",
  opDayBetween: "between dates",
  opIn: "is any of",
  opNotIn: "is none of",
  opIsNull: "Empty (NULL)",
  opIsNotNull: "Not empty (NOT NULL)",

  advancedFilter: "Advanced",
  where: "Where",
  connectiveAnd: "and",
  connectiveOr: "or",
  connective: "Connective",
  groupAll: "Group: all conditions",
  groupAny: "Group: any condition",
  newRule: "New rule",
  addRule: "Add rule",
  addGroup: "Add group",
  duplicateNode: (label) => `Duplicate ${label}`,
  deleteNode: (label) => `Delete ${label}`,
  externalCondition: "External condition",
  cancel: "Cancel",
  incompleteRules: (count) => `${count} incomplete rule(s)`,
  depthLimitReached: (max) => `Groups can be nested at most ${max} levels; date range rules count as one more level.`,
  filtersChangedElsewhere: "Filters were changed elsewhere.",
  reloadDraft: "Reload",

  chipActions: (summary) => `${summary} — actions`,
  menuEdit: "Edit",
  menuDuplicate: "Duplicate",
  menuOpenInBuilder: "Open in builder",
  menuRemove: "Remove",
};

/**
 * `<DataTable>` passes the locale to its sub-components through this context.
 * The default value is `enUS`, so a part such as `ExportMenu` still has texts
 * when it is rendered on its own.
 */
export const DataTableLocaleContext = createContext<DataTableLocale>(enUS);

/** Reads the `DataTableLocale` provided by the nearest `<DataTable>`; falls back to `enUS`. */
export function useDataTableLocale(): DataTableLocale {
  return useContext(DataTableLocaleContext);
}
