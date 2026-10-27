import { describe, expect, it } from "vitest";

import {
  findThirdPartyRisks,
  hasInlineScript,
  hasInlineStyle,
  inlineScriptFinding,
  sourceKindOf,
  srcdocFinding,
} from "./support/third-party";

const htmlBypasses: Readonly<Record<string, string>> = {
  "an inline script that injects a script element":
    "<script>var s=document.createElement('script');s.src='https://www.googletagmanager.com/gtm.js?id=GTM-X';document.head.appendChild(s)</script>",
  "a module script that imports a remote module":
    '<script type="module">import "https://cdn.example/x.js"</script>',
  "an inline style that imports a remote font":
    '<style>@import "https://fonts.googleapis.com/css2?family=Roboto";</style>',
  "a second srcset candidate":
    '<img src="/a.png" srcset="/a.png 1x, https://cdn.example/b.png 2x">',
  "a Tailwind arbitrary value in a class":
    '<div class="bg-[url(https://cdn.example/x.png)]"></div>',
  "a protocol-relative link": '<link rel="stylesheet" href="//fonts.googleapis.com/css2">',
  "escaped slashes in an inline script": '<script>s.src="https:\\/\\/cdn.example/x.js"</script>',
  "unicode-escaped slashes in an inline script":
    '<script>s.src="\\u002f\\u002fcdn.example/x.js"</script>',
  "a newline escape between the slashes": '<script>s.src="/\\n/cdn.example/x.js"</script>',
  "numeric character references": '<img src="&#47;&#x2F;cdn.example/x.png">',
  "named character references": '<img src="&sol;&sol;cdn.example/x.png">',
  "a tab inside the slashes": '<img src="/&Tab;/cdn.example/x.png">',
  "a raw newline inside the slashes": '<img src="/\n/cdn.example/x.png">',
  "backslashes in place of slashes": '<img src="\\\\cdn.example/x.png">',
  "a special scheme without slashes": '<img src="http:cdn.example/x.png">',
  "an upper-case scheme without slashes": '<img src="HTTPS:cdn.example/x.png">',
  "a data URL in an iframe with percent-encoded slashes":
    '<iframe src="data:text/html,%3Cscript%20src=%22%2F%2Fcdn.example/x.js%22%3E%3C/script%3E"></iframe>',
  "a double-encoded srcdoc":
    '<iframe srcdoc="&lt;img src=&quot;&amp;sol;&amp;sol;cdn.example/x.png&quot;&gt;"></iframe>',
  "double-encoded slashes in an attribute": '<img src="&amp;sol;&amp;sol;cdn.example/x.png">',
  "an encoded colon in a javascript URL": '<a href="javascript&colon;void(0)">x</a>',
  "a JS legacy octal escape in an inline script":
    "<script>s.src='https:\\57\\57cdn.example/x.js'</script>",
  "a URL built at run time in an inline script":
    "<script>s.src='https:'+'//'+host+'/x.js'</script>",
};

const cssBypasses: Readonly<Record<string, string>> = {
  "an external font-face": '@font-face{font-family:R;src:url("https://fonts.gstatic.com/r.woff2")}',
  "a compiled Tailwind arbitrary value":
    ".bg-\\[url\\(https\\:\\/\\/cdn\\.example\\/x\\.png\\)\\]{background-image:url(https://cdn.example/x.png)}",
  "a remote import": '@import url("https://fonts.googleapis.com/css2?family=Roboto");',
  "CSS hex escapes for the slashes": ".x{background:url(\\2f \\2f cdn.example/x.png)}",
  "a Tailwind license banner with another URL":
    "/*! tailwindcss v4.3.3 | MIT License | https://cdn.example/x.css */",
  "a data URL without slashes": ".x{background:url(data:image/png;base64,AAAA)}",
  "a percent-encoded protocol-relative URL": ".x{background:url(%2F%2Fcdn.example/x.png)}",
};

const scriptBypasses: Readonly<Record<string, string>> = {
  "a JS dynamic import": 'import("https://cdn.example/x.js");',
  "a JS hex escape": 'fetch("\\x2f\\x2fcdn.example/x.json");',
  "a JS braced unicode escape": 'fetch("\\u{2f}\\u{2f}cdn.example/x.json");',
  "a JS legacy octal escape": "s.src='https:\\57\\57cdn.example/x.js';",
  "a JS legacy octal escape without a scheme": "s.src='\\57\\57cdn.example/x.js';",
  "a URL built at run time": "s.src='https:'+'//'+host+'/x.js';",
  "a websocket scheme": "new WebSocket('wss:cdn.example/socket');",
  "a blob URL": "img.src='blob:'+id;",
  "a percent-encoded protocol-relative URL": "fetch('%2F%2Fcdn.example/x.json');",
  "percent-encoding inside a character reference": "fetch('&#37;2F&#37;2Fcdn.example/x.json');",
  "escaped slashes in JSON": '{"src":"https:\\/\\/cdn.example/x.js"}',
};

describe("findThirdPartyRisks bypass cases", () => {
  for (const [name, markup] of Object.entries(htmlBypasses)) {
    it(`flags ${name} in HTML`, () => {
      expect(findThirdPartyRisks(markup, "markup")).not.toEqual([]);
    });
  }

  for (const [name, source] of Object.entries(cssBypasses)) {
    it(`flags ${name} in CSS`, () => {
      expect(findThirdPartyRisks(source, "css")).not.toEqual([]);
    });
  }

  for (const [name, source] of Object.entries(scriptBypasses)) {
    it(`flags ${name} in JS`, () => {
      expect(findThirdPartyRisks(source, "script")).not.toEqual([]);
    });
  }
});

describe("findThirdPartyRisks allowed text", () => {
  it("allows same-origin paths and fragments", () => {
    const markup =
      '<link rel="stylesheet" href="/styles.css"><a href="#main-content">Skip</a><img src="/a.png" srcset="/a.png 1x, /b.png 2x"><br/>';
    expect(findThirdPartyRisks(markup, "markup")).toEqual([]);
  });

  it("allows the Tailwind license banner and escaped fraction classes", () => {
    const css =
      "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n.w-1\\/2{width:50%}.font-face{src:url(/fonts/a.woff2)}";
    expect(findThirdPartyRisks(css, "css")).toEqual([]);
  });

  it("allows words that only end in a scheme name", () => {
    expect(findThirdPartyRisks("const metadata = { metadata: 1, xhttp: 2 };", "script")).toEqual(
      [],
    );
  });

  it("names each forbidden scheme with or without slashes", () => {
    const schemes = ["http", "https", "ws", "wss", "ftp", "data", "blob", "javascript"];
    for (const scheme of schemes) {
      expect(findThirdPartyRisks(`x="${scheme}:cdn.example"`, "markup")).toEqual([
        `${scheme}:cdn.example`,
      ]);
      expect(findThirdPartyRisks(`x="${scheme.toUpperCase()}:cdn.example"`, "markup")).toEqual([
        `${scheme.toUpperCase()}:cdn.example`,
      ]);
    }
  });
});

describe("findThirdPartyRisks inline script and srcdoc rules", () => {
  it("fails an inline script with a body, even a same-origin one", () => {
    expect(findThirdPartyRisks("<script>console.log(1)</script>", "markup")).toContain(
      inlineScriptFinding,
    );
    expect(findThirdPartyRisks('<SCRIPT type="module">go()</SCRIPT>', "markup")).toContain(
      inlineScriptFinding,
    );
    expect(findThirdPartyRisks("<script>go()", "markup")).toContain(inlineScriptFinding);
    expect(findThirdPartyRisks('<script type="application/json">{}</script>', "markup")).toContain(
      inlineScriptFinding,
    );
    expect(findThirdPartyRisks("&lt;script&gt;go()&lt;/script&gt;", "markup")).toContain(
      inlineScriptFinding,
    );
  });

  it("allows a same-origin script file with an empty body", () => {
    expect(findThirdPartyRisks('<script type="module" src="/app.js"></script>', "markup")).toEqual(
      [],
    );
    expect(findThirdPartyRisks('<script src="/app.js">\n</script>', "markup")).toEqual([]);
  });

  it("fails any srcdoc attribute", () => {
    expect(findThirdPartyRisks('<iframe srcdoc="<p>hi</p>"></iframe>', "markup")).toEqual([
      srcdocFinding,
    ]);
    expect(findThirdPartyRisks("<iframe SRCDOC='x'></iframe>", "markup")).toEqual([srcdocFinding]);
    expect(findThirdPartyRisks('<iframe title="x"srcdoc="y"></iframe>', "markup")).toEqual([
      srcdocFinding,
    ]);
    expect(findThirdPartyRisks("<iframe/srcdoc=x></iframe>", "markup")).toEqual([srcdocFinding]);
    expect(findThirdPartyRisks("<iframe srcdoc></iframe>", "markup")).toEqual([srcdocFinding]);
  });
});

describe("sourceKindOf", () => {
  it("reads CSS escapes in CSS, JS escapes in scripts and JSON, and every view elsewhere", () => {
    expect(sourceKindOf("styles.css")).toBe("css");
    expect(sourceKindOf("a.js")).toBe("script");
    expect(sourceKindOf("a.MJS")).toBe("script");
    expect(sourceKindOf("data.json")).toBe("script");
    expect(sourceKindOf("a.js.map")).toBe("script");
    expect(sourceKindOf("index.html")).toBe("markup");
    expect(sourceKindOf("icon.svg")).toBe("markup");
    expect(sourceKindOf("_headers")).toBe("markup");
  });
});

describe("inline style and script detection", () => {
  it("flags a style attribute, a style element, and a script body", () => {
    expect(hasInlineStyle('<div style="display:contents"></div>')).toBe(true);
    expect(hasInlineStyle("<div class='a' STYLE = 'color:red'></div>")).toBe(true);
    expect(hasInlineStyle("<style>p{color:red}</style>")).toBe(true);
    expect(hasInlineScript("<script>go()</script>")).toBe(true);
  });

  it("allows class names and attributes that only contain the word style", () => {
    expect(hasInlineStyle('<div class="style-x" data-style="y"></div>')).toBe(false);
    expect(hasInlineStyle('<link rel="stylesheet" href="/styles.css">')).toBe(false);
    expect(hasInlineScript('<script type="module" src="/client.js"></script>')).toBe(false);
  });
});
