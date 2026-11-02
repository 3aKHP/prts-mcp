//! One bounded JSON request and response per local connection.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub command: Command,
    pub instance: String,
    #[serde(default)]
    pub expected_startup_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Hello,
    Status,
    ConfigShow,
    ConfigDiff,
    ConfigReload { expected_revision: u64 },
    DataStatus,
    DataSync { target: String, wait_timeout: u64 },
    JobsList,
    JobShow { id: String },
    JobCancel { id: String },
}

impl Command {
    /// A cold data view may verify the complete SQLite file before reporting.
    pub fn response_timeout(&self) -> std::time::Duration {
        if matches!(self, Self::Status | Self::DataStatus) {
            std::time::Duration::from_secs(30)
        } else {
            HANDSHAKE_TIMEOUT
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub protocol_version: u32,
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Outcome {
    Success { result: Value },
    Failure { error: Error },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Error {
    pub kind: String,
    pub message: String,
}

impl Response {
    pub fn success(result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            outcome: Outcome::Success { result },
        }
    }
    pub fn failure(kind: &str, message: &str) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            outcome: Outcome::Failure {
                error: Error {
                    kind: kind.into(),
                    message: message.into(),
                },
            },
        }
    }
}

pub async fn receive<R: AsyncRead + Unpin, T: DeserializeOwned>(
    reader: &mut R,
) -> std::io::Result<T> {
    let size = reader.read_u32().await? as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid management frame length",
        ));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid management JSON")
    })
}

pub async fn send<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "management response too large",
        ));
    }
    writer.write_u32(bytes.len() as u32).await?;
    writer.write_all(&bytes).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn rejects_oversized_frame_before_allocating_body() {
        let mut input = &[0xff, 0xff, 0xff, 0xff][..];
        assert_eq!(
            receive::<_, Request>(&mut input).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
    #[tokio::test]
    async fn round_trip_preserves_structured_result() {
        let expected = serde_json::json!({"instance":"main","ready":true});
        let mut bytes = Vec::new();
        send(&mut bytes, &Response::success(expected.clone()))
            .await
            .unwrap();
        let response: Response = receive(&mut bytes.as_slice()).await.unwrap();
        match response.outcome {
            Outcome::Success { result } => assert_eq!(result, expected),
            _ => panic!("unexpected error"),
        }
    }
}
