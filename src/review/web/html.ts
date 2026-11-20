// HTML for the review page (P13 requirements.md, "Safe rendering"). Message text, summaries,
// findings and notes are untrusted (P11), so the only way to build markup is the `html` tagged
// template, which escapes every interpolated value. Only SafeHtml values, which `html` itself
// returns, pass through unescaped; the class itself is not exported, so nothing else can make one.

class Safe {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  toString(): string {
    return this.#value;
  }
}

/** Markup built by `html`: its own text is trusted, every value in it was escaped. */
export type SafeHtml = Safe;

export const isSafeHtml = (v: unknown): v is SafeHtml => v instanceof Safe;

/**
 * What a template may interpolate. Booleans are left out on purpose: `${cond && html`…`}` would
 * print "false". Use `${cond ? html`…` : null}`; null and undefined render as nothing.
 */
export type HtmlValue = string | number | SafeHtml | null | undefined | readonly HtmlValue[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Safe) return value.toString();
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(render).join("");
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Safe(out);
}
