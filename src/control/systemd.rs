//! Structured systemd management; permissions are delegated to D-Bus/Polkit.
use serde_json::{json, Value};
use tokio_stream::StreamExt;
use zbus::{zvariant::OwnedObjectPath, Connection, Proxy};

pub struct Manager {
    connection: Connection,
}
impl Manager {
    pub async fn connect(user: bool) -> Result<Self, String> {
        let connection = if user {
            Connection::session().await
        } else {
            Connection::system().await
        }
        .map_err(|e| e.to_string())?;
        Ok(Self { connection })
    }
    async fn proxy(&self) -> Result<Proxy<'_>, String> {
        Proxy::new(
            &self.connection,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )
        .await
        .map_err(|e| e.to_string())
    }
    pub async fn status(&self, unit: &str) -> Result<Value, String> {
        let manager = self.proxy().await?;
        let path: OwnedObjectPath = manager
            .call("LoadUnit", &(unit,))
            .await
            .map_err(|e| e.to_string())?;
        let proxy = Proxy::new(
            &self.connection,
            "org.freedesktop.systemd1",
            path.clone(),
            "org.freedesktop.systemd1.Unit",
        )
        .await
        .map_err(|e| e.to_string())?;
        let service = Proxy::new(
            &self.connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Service",
        )
        .await
        .map_err(|e| e.to_string())?;
        let active: String = proxy
            .get_property("ActiveState")
            .await
            .map_err(|e| e.to_string())?;
        let sub: String = proxy
            .get_property("SubState")
            .await
            .map_err(|e| e.to_string())?;
        let load: String = proxy
            .get_property("LoadState")
            .await
            .map_err(|e| e.to_string())?;
        let pid: u32 = service
            .get_property("MainPID")
            .await
            .map_err(|e| e.to_string())?;
        let file_state: String = manager
            .call("GetUnitFileState", &(unit,))
            .await
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"schema_version":1,"unit":unit,"load_state":load,"active_state":active,"sub_state":sub,"main_pid":pid,"unit_file_state":file_state}),
        )
    }
    /// Subscribe before enqueueing to avoid missing completion of fast jobs.
    pub async fn transition(&self, unit: &str, method: &str) -> Result<(), String> {
        if !["StartUnit", "StopUnit", "RestartUnit"].contains(&method) {
            return Err("unsupported service operation".into());
        }
        let manager = self.proxy().await?;
        let _: () = manager
            .call("Subscribe", &())
            .await
            .map_err(|e| e.to_string())?;
        let mut signals = manager
            .receive_signal("JobRemoved")
            .await
            .map_err(|e| e.to_string())?;
        let job: OwnedObjectPath = manager
            .call(method, &(unit, "replace"))
            .await
            .map_err(|e| e.to_string())?;
        while let Some(message) = signals.next().await {
            let (_, path, _, result): (u32, OwnedObjectPath, String, String) =
                message.body().deserialize().map_err(|e| e.to_string())?;
            if path == job {
                return if result == "done" {
                    Ok(())
                } else {
                    Err(format!("systemd job result: {result}"))
                };
            }
        }
        Err("systemd connection closed before job completion".into())
    }
    pub async fn enable(&self, unit: &str, enabled: bool) -> Result<(), String> {
        let manager = self.proxy().await?;
        if enabled {
            let _: (bool, Vec<(String, String, String)>) = manager
                .call("EnableUnitFiles", &(vec![unit], false, false))
                .await
                .map_err(|e| e.to_string())?;
        } else {
            let _: Vec<(String, String, String)> = manager
                .call("DisableUnitFiles", &(vec![unit], false))
                .await
                .map_err(|e| e.to_string())?;
        }
        let _: () = manager
            .call("Reload", &())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
