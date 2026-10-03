import { createRequire } from "node:module";
import type { DataTableServerExportFormat } from "@datatablex/core";

/**
 * `exceljs` and `pdfkit` are optional peer dependencies of this package: only a
 * consumer that enables the format installs them. Whether they are installed is
 * checked at boot (synchronously), so a missing package surfaces as a clear
 * error when the application starts, not on the first export request. Loading
 * happens on first use, with a dynamic `import()`.
 */
const PACKAGE_BY_FORMAT: Partial<Record<DataTableServerExportFormat, string>> = { excel: "exceljs", pdf: "pdfkit" };

const require = createRequire(import.meta.url);

/**
 * Checks that the optional peer package a format needs can be resolved.
 *
 * @throws {Error} When the package for `format` is not installed.
 */
export function assertExportPackageInstalled(format: DataTableServerExportFormat): void {
  const name = PACKAGE_BY_FORMAT[format];
  if (!name) return;
  try {
    require.resolve(name);
  } catch {
    throw new Error(`export.formats includes "${format}" but "${name}" is not installed — \`npm install ${name}\` (optional peer)`);
  }
}

/** Unwraps a CJS package loaded from ESM: Node exposes `module.exports` as `default`. */
function interop<T>(mod: unknown): T {
  return ((mod as { default?: T }).default ?? mod) as T;
}

/** Loads `exceljs` on first use. */
export async function loadExcelJS(): Promise<typeof import("exceljs")> {
  return interop(await import("exceljs"));
}

/** Loads `pdfkit` on first use. */
export async function loadPdfKit(): Promise<typeof import("pdfkit")> {
  return interop(await import("pdfkit"));
}
