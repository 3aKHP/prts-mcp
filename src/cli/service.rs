//! Lifecycle commands deliberately do not load business configuration.
use super::error::Failure;
#[cfg(target_os = "linux")]
use super::settings;
use clap::{Args as ClapArgs, Subcommand};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(ClapArgs)]
pub struct Args {
    #[arg(long, default_value = "main", global = true)]
    instance: String,
    #[arg(long, global = true)]
    instances_file: Option<PathBuf>,
    /// Explicit unit bypasses instance mapping (also works with older servers).
    #[arg(long, global = true)]
    unit: Option<String>,
    #[arg(long, global = true)]
    user: bool,
    #[arg(long, default_value_t = 30, global = true, value_parser=clap::value_parser!(u64).range(1..=86400))]
    timeout: u64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Status,
    Start,
    Stop,
    Restart,
    Enable,
    Disable,
    /// Write a unit to stdout; install it with your usual systemd workflow.
    Template {
        #[arg(long)]
        executable: PathBuf,
        #[arg(long)]
        data_home: PathBuf,
        /// Required for a system service; omit with --user.
        #[arg(long)]
        account: Option<String>,
    },
}

pub fn execute(args: &Args, config: Option<&Path>) -> Result<Value, Failure> {
    if let Command::Template {
        executable,
        data_home,
        account,
    } = &args.command
    {
        if args.user == account.is_some() {
            return Err("system 模板须指定 --account；--user 模板不接受 --account".into());
        }
        let config = config.ok_or("模板须指定 --config 绝对路径")?;
        let template = crate::control::template::render(
            &args.instance,
            executable,
            config,
            data_home,
            account.as_deref(),
        )?;
        return Ok(json!({"schema_version":1,"template":template}));
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(Failure::operation(
            "service 生命周期管理仅支持 Linux systemd；本地运行时查询请用 runtime",
        ))
    }
    #[cfg(target_os = "linux")]
    {
        let (unit, user) = if let Some(unit) = &args.unit {
            (unit.clone(), args.user)
        } else {
            let path = args.instances_file.clone().map(Ok).unwrap_or_else(|| {
                settings::default_path().map(|p| p.with_file_name("instances.toml"))
            })?;
            let instance = crate::control::instances::load(&path, &args.instance)?;
            (
                instance.unit.ok_or("实例未配置 unit；请显式指定 --unit")?,
                args.user || instance.user,
            )
        };
        if !crate::control::instances::valid_unit(&unit) {
            return Err("无效 systemd service 单元名称".into());
        }
        let runtime = tokio::runtime::Runtime::new().map_err(Failure::operation)?;
        runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(args.timeout), async {
                let manager = crate::control::systemd::Manager::connect(user).await?;
                match args.command {
                    Command::Status => (),
                    Command::Start => manager.transition(&unit, "StartUnit").await?,
                    Command::Stop => manager.transition(&unit, "StopUnit").await?,
                    Command::Restart => manager.transition(&unit, "RestartUnit").await?,
                    Command::Enable => manager.enable(&unit, true).await?,
                    Command::Disable => manager.enable(&unit, false).await?,
                    Command::Template { .. } => unreachable!(),
                }
                let mut status = manager.status(&unit).await?;
                status["scope"] = json!(if user { "user" } else { "system" });
                Ok::<_, String>(status)
            })
            .await
            .map_err(|_| {
                Failure::operation("等待 systemd 超时；操作可能仍在进行，请查询 service status")
            })?
            .map_err(Failure::operation)
        })
    }
}
