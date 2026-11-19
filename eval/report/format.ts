// Number formatting shared by the Markdown and HTML reports. Deterministic: no locale.

export const pct = (x: number | null, digits = 1) => (x === null ? "–" : `${(x * 100).toFixed(digits)}%`);
export const num = (x: number | null, digits = 2) => (x === null ? "–" : x.toFixed(digits));
export const usd = (x: number | null, digits = 4) => (x === null ? "–" : `$${x.toFixed(digits)}`);
export const ms = (x: number | null) => (x === null ? "–" : `${(x / 1000).toFixed(1)} s`);
export const int = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
