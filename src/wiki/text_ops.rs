//! Wiki text cleanup — the regex half of TS `api/prtsWiki.ts`, executed as
//! the oracle's exact ECMAScript inside QuickJS (values passed as arguments,
//! never spliced into source; same posture as `text::regex_compat`).
//!
//! `stripWikitext` (snippet pre-pass) is the shared `text::sanitizer` port.
//! Engine error wording on pathological inputs (e.g. `String.fromCodePoint`
//! out of range) is a D-003 runtime detail; the accepted transformations
//! are byte-compared by the differential corpus.

use std::cell::RefCell;

use rquickjs::{Context, Function, Runtime};

/// The TS helper set, transplanted verbatim from prtsWiki.ts (module-level
/// functions; `stripHtml` calls `unescapeHTMLEntities` exactly like the
/// oracle calls its module sibling).
const WIKI_HELPERS: &str = r#"
const NAMED_ENTITIES = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™",
  times: "×", divide: "÷", plusmn: "±",
  bull: "•", middot: "·", shy: "\u00ad",
};
const CSS_JS_RE =
  /@(font-face|keyframes|media|import|charset|namespace|supports|page)[^{]*\{[^}]*\}|\(window\.RLQ\s*\|\|\s*\[\]\)\.push\([^)]*\)|<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>/gis;
const HTML_TAG_RE = /<[^>]+>/g;
const REDIRECT_SNIPPET_RE = /#\s*(?:重定向|REDIRECT)/i;
const TECHNICAL_PAGE_PATTERNS = [
  /\/(?:spine|data|db|lua|json|module)(?:$|[/:._-])/i,
  /\.(?:json|lua)$/i,
  /^(?:Widget|Template|Module|MediaWiki|模块|模板):/i,
];
function unescapeHTMLEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (_, name) => NAMED_ENTITIES[name] ?? `&${name};`);
}
function cleanSnippet(snippet) {
  snippet = snippet.replace(/\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*/g, " ");
  snippet = snippet.replace(/\|[一-鿿\w]+\s*=[^\n]*/g, "");
  snippet = snippet.replace(REDIRECT_SNIPPET_RE, "");
  snippet = snippet.replace(/[ \t]+/g, " ");
  snippet = snippet.replace(/,{2,}/g, "");
  snippet = snippet.replace(/\n{2,}/g, "\n");
  return snippet.replace(/^[ ,\n]+|[ ,\n]+$/g, "");
}
function stripHtml(text) {
  let out = text.replace(CSS_JS_RE, "");
  out = out.replace(HTML_TAG_RE, "");
  out = unescapeHTMLEntities(out);
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
function isTechnicalPage(title) {
  return TECHNICAL_PAGE_PATTERNS.some((p) => p.test(title));
}
function isRedirectLike(snippet) {
  return REDIRECT_SNIPPET_RE.test(snippet);
}
"#;

/// One QuickJS VM per OS thread (rquickjs handles are !Send); the helpers
/// are stateless so cross-thread migration of a task is invisible.
struct HelperVm {
    #[allow(dead_code)]
    rt: Runtime,
    ctx: Context,
}

thread_local! {
    static HELPERS: RefCell<Option<HelperVm>> = const { RefCell::new(None) };
}

/// QuickJS errors (engine detail) surfaced as Err with the engine's message.
fn with_vm<T>(f: impl FnOnce(&rquickjs::Ctx<'_>) -> Result<T, String>) -> Result<T, String> {
    HELPERS.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let rt = Runtime::new().map_err(|e| format!("{e:?}"))?;
            let ctx = Context::full(&rt).map_err(|e| format!("{e:?}"))?;
            ctx.with(|ctx| ctx.eval::<(), _>(WIKI_HELPERS))
                .map_err(|e| format!("{e:?}"))?;
            *slot = Some(HelperVm { rt, ctx });
        }
        let vm = slot.as_ref().expect("just initialized");
        vm.ctx.with(|ctx| f(&ctx))
    })
}

fn js_err_string(err: rquickjs::Error, ctx: &rquickjs::Ctx<'_>) -> String {
    match err {
        rquickjs::Error::Exception => {
            let caught = ctx.catch();
            let text = caught
                .as_string()
                .map(|s| s.to_string().unwrap_or_default());
            match text {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => format!("{err:?}"),
            }
        }
        other => format!("{other:?}"),
    }
}

/// Call one top-level helper by its TS name with a single string argument.
fn call_helper(name: &str, arg: &str) -> Result<String, String> {
    with_vm(|ctx| {
        let func: Function = ctx.globals().get(name).map_err(|e| format!("{e:?}"))?;
        func.call((arg.to_string(),))
            .map_err(|e| js_err_string(e, ctx))
    })
}

fn call_helper_bool(name: &str, arg: &str) -> Result<bool, String> {
    with_vm(|ctx| {
        let func: Function = ctx.globals().get(name).map_err(|e| format!("{e:?}"))?;
        func.call((arg.to_string(),))
            .map_err(|e| js_err_string(e, ctx))
    })
}

pub fn unescape_html_entities(text: &str) -> Result<String, String> {
    call_helper("unescapeHTMLEntities", text)
}

pub fn clean_snippet(snippet: &str) -> Result<String, String> {
    call_helper("cleanSnippet", snippet)
}

pub fn strip_html(text: &str) -> Result<String, String> {
    call_helper("stripHtml", text)
}

pub fn is_technical_page(title: &str) -> Result<bool, String> {
    call_helper_bool("isTechnicalPage", title)
}

pub fn is_redirect_like(snippet: &str) -> Result<bool, String> {
    call_helper_bool("isRedirectLike", snippet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_like_the_oracle() {
        assert_eq!(unescape_html_entities("&amp;&lt;&gt;").unwrap(), "&<>");
        assert_eq!(unescape_html_entities("&#65;&#x4e2d;").unwrap(), "A中");
        // Unknown named entities survive verbatim.
        assert_eq!(unescape_html_entities("&nope;").unwrap(), "&nope;");
        assert_eq!(unescape_html_entities("&mdash;").unwrap(), "—");
        assert_eq!(unescape_html_entities("&nbsp;x").unwrap(), " x");
    }

    #[test]
    fn snippet_cleanup_drops_json_and_pipe_fragments() {
        assert_eq!(clean_snippet(r#"  "key": "value", rest"#).unwrap(), "rest");
        assert_eq!(clean_snippet("|参数=值\n正文").unwrap(), "正文");
        // The REDIRECT marker is removed but the target link stays; the
        // doubled commas collapse and edges trim.
        assert_eq!(
            clean_snippet("#REDIRECT [[阿米娅]],, x ,\n ").unwrap(),
            "[[阿米娅]] x"
        );
        assert_eq!(clean_snippet("A\n\n\nB").unwrap(), "A\nB");
    }

    #[test]
    fn strip_html_removes_css_js_blocks_and_tags() {
        let html = "<style>a{color:red}</style><p>正文</p><script>evil()</script>尾";
        assert_eq!(strip_html(html).unwrap(), "正文尾");
        // Entity decode happens after tag stripping.
        assert_eq!(strip_html("<p>&#20013;</p>").unwrap(), "中");
        // Three or more newlines collapse to two; horizontal space squeezes.
        assert_eq!(strip_html("a \t b\n\n\n\nc").unwrap(), "a b\n\nc");
        // The RLQ pattern consumes up to the FIRST ')' (like the oracle's
        // [^)]*), leaving the tail of the expression behind.
        assert_eq!(
            strip_html("(window.RLQ || []).push(function(){});after").unwrap(),
            "{});after"
        );
    }

    #[test]
    fn technical_page_patterns() {
        assert!(is_technical_page("干员/spine/阿米娅").unwrap());
        assert!(!is_technical_page("干员/spine阿米娅").unwrap()); // spine must end the segment
        assert!(is_technical_page("关卡/data/1-7").unwrap());
        assert!(is_technical_page("Something.json").unwrap());
        assert!(is_technical_page("Template:干员").unwrap());
        assert!(is_technical_page("模块:数据").unwrap());
        assert!(!is_technical_page("阿米娅").unwrap());
        assert!(!is_technical_page("主流战术/datax").unwrap()); // data must end the segment
    }

    #[test]
    fn redirect_like_detection() {
        assert!(is_redirect_like("#REDIRECT [[阿米娅]]").unwrap());
        assert!(is_redirect_like("# 重定向 [[x]]").unwrap());
        assert!(!is_redirect_like("普通文本").unwrap());
    }
}
