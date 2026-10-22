// Read every row of a paged source. PostgREST caps each response at the
// project's max_rows (was 1000 → 103 leads silently missing from the board,
// 2026-10-22), so full-table loads must page. Stops only on an EMPTY page, so
// it stays complete even if the server cap is below `pageSize`.
export async function fetchAllPages(fetchPage, pageSize = 1000) {
  const all = [];
  for (;;) {
    const rows = await fetchPage(all.length, pageSize);
    if (!rows || rows.length === 0) return all;
    all.push(...rows);
  }
}
