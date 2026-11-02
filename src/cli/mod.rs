//! Management command dispatch. Read-only commands never construct an App.
mod data;
mod edit;
mod error;
mod inspect;
pub mod legacy;
mod report;
mod schema;
pub mod settings;
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Write, path::PathBuf};

#[derive(Clone, Copy, ValueEnum)]
enum Output {
    Text,
    Json,
}
#[derive(Parser)]
#[command(name = "prtsctl", version, about = "PRTS-MCP 配置与数据管理")]
struct Cli {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[arg(long, short = 'o', global = true, value_enum)]
    output: Option<Output>,
    #[arg(long, hide = true, global = true)]
    bundle_root: Option<PathBuf>,
    #[arg(long, hide = true, global = true)]
    launcher_parent_pid: Option<u32>,
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    /// 在当前进程运行 MCP 服务器
    Serve {
        #[arg(long,value_parser=["http","stdio"])]
        transport: Option<String>,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        port: Option<u16>,
    },
    /// 查看、校验或编辑配置文件
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// 检查本地运行条件
    Doctor {
        #[arg(long)]
        network: bool,
    },
    /// 查看和检查本地数据
    Data {
        #[command(subcommand)]
        command: DataCommand,
    },
    /// 生成 Shell 补全脚本
    Completion { shell: clap_complete::Shell },
}
#[derive(Subcommand)]
enum ConfigCommand {
    Show {
        #[arg(long)]
        sources: bool,
    },
    Validate,
    Init {
        #[arg(long)]
        force: bool,
        #[arg(long)]
        dry_run: bool,
    },
    Set {
        key: String,
        value: String,
        #[arg(long)]
        dry_run: bool,
    },
    Unset {
        key: String,
        #[arg(long)]
        dry_run: bool,
    },
}
#[derive(Subcommand)]
enum DataCommand {
    Sync {
        #[arg(long, default_value="game", value_parser=["game","images","all"])]
        target: String,
        #[arg(long,default_value_t=30,value_parser=clap::value_parser!(u64).range(0..=86400))]
        wait_timeout: u64,
    },
    Status,
    Verify,
}

pub fn main_entry() -> i32 {
    let cli = Cli::parse();
    if cli.command.is_none() {
        return write_output(Cli::command().render_help().to_string().as_bytes());
    }
    if let Some(Command::Completion { shell }) = &cli.command {
        let mut buffer = Vec::new();
        clap_complete::generate(*shell, &mut Cli::command(), "prtsctl", &mut buffer);
        return write_output(&buffer);
    }
    crate::launcher::watch_parent();
    match execute(&cli) {
        Ok((value, code)) => {
            if let Some(value) = value {
                let output_code = render(
                    &value,
                    cli.output.unwrap_or(Output::Text),
                    matches!(
                        cli.command,
                        Some(Command::Config {
                            command: ConfigCommand::Show { sources: true }
                        })
                    ),
                );
                if output_code != 0 {
                    return output_code;
                }
            }
            code
        }
        Err(error) => {
            eprintln!("prtsctl: {error}");
            error.code
        }
    }
}
fn write_output(bytes: &[u8]) -> i32 {
    match std::io::stdout().lock().write_all(bytes) {
        Ok(()) => 0,
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => 0,
        Err(error) => {
            eprintln!("prtsctl: {error}");
            1
        }
    }
}
fn render(value: &Value, output: Output, sources: bool) -> i32 {
    let text = match output {
        Output::Json => format!("{}\n", serde_json::to_string(value).expect("JSON result")),
        Output::Text => report::text(value, sources),
    };
    write_output(text.as_bytes())
}
fn execute(cli: &Cli) -> Result<(Option<Value>, i32), error::Failure> {
    let command = cli.command.as_ref().expect("command selected");
    if let Command::Config { command } = command {
        match command {
            ConfigCommand::Init { force, dry_run } => {
                return edit::apply(
                    cli.config.as_deref(),
                    edit::Change::Init { force: *force },
                    *dry_run,
                )
                .map(|v| (Some(v), 0))
            }
            ConfigCommand::Set {
                key,
                value,
                dry_run,
            } => {
                return edit::apply(
                    cli.config.as_deref(),
                    edit::Change::Set(key, value),
                    *dry_run,
                )
                .map(|v| (Some(v), 0))
            }
            ConfigCommand::Unset { key, dry_run } => {
                return edit::apply(cli.config.as_deref(), edit::Change::Unset(key), *dry_run)
                    .map(|v| (Some(v), 0))
            }
            _ => (),
        }
    }
    let mut overrides = BTreeMap::new();
    if let Command::Serve {
        transport,
        host,
        port,
    } = command
    {
        if cli.output.is_some() {
            return Err("serve 不接受 --output；stdio 输出保留给 MCP".into());
        }
        for (key, value) in [
            ("PRTS_TRANSPORT", transport.clone()),
            ("HOST", host.clone()),
            ("PORT", port.map(|p| p.to_string())),
        ] {
            if let Some(value) = value {
                overrides.insert(key.into(), value);
            }
        }
    }
    let mut loaded = settings::load(cli.config.as_deref(), true, &overrides)?;
    if let Some(root) = &cli.bundle_root {
        loaded.config.bundle_root = Some(root.clone())
    }
    match command {
        Command::Serve { .. } => {
            let app = crate::app::App::try_with_config(loaded.config)?;
            let code = if loaded.transport.trim().eq_ignore_ascii_case("stdio") {
                app.run_stdio()
            } else {
                app.run_http().map_err(error::Failure::operation)?;
                0
            };
            Ok((None, code))
        }
        Command::Config {
            command: ConfigCommand::Show { .. },
        } => Ok((Some(loaded.report), 0)),
        Command::Config {
            command: ConfigCommand::Validate,
        } => Ok((Some(json!({"schema_version":1,"valid":true})), 0)),
        Command::Data {
            command:
                DataCommand::Sync {
                    target,
                    wait_timeout,
                },
        } => {
            let runtime = tokio::runtime::Runtime::new().map_err(error::Failure::operation)?;
            let (value, code) =
                runtime.block_on(data::sync(&loaded.config, target, *wait_timeout))?;
            Ok((Some(value), code))
        }
        Command::Data {
            command: DataCommand::Status,
        } => {
            let (value, code) = inspect::data(&loaded.config, false);
            Ok((Some(value), code))
        }
        Command::Data {
            command: DataCommand::Verify,
        } => {
            let (value, code) = inspect::data(&loaded.config, true);
            Ok((Some(value), code))
        }
        Command::Doctor { network } => {
            let mut report = inspect::local_doctor(&loaded.config);
            if *network {
                let runtime = tokio::runtime::Runtime::new().map_err(error::Failure::operation)?;
                let checks = runtime.block_on(data::network(&loaded.config));
                report["checks"]
                    .as_array_mut()
                    .expect("doctor checks")
                    .extend(checks);
                report["ok"] = json!(inspect::successful(
                    report["checks"].as_array().expect("doctor checks")
                ));
            }
            let code = if report["ok"] == true { 0 } else { 1 };
            Ok((Some(report), code))
        }
        _ => unreachable!(),
    }
}
