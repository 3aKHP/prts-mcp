//! Additive CLI handling for the existing fixed transport profiles.
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

enum Request {
    Help,
    Version,
    Config(PathBuf),
    None,
}
fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Request, String> {
    let mut args = args.into_iter();
    let mut path = None;
    while let Some(arg) = args.next() {
        if arg == "--" {
            break;
        }
        if arg == "--bundle-root" || arg == "--launcher-parent-pid" {
            args.next();
            continue;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(Request::Help);
        }
        if arg == "--version" || arg == "-V" {
            return Ok(Request::Version);
        }
        if arg == "--config" {
            let value = args
                .next()
                .filter(|v| !v.is_empty())
                .ok_or("--config requires a nonempty path")?;
            path = Some(PathBuf::from(value));
        } else if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--config=")) {
            if value.is_empty() {
                return Err("--config requires a nonempty path".into());
            }
            path = Some(PathBuf::from(value));
        }
        // Historically unknown arguments were ignored by these entry points.
    }
    Ok(path.map_or(Request::None, Request::Config))
}
/// Returns only for historical startup; explicit CLI requests exit here.
pub fn dispatch(profile: &str) {
    let request = match parse(std::env::args_os().skip(1)) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("{profile}: {error}");
            std::process::exit(2)
        }
    };
    let path = match request {
        Request::None => return,
        Request::Version => {
            println!("{profile} {}", crate::SERVER_VERSION);
            std::process::exit(0)
        }
        Request::Help => {
            let transport = match profile {
                "prts-mcp-ghcr" => "默认 stdio；PRTS_TRANSPORT=http 切换到 HTTP",
                "prts-mcp-ts-stdio" => "固定 stdio；忽略 PRTS_TRANSPORT",
                "prts-mcp" => "默认 HTTP；PRTS_TRANSPORT=stdio 切换到 stdio",
                _ => "固定 HTTP；忽略 PRTS_TRANSPORT",
            };
            println!("{profile} {}\nMCP 服务器：{transport}。\n\n  --help, -h\n  --version, -V\n  --config <PATH>  显式读取 TOML 配置；环境变量优先\n\n管理命令：prtsctl --help",crate::SERVER_VERSION);
            std::process::exit(0)
        }
        Request::Config(path) => path,
    };
    let mut loaded = match super::settings::load(Some(&path), false, &BTreeMap::new()) {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!("{profile}: {error}");
            std::process::exit(2)
        }
    };
    loaded.context.set_profile(profile);
    let requested = loaded
        .transport_input
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let stdio = match profile {
        "prts-mcp-ts-stdio" => true,
        "prts-mcp-ghcr" => requested != "http",
        "prts-mcp" => requested == "stdio",
        _ => false,
    };
    crate::launcher::watch_parent();
    let mut app = match crate::app::App::try_with_config(loaded.config) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("{profile}: {error}");
            std::process::exit(2)
        }
    };
    app.startup_report = Some(loaded.report);
    app.startup_context = Some(loaded.context);
    if stdio {
        std::process::exit(app.run_stdio())
    }
    let profile = if profile == "prts-mcp-ghcr" {
        crate::app::HttpProfile::Ghcr
    } else {
        crate::app::HttpProfile::Ts
    };
    match app.run_http_profile(profile) {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            crate::log_err(&error.to_string());
            std::process::exit(1)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(s: &[&str]) -> Vec<OsString> {
        s.iter().map(OsString::from).collect()
    }
    #[test]
    fn respects_values_and_end_of_options() {
        assert!(matches!(
            parse(args(&["--", "--help"])).unwrap(),
            Request::None
        ));
        assert!(matches!(
            parse(args(&["--bundle-root", "--help"])).unwrap(),
            Request::None
        ));
        assert!(matches!(
            parse(args(&["--config", "--help"])).unwrap(),
            Request::Config(_)
        ));
        assert!(parse(args(&["--config="])).is_err());
        assert!(parse(args(&["--config"])).is_err());
    }
}
