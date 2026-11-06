import sanitizeHtml from "sanitize-html";

/**
 * Customers upload HTML, so it is cleaned twice: when saved, and again after the data is filled in.
 * Removed: <script>, <iframe>, <object>, <embed>, <form>, <link>, <meta http-equiv>, <svg>/<math> (can carry script),
 * every on* event attribute, and any URL that is not data:, asset: or a relative reference (so no javascript:, no http).
 * Kept: normal document markup, tables, images and <style> (CSS cannot run code in the renderer, which also has
 * JavaScript switched off and the network blocked).
 */
const TAGS = [
  "html", "head", "body", "title", "style", "meta", "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "colgroup", "col", "img", "a", "header", "footer", "section", "article", "main", "aside", "address", "figure", "figcaption", "blockquote", "pre", "code",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  allowVulnerableTags: true, // only <style>: needed for invoice layouts, safe because rendering has JS and network off
  allowedAttributes: {
    "*": ["class", "id", "style", "title", "align", "valign", "width", "height", "colspan", "rowspan", "dir", "lang"],
    img: ["src", "alt", "width", "height", "style", "class"],
    a: ["href", "class", "style"],
    meta: ["charset"],
  },
  allowedSchemes: ["data", "asset"],
  allowedSchemesByTag: { a: ["mailto", "tel", "https", "http"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  allowedStyles: undefined, // all CSS properties; url() inside CSS is neutralised below
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "noscript", "iframe", "object", "embed", "textarea", "option", "svg", "math", "template"],
  parser: { lowerCaseAttributeNames: true },
};

/** CSS can reference URLs (background, @import, fonts). Only asset: and data: are kept. */
function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "x(")
    .replace(/url\(\s*(['"]?)(?!data:|asset:)[^)]*\1\s*\)/gi, "none")
    .replace(/javascript\s*:/gi, "");
}

export function sanitizeTemplateHtml(html: string): string {
  // Handlebars comments are removed first: their text could otherwise be read as tags by the HTML parser.
  html = html.replace(/\{\{!--[\s\S]*?--\}\}/g, "").replace(/\{\{![\s\S]*?\}\}/g, "");
  const out = sanitizeHtml(html, {
    ...OPTIONS,
    textFilter: undefined,
    transformTags: {
      "*": (tagName, attribs) => (attribs.style ? { tagName, attribs: { ...attribs, style: cleanCss(attribs.style) } } : { tagName, attribs }),
    },
  });
  // <style> content is text to sanitize-html, so clean its URLs here.
  const cleaned = out.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, a, css) => `<style${a}>${cleanCss(css)}</style>`);
  // The parser drops the doctype; without it Chromium lays the page out in quirks mode.
  return /^\s*<!doctype/i.test(cleaned) ? cleaned : `<!doctype html>\n${cleaned.trimStart()}`;
}
