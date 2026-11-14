/** One display model for every Society Calculator tab that does not need a custom screen (rendered by one generic view). */
export type CellKind = 'money' | 'text' | 'int' | 'pct' | 'num';
export interface Kpi { label: string; value: number | string; kind?: CellKind; tone?: 'info' | 'success' | 'warning' | 'danger'; sub?: string }
export interface Table { title: string; columns: Array<{ key: string; label: string; kind?: CellKind }>; rows: Array<Record<string, any>>; totals?: Record<string, any> }
export interface CalcResult { kpis: Kpi[]; tables: Table[]; steps: string[]; notes: string[] }
export const emptyResult = (): CalcResult => ({ kpis: [], tables: [], steps: [], notes: [] });
