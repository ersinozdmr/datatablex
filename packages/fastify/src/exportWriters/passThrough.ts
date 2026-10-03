import { PassThrough } from "node:stream";
import { WRITER_HIGH_WATER_MARK } from "./types.js";

/**
 * Output of the CSV and XLSX writers. `writableNeedDrain` also shows when a pipe
 * in between (the zip stream in XLSX) has paused: a pipe writing into a full
 * `PassThrough` gets `false` and waits.
 */
export function createOutput(): { out: PassThrough; congested: () => boolean } {
  const out = new PassThrough();
  return {
    out,
    congested: () => out.writableNeedDrain || out.readableLength + out.writableLength >= WRITER_HIGH_WATER_MARK,
  };
}
