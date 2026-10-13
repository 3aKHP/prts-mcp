//! PRTS Wiki tool dispatchers — port of TS `tools/prtsTools.ts`.
//!
//! search_prts is a 3-channel structured tool; prts_page stays pure text on
//! every channel. Both are async (network I/O through the shared transport).

use serde_json::Value;

use super::output::ToolOutcome;
use super::zodish::{validation_error, Args};
use super::{AppHandle, DispatchFuture, DispatchResult};
use crate::wiki::{client, page, search};

fn invalid_args(tool: &str, joined: String) -> DispatchResult {
    DispatchResult::Outcome(ToolOutcome::error_text(validation_error(tool, &joined)))
}

pub fn search_prts<'a>(app: &'a AppHandle, arguments: &'a Value) -> DispatchFuture<'a> {
    let mut args = Args::new(arguments);
    let query = args.required_string("query");
    let limit = args.int_default("limit", 1, Some(20), 5);
    let search_mode = args.enum_default("search_mode", &["text", "title"], "text");
    let filter_technical = args.boolean_default("filter_technical", true);
    let invalid = args.finish().err();
    Box::pin(async move {
        let _ = app; // no local data: the Wiki client is process-global (TS parity)
        if invalid.is_some() {
            return invalid_args("search_prts", invalid.unwrap_or_default());
        }
        let Some(query) = query else {
            unreachable!("required fields reported by finish()")
        };
        let transport = client::shared_transport();
        match search::build_prts_search(transport, &query, limit, &search_mode, filter_technical)
            .await
        {
            Err(message) => {
                // Domain-level validation message → bare text; everything
                // else is a fetch failure with the tool prefix.
                if message == "无效的 search_mode 参数，可选值：text、title。" {
                    DispatchResult::Outcome(ToolOutcome::text(message))
                } else {
                    DispatchResult::Outcome(ToolOutcome::text(format!("搜索 PRTS 失败：{message}")))
                }
            }
            Ok(data) => {
                let rendered = search::render_prts_search(&data);
                DispatchResult::Outcome(ToolOutcome::structured(rendered, data))
            }
        }
    })
}

pub fn prts_page<'a>(app: &'a AppHandle, arguments: &'a Value) -> DispatchFuture<'a> {
    let mut args = Args::new(arguments);
    let page_title = args.required_string("page_title");
    let action = args.required_enum(
        "action",
        &["read", "sections", "categories", "links", "template"],
    );
    let section_index = args.optional_int("section_index");
    let direction = args.enum_default("direction", &["outbound", "inbound"], "outbound");
    let limit = args.int_default("limit", 1, Some(100), 30);
    let invalid = args.finish().err();
    Box::pin(async move {
        let _ = app;
        if invalid.is_some() {
            return invalid_args("prts_page", invalid.unwrap_or_default());
        }
        let (Some(page_title), Some(action)) = (page_title, action) else {
            unreachable!("required fields reported by finish()")
        };
        let transport = client::shared_transport();
        match action.as_str() {
            "read" => match page::read_page(transport, &page_title, section_index).await {
                Ok(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
                Err(message) => DispatchResult::Outcome(ToolOutcome::text(message)),
            },
            "sections" => match page::list_sections(transport, &page_title).await {
                Ok(sections) if sections.is_empty() => DispatchResult::Outcome(ToolOutcome::text(
                    format!("页面 '{page_title}' 没有章节目录。"),
                )),
                Ok(sections) => DispatchResult::Outcome(ToolOutcome::text(
                    sections
                        .iter()
                        .map(|s| format!("[{}] L{} {}", s.index, s.level, s.line))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )),
                Err(message) => DispatchResult::Outcome(ToolOutcome::text(message)),
            },
            "categories" => match page::get_categories(transport, &page_title).await {
                Ok(cats) if cats.is_empty() => DispatchResult::Outcome(ToolOutcome::text(format!(
                    "页面 '{page_title}' 没有分类标签。"
                ))),
                Ok(cats) => DispatchResult::Outcome(ToolOutcome::text(
                    cats.iter()
                        .map(|c| format!("- {c}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )),
                Err(message) => DispatchResult::Outcome(ToolOutcome::text(message)),
            },
            "links" => {
                match page::get_links(transport, &page_title, &direction, limit as usize).await {
                    Ok(result) if result.links.is_empty() => {
                        let dir_label = if direction == "outbound" {
                            "出站"
                        } else {
                            "入站"
                        };
                        DispatchResult::Outcome(ToolOutcome::text(format!(
                            "页面 '{page_title}' 没有{dir_label}链接。"
                        )))
                    }
                    Ok(result) => {
                        let suffix = if result.has_more {
                            format!("\n（共 {} 条，还有更多）", result.total)
                        } else {
                            format!("\n（共 {} 条）", result.total)
                        };
                        let body = result
                            .links
                            .iter()
                            .map(|l| format!("- {l}"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        DispatchResult::Outcome(ToolOutcome::text(format!("{body}{suffix}")))
                    }
                    Err(message) => DispatchResult::Outcome(ToolOutcome::text(message)),
                }
            }
            _ => match page::get_template_data(transport, &page_title).await {
                Ok(templates) => {
                    let empty = templates.as_object().is_none_or(|o| o.is_empty());
                    if empty {
                        DispatchResult::Outcome(ToolOutcome::text(format!(
                            "页面 '{page_title}' 未找到可提取的模板数据。"
                        )))
                    } else {
                        DispatchResult::Outcome(ToolOutcome::text(page::templates_to_json_text(
                            &templates,
                        )))
                    }
                }
                Err(page::WikiError::Template(_)) => DispatchResult::Outcome(ToolOutcome::text(
                    "模板字段渲染失败。请改用 action=\"read\" 获取正文。",
                )),
                Err(page::WikiError::Plain(message)) => {
                    DispatchResult::Outcome(ToolOutcome::text(message))
                }
            },
        }
    })
}
