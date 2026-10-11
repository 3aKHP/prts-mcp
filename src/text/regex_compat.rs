//! Narrow QuickJS-backed regex adapter — the user-pattern contract is
//! `new RegExp(pattern, "iu")` (docs/02-architecture.md).
//!
//! Only `compile` + `is_match` are exposed. Patterns enter as API values,
//! never spliced into executable JS; no files, network, or module loading.
//! One VM per compiled pattern per query; matching many texts reuses it.
//! Engine compile-error wording is QuickJS's own (D-003 dependency detail);
//! accept/reject behavior and the project's message prefix stay compared.

use rquickjs::{Context, Function, Object, Persistent, Runtime};

/// Fixed call-shape helper evaluated once per context; the user pattern is
/// passed as a value argument, never spliced into source text.
const TEST_BRIDGE: &str = "(re, text) => re.test(text)";

pub struct JsRegex {
    ctx: Context,
    // The RegExp object itself plus the bridge function; `test` must run as
    // the object's method to keep the JS `this` binding.
    regexp: Option<Persistent<Object<'static>>>,
    bridge: Option<Persistent<Function<'static>>>,
}

impl Drop for JsRegex {
    fn drop(&mut self) {
        // Persistent handles do not free themselves; consume the values
        // inside the context before the runtime is released, or QuickJS
        // aborts on a non-empty GC list at JS_FreeRuntime.
        let (regexp, bridge) = (self.regexp.take(), self.bridge.take());
        self.ctx.with(|ctx| {
            if let Some(p) = regexp {
                let _: Option<Object> = p.restore(&ctx).ok();
            }
            if let Some(p) = bridge {
                let _: Option<Function> = p.restore(&ctx).ok();
            }
        });
    }
}

type CompilePair = (
    Option<Persistent<Object<'static>>>,
    Option<Persistent<Function<'static>>>,
);

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

impl JsRegex {
    /// Compile `pattern` with JS `iu` flags. `Err` carries the engine's
    /// rejection message (D-003 normalized at the comparison boundary).
    pub fn compile(pattern: &str) -> Result<Self, String> {
        let rt = Runtime::new().map_err(|e| format!("{e:?}"))?;
        let ctx = Context::full(&rt).map_err(|e| format!("{e:?}"))?;
        let (regexp, bridge) = ctx.with(|ctx| -> Result<CompilePair, String> {
            let regexp_ctor: Function = ctx
                .globals()
                .get("RegExp")
                .map_err(|e| js_err_string(e, &ctx))?;
            let re = regexp_ctor
                .call::<_, rquickjs::Value>((pattern.to_string(), "iu"))
                .map_err(|e| js_err_string(e, &ctx))?;
            let re_obj: Object = re.get().map_err(|e| js_err_string(e, &ctx))?;
            let bridge_fn: Function = ctx
                .eval::<Function, _>(TEST_BRIDGE)
                .map_err(|e| js_err_string(e, &ctx))?;
            Ok((
                Some(Persistent::save(&ctx, re_obj)),
                Some(Persistent::save(&ctx, bridge_fn)),
            ))
        })?;
        Ok(Self {
            ctx,
            regexp,
            bridge,
        })
    }

    /// JS `regex.test(text)` — stateless with the `iu` flag set (no `g`, so
    /// `lastIndex` never advances between calls).
    pub fn is_match(&self, text: &str) -> Result<bool, String> {
        let regexp = self
            .regexp
            .as_ref()
            .expect("JsRegex invariant: regexp present after compile")
            .clone();
        let bridge = self
            .bridge
            .as_ref()
            .expect("JsRegex invariant: bridge present after compile")
            .clone();
        self.ctx.with(|ctx| {
            let re_obj: Object = regexp.restore(&ctx).map_err(|e| format!("{e:?}"))?;
            let bridge_fn: Function = bridge.restore(&ctx).map_err(|e| format!("{e:?}"))?;
            bridge_fn
                .call::<_, bool>((re_obj, text.to_string()))
                .map_err(|e| js_err_string(e, &ctx))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_iu_matching() {
        let re = JsRegex::compile("amiya").expect("compile");
        assert!(re.is_match("阿米娅 Amiya").expect("match"));
        assert!(!re.is_match("陈").expect("match"));
    }

    #[test]
    fn empty_pattern_matches_everything() {
        let re = JsRegex::compile("").expect("compile");
        assert!(re.is_match("").expect("match"));
        assert!(re.is_match("任意").expect("match"));
    }

    #[test]
    fn invalid_pattern_rejected() {
        assert!(JsRegex::compile("(").is_err());
        assert!(JsRegex::compile("[").is_err());
    }

    #[test]
    fn unicode_and_lookaround_supported() {
        // R8: Unicode property escapes.
        let re = JsRegex::compile("\\p{Script=Han}+").expect("compile");
        assert!(re.is_match("龙门近卫局").expect("match"));
        assert!(!re.is_match("Rhodes Island").expect("match"));
        // R9/R10: look-around (beyond the Rust regex crate).
        let la = JsRegex::compile("娅(?=塔)").expect("compile");
        assert!(la.is_match("阿米娅塔").expect("match"));
        assert!(!la.is_match("阿米娅").expect("match"));
        let lb = JsRegex::compile("(?<=阿米)娅").expect("compile");
        assert!(lb.is_match("阿米娅").expect("match"));
        assert!(!lb.is_match("凯尔希娅").expect("match"));
    }

    #[test]
    fn backreference_and_digit_semantics() {
        let re = JsRegex::compile("(?<name>阿米娅)\\k<name>").expect("compile");
        assert!(re.is_match("阿米娅阿米娅").expect("match"));
        // JS \d is ASCII-only even with the u flag.
        let digit = JsRegex::compile("\\d").expect("compile");
        assert!(digit.is_match("第2章").expect("match"));
        assert!(!digit.is_match("２０００").expect("match"));
    }
}
