//! operator_artwork dispatcher — port of TS `tools/artworkTools.ts`.
//!
//! LOCAL_IMAGE=true runs the local backend under one activation snapshot
//! (the active images generation resolved once per call); false runs the
//! MediaWiki backend with no snapshot (PRTS is the source of truth, not a
//! local generation that can swap mid-call).

use serde_json::Value;

use super::output::{ImageBlock, ToolOutcome};
use super::zodish::{validation_error, Args};
use super::{AppHandle, DispatchFuture, DispatchResult};
use crate::domain::artwork::local::{get_artwork_local, list_artworks_local, ArtworkOutcome};
use crate::domain::artwork::mediawiki;
use crate::wiki::client;

fn invalid_args(tool: &str, joined: String) -> DispatchResult {
    DispatchResult::Outcome(ToolOutcome::error_text(validation_error(tool, &joined)))
}

fn outcome_to_tool(outcome: ArtworkOutcome) -> ToolOutcome {
    match outcome {
        ArtworkOutcome::Message(message) => ToolOutcome::text(message),
        ArtworkOutcome::Structured {
            data,
            markdown,
            summary,
        } => {
            let mut tool = ToolOutcome::structured(markdown, data);
            tool.summary_override = summary;
            tool
        }
        ArtworkOutcome::Image {
            data,
            markdown,
            summary,
            image_b64,
            mime,
        } => ToolOutcome::image_result(
            markdown,
            Some(data),
            Some(summary),
            ImageBlock {
                data: image_b64,
                mime,
            },
        ),
    }
}

pub fn operator_artwork<'a>(app: &'a AppHandle, arguments: &'a Value) -> DispatchFuture<'a> {
    let mut args = Args::new(arguments);
    let operator_name = args.required_string("operator_name");
    let action = args.required_enum("action", &["list", "get"]);
    let artwork_id = args.string("artwork_id");
    let variant = args.optional_enum("variant", &["original", "large", "preview"]);
    let invalid = args.finish().err();
    Box::pin(async move {
        if invalid.is_some() {
            return invalid_args("operator_artwork", invalid.unwrap_or_default());
        }
        let (Some(operator_name), Some(action)) = (operator_name, action) else {
            unreachable!("required fields reported by finish()")
        };
        let config = app.config();

        // Get without a token is rejected before any backend work.
        if action == "get" && artwork_id.is_none() {
            return DispatchResult::Outcome(ToolOutcome::text(
                "action=get 时必须提供 artwork_id。请先用 action=list 获取。",
            ));
        }

        let outcome = if config.local_image {
            // One activation snapshot per call: the generation resolved once.
            let view = app.snapshot();
            let gen_dir = crate::sync::images_meta::active_generation(&config.images_path);
            let outcome = if action == "list" {
                list_artworks_local(&view, &operator_name, gen_dir.as_deref())
            } else {
                let artwork_id = artwork_id.unwrap_or_default();
                get_artwork_local(
                    &view,
                    &operator_name,
                    &artwork_id,
                    variant.as_deref(),
                    gen_dir.as_deref(),
                )
            };
            // Artwork resolves its own generation independently of DataState.
            // Discard any result from a directory bound after process startup.
            if let Err(error) =
                crate::sync::source_guard::verify(&config.images_path, &config.data_source)
            {
                crate::log_warn(&error);
                ArtworkOutcome::Message("本地立绘数据源与配置不一致，请使用独立数据目录。".into())
            } else {
                outcome
            }
        } else if action == "list" {
            mediawiki::list_artworks_mediawiki(client::shared_transport(), &operator_name).await
        } else {
            let artwork_id = artwork_id.unwrap_or_default();
            mediawiki::get_artwork_mediawiki(
                client::shared_transport(),
                &operator_name,
                &artwork_id,
                variant.as_deref(),
                config.prts_image_cache,
            )
            .await
        };
        DispatchResult::Outcome(outcome_to_tool(outcome))
    })
}
