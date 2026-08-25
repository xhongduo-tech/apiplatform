export interface FiltersState {
  dateFrom: string;
  dateTo: string;
  modelFilter: string;
  statusFilter: string;
  keyNameFilter: string;
  departmentFilter?: string;
  requestIdFilter: string;
  tokenMin: number | null;
  tokenMax: number | null;
  ttftMin: number | null;
  ttftMax: number | null;
  durMin: number | null;
  durMax: number | null;
  cacheFilter: string;
  sortField: string;
  sortDir: "asc" | "desc";
}
