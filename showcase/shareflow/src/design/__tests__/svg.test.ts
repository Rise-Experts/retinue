/** The `svg` artifact sanitizer — #607 part 3. */
import { describe, expect, it } from "vitest";
import { SvgError, sanitizeSvg } from "../svg.js";

const CIRCLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#2563eb"/></svg>';

describe("sanitizeSvg", () => {
  it("keeps a clean drawing as it was", () => {
    const { svg, removed } = sanitizeSvg(CIRCLE);
    expect(svg).toBe(CIRCLE);
    expect(removed).toEqual([]);
  });

  it("adds the namespace an <img> needs to draw it", () => {
    const { svg } = sanitizeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">')).toBe(true);
  });

  it("adds the xlink namespace when an xlink attribute is used", () => {
    const { svg } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0"/></defs><use xlink:href="#p"/></svg>');
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(svg).toContain('<use xlink:href="#p"/>');
  });

  it("drops <script> with its content, however it is written", () => {
    for (const input of [
      '<svg><script>alert(1)</script><rect/></svg>',
      '<svg><script type="text/javascript"><![CDATA[alert(1)]]></script><rect/></svg>',
      '<svg><svg:script>alert(1)</svg:script><rect/></svg>',
      '<svg><SCRIPT>alert(1)</SCRIPT><rect/></svg>',
    ]) {
      const { svg, removed } = sanitizeSvg(input);
      expect(svg, input).not.toMatch(/script|alert/i);
      expect(svg, input).toContain("<rect/>");
      expect(removed.length, input).toBe(1);
    }
  });

  it("drops foreignObject, iframes, embeds and <set>", () => {
    const { svg } = sanitizeSvg(
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><iframe src="https://evil"/><embed src="x"/><set attributeName="href" to="javascript:alert(1)"/><g/></svg>',
    );
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
  });

  it("drops an animation that rewrites a link", () => {
    const { svg } = sanitizeSvg('<svg><a href="#x"><animate attributeName="href" values="javascript:alert(1)"/><text>t</text></a></svg>');
    expect(svg).not.toMatch(/animate|javascript/);
    expect(svg).toContain("<text>t</text>");
  });

  it("strips every on* attribute", () => {
    const { svg, removed } = sanitizeSvg('<svg onload="alert(1)"><rect onClick="x()" ONMOUSEOVER="y()" width="2"/></svg>');
    expect(svg).not.toMatch(/on\w+=/i);
    expect(svg).toContain('width="2"');
    expect(removed).toEqual(expect.arrayContaining(["onload", "onClick", "ONMOUSEOVER"]));
  });

  it("keeps fragment and data:image links, and strips every other href", () => {
    const { svg, removed } = sanitizeSvg(
      '<svg><use href="#a"/><image href="data:image/png;base64,AAAA"/><image href="https://evil.example/x.png"/><a xlink:href="javascript:alert(1)"><text>x</text></a><a href="&#106;avascript:alert(1)"/><a href="java\tscript:alert(1)"/><image href="data:text/html,&lt;script&gt;"/></svg>',
    );
    expect(svg).toContain('<use href="#a"/>');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).not.toMatch(/evil|javascript|data:text/i);
    expect(removed).toHaveLength(5);
  });

  it("neutralises external url() and @import in styles", () => {
    const { svg } = sanitizeSvg(
      '<svg><style>@import url(https://evil/x.css); .a{fill:url(#g)} .b{background:url("https://evil/y.png")}</style><rect style="fill:url(https://evil/z)" class="a"/><rect fill="url(http://evil/q)"/><rect fill="url(#g)"/></svg>',
    );
    expect(svg).not.toMatch(/evil|@import/);
    expect(svg).toContain("fill:url(#g)");
    expect(svg).toContain('fill="url(#g)"');
  });

  it("drops comments, the XML declaration and a plain DOCTYPE", () => {
    const { svg } = sanitizeSvg('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<!-- hi --><svg><!-- inner --><g/></svg>\n');
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
  });

  it("refuses entity declarations", () => {
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')).toThrow(SvgError);
  });

  it("refuses anything that is not exactly one <svg> root", () => {
    for (const input of [
      "",
      "just text",
      "<div><svg/></div>",
      "<svg/><svg/>",
      "hello <svg/>",
      "<svg><g></svg>",
      "<svg><g>",
      "</svg>",
      '<svg width="1><g/></svg>',
      "<svg><1bad/></svg>",
    ]) {
      expect(() => sanitizeSvg(input), JSON.stringify(input)).toThrow(SvgError);
    }
  });

  it("escapes text so it can never close a tag", () => {
    const { svg } = sanitizeSvg("<svg><text>a &amp; b > c &x</text></svg>");
    expect(svg).toContain("<text>a &amp; b &gt; c &amp;x</text>");
  });

  it("is idempotent", () => {
    const once = sanitizeSvg('<svg viewBox="0 0 4 4" onload="x"><style>.a{fill:red}</style><rect class="a" width="4" height="4"/><text>&lt;hi&gt;</text></svg>').svg;
    expect(sanitizeSvg(once).svg).toBe(once);
  });
});
