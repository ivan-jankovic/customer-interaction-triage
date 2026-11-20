import { describe, expect, it } from "vitest";
import { escapeHtml, html, isSafeHtml } from "../../../src/review/web/html.js";

describe("escapeHtml", () => {
  it("escapes each special character", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes already escaped text again (no double-decoding shortcuts)", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("html", () => {
  it("escapes interpolated strings, including script text and attribute breakouts", () => {
    const text = `<script>alert("x")</script>`;
    const attr = `" onmouseover="alert(1)`;
    const out = html`<p title="${attr}">${text}</p>`.toString();
    expect(out).toBe(
      `<p title="&quot; onmouseover=&quot;alert(1)">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>`,
    );
    expect(out).not.toContain("<script>");
  });

  it("passes nested html through unescaped", () => {
    const inner = html`<b>${"a<b"}</b>`;
    expect(html`<p>${inner}</p>`.toString()).toBe("<p><b>a&lt;b</b></p>");
  });

  it("joins arrays and escapes their items", () => {
    expect(html`<ul>${["<a>", html`<li>ok</li>`, ["x", 1]]}</ul>`.toString()).toBe("<ul>&lt;a&gt;<li>ok</li>x1</ul>");
  });

  it("renders null, undefined and numbers", () => {
    expect(html`[${null}][${undefined}][${0}][${0.75}]`.toString()).toBe("[][][0][0.75]");
  });

  it("returns a SafeHtml that only html makes", () => {
    expect(isSafeHtml(html`x`)).toBe(true);
    expect(isSafeHtml("x")).toBe(false);
    expect(isSafeHtml({ toString: () => "<b>" })).toBe(false);
  });

  it("escapes an object that only looks like SafeHtml", () => {
    const fake = { toString: () => "<b>" } as unknown as string;
    expect(html`${fake}`.toString()).toBe("&lt;b&gt;");
  });
});
