import type { theme } from "antd";
import type { Density } from "@datatablex/react";

/**
 * Maps each `Density` to a size that Ant Design's `<Table size>` accepts. The
 * table only accepts "large", "middle" and "small"; "compact", "xsmall" and
 * "mini" do not exist in Ant Design, so all three are mapped onto "small", the
 * smallest native size. The actual visual difference comes from the custom
 * padding values produced by `cellPadding()` below.
 */
export const ANTD_SIZE_FOR_DENSITY: Record<Density, "large" | "middle" | "small"> = {
  large: "large",
  middle: "middle",
  small: "small",
  compact: "small",
  xsmall: "small",
  mini: "small",
};

/**
 * Cell padding for a `density`. "large", "middle" and "small" mirror Ant
 * Design's own design tokens exactly (the `cellPaddingBlock` and
 * `cellPaddingInline` tokens and their `...MD` / `...SM` variants in the Table
 * styles), because these three are Ant Design's native sizes. "compact",
 * "xsmall" and "mini" have no Ant Design counterpart, so they are not derived
 * from a token; they are fixed pixel values.
 *
 * This is the single source for both `<th>` (the trigger button in
 * `ColumnHeaderMenu`; the `<th>`'s own padding is reduced to 0 through
 * `onHeaderCell`) and `<td>` (the `onCell` callback in `DataTable.tsx`). If the
 * two diverged, header and body rows would have different heights.
 */
export function cellPadding(token: ReturnType<typeof theme.useToken>["token"], density: Density): string {
  switch (density) {
    case "large":
      return `${token.padding}px ${token.padding}px`;
    case "middle":
      return `${token.paddingSM}px ${token.paddingXS}px`;
    case "small":
      return `${token.paddingXS}px ${token.paddingXS}px`;
    case "compact":
      return "6px 4px";
    case "xsmall":
      return "4px 2px";
    case "mini":
      return "2px 2px";
  }
}
