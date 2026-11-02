//! Management adapters for shared synchronization and bounded network diagnostics.
use crate::{config::RuntimeConfig, sync::transport::ReqwestTransport};
use serde_json::Value;

pub async fn sync(
    cfg: &RuntimeConfig,
    target: &str,
    wait_seconds: u64,
) -> Result<(Value, i32), String> {
    crate::sync::once::validate(cfg, target)?;
    let control = crate::sync::control::Control::new(std::time::Duration::from_secs(wait_seconds));
    let signal_control = control.clone();
    // Register handlers before creating files or waiting on a lock.
    #[cfg(unix)]
    let signals = {
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .map_err(|e| e.to_string())?;
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            tokio::select! {_ = interrupt.recv()=>signal_control.cancel(130),_ = terminate.recv()=>signal_control.cancel(143)}
        })
    };
    #[cfg(windows)]
    let signals = {
        let mut interrupt = tokio::signal::windows::ctrl_c().map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            interrupt.recv().await;
            signal_control.cancel(130);
        })
    };
    let transport = ReqwestTransport::new(cfg.github_mirrors.clone(), cfg.github_token.clone());
    // Do not drop the sync future on a signal: active blocking publishers retain
    // their locks until completion; cancelled network calls unwind normal cleanup.
    let result = crate::sync::once::run(cfg, target, &transport, control.clone()).await;
    signals.abort();
    let _ = signals.await;
    let report = result?;
    let code = control.exit_code().unwrap_or_else(|| report.exit_code());
    Ok((
        serde_json::to_value(report).map_err(|e| e.to_string())?,
        code,
    ))
}
pub async fn network(cfg: &RuntimeConfig) -> Vec<Value> {
    use crate::wiki::client::{ReqwestWikiTransport, WikiTransport};
    let t = ReqwestTransport::new(cfg.github_mirrors.clone(), cfg.github_token.clone());
    let wiki = ReqwestWikiTransport::new();
    let limit = std::time::Duration::from_secs(5);
    let params = [
        ("action".into(), "query".into()),
        ("meta".into(), "siteinfo".into()),
        ("format".into(), "json".into()),
    ];
    let (source, wiki) = tokio::join!(
        tokio::time::timeout(
            limit,
            crate::sync::discovery::list_releases(
                &t,
                cfg.data_source.owner(),
                cfg.data_source.repo(),
                5000
            )
        ),
        tokio::time::timeout(limit, wiki.get(&params))
    );
    let source = matches!(source, Ok(Some(_)));
    let wiki = matches!(wiki, Ok(Ok(_)));
    [("source_network", source), ("wiki_network", wiki)]
        .into_iter()
        .map(|(name, ok)| {
            super::inspect::check(
                name,
                if ok { "ok" } else { "error" },
                if ok {
                    "连接成功"
                } else {
                    "连接失败或超过 5 秒时限；未下载数据资产"
                },
                None,
            )
        })
        .collect()
}
