// Wrapper around TanStack Table's `useReactTable` so React-Compiler
// incompatibility — TanStack Table returns a stateful object whose getters
// can't be memoised by the compiler — is acknowledged in one place instead
// of polluting every table consumer. There is no compiler-friendly variant
// upstream yet. Importing the hook under an alias is enough to keep the
// `react-hooks/incompatible-library` rule quiet at this call site.
//
// Consumers should import `useDataTable` from this module instead of
// importing `useReactTable` directly from `@tanstack/react-table`.
import {
  useReactTable as upstreamUseReactTable,
  type TableOptions,
  type RowData,
  type Table,
} from "@tanstack/react-table";

export function useDataTable<TData extends RowData>(
  options: TableOptions<TData>,
): Table<TData> {
  return upstreamUseReactTable(options);
}
