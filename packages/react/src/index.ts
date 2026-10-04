/**
 * `@datatablex/react`: the headless React layer of DataTableX. It exports the
 * `useDataTable` hook, the REST and local data sources, the export errors and
 * the types of the table contract. It has no UI library dependency.
 */
export type {
  ColumnOptionsState,
  ColumnState,
  Density,
  ExportFormat,
  ExportOutcome,
  ExportScope,
  ReactDataTableColumn,
  TableInstance,
  TableLimits,
  UrlStateAdapter,
  UseDataTableOptions,
} from "./types.js";
export { createHistoryAdapter } from "./state/historyAdapter.js";
export { useDataTable } from "./state/useDataTable.js";
export { createLocalDataSource } from "./query/createLocalDataSource.js";
export type { RestDataSourceOptions } from "./query/createRestDataSource.js";
export { DataTableRequestError, createRestDataSource, isDataTableRequestError } from "./query/createRestDataSource.js";
export { DataTableExportError, ExportBusyError, ExportRowLimitError, isExportBusyError, isExportRowLimitError } from "./export/errors.js";
export type { DocumentExporter } from "./export/exporter.js";
export type { ExportCell, ExportColumn } from "./export/exportFile.js";
