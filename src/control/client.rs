//! Resolve explicit endpoints and verify instance identity before administration.
use super::{
    instances::Instance,
    wire::{self, Command, Outcome, Request, Response},
};
use serde_json::Value;
use std::time::Duration;

async fn exchange(
    instance: &Instance,
    command: Command,
    expected_startup_id: Option<String>,
) -> Result<Value, String> {
    #[cfg(unix)]
    let mut stream = tokio::net::UnixStream::connect(&instance.endpoint)
        .await
        .map_err(|e| format!("无法连接管理端点: {e}"))?;
    #[cfg(windows)]
    let mut stream = loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(&instance.endpoint) {
            Ok(stream) => break stream,
            Err(error) if error.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => return Err(format!("无法连接管理端点: {error}")),
        }
    };
    wire::send(
        &mut stream,
        &Request {
            protocol_version: wire::PROTOCOL_VERSION,
            command,
            instance: instance.name.clone(),
            expected_startup_id,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    let response: Response = wire::receive(&mut stream)
        .await
        .map_err(|e| e.to_string())?;
    if response.protocol_version != wire::PROTOCOL_VERSION {
        return Err("不兼容的管理协议版本".into());
    }
    match response.outcome {
        Outcome::Success { result } => Ok(result),
        Outcome::Failure { error } => Err(format!("{}: {}", error.kind, error.message)),
    }
}

pub async fn request(instance: &Instance, command: Command) -> Result<Value, String> {
    if !super::instances::valid_endpoint(&instance.endpoint) {
        return Err("无效的本机管理端点".into());
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        let hello = exchange(instance, Command::Hello, None).await?;
        if hello["instance"] != instance.name {
            return Err("管理端点实例名称不匹配".into());
        }
        let startup = hello["startup_id"]
            .as_str()
            .ok_or("缺少实例启动标识")?
            .to_owned();
        exchange(instance, command, Some(startup)).await
    })
    .await
    .map_err(|_| "管理请求超时".to_string())?
}
