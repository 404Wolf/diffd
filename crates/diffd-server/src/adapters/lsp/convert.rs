//! Between LSP's JSON and diffd's types. Only the handful of shapes diffd
//! uses: positions, locations (and links), hovers and diagnostics.
//!
//! Positions: LSP counts lines from 0 and columns in UTF-16 code units (the
//! default encoding, which diffd asks for); diffd counts lines from 1 and
//! columns in UTF-16 too, so only lines shift.

use std::path::{Path, PathBuf};

use diffd_core::model::{CodeLocation, Diagnostic, LanguageServerState, Severity};
use serde_json::{Value, json};
use url::Url;

pub fn file_uri(path: &Path) -> String {
    Url::from_file_path(path).map(String::from).unwrap_or_else(|()| format!("file://{}", path.display()))
}

pub fn uri_path(uri: &str) -> Option<PathBuf> {
    Url::parse(uri).ok()?.to_file_path().ok()
}

/// An LSP position from a 1-based line and a UTF-16 column.
pub fn position(line: u32, col: u32) -> Value {
    json!({ "line": line.saturating_sub(1), "character": col })
}

/// Where a path is, as the page sees it: relative inside the repository, absolute outside.
pub fn location_path(path: &Path, repo_root: &Path) -> (String, bool) {
    match path.strip_prefix(repo_root) {
        Ok(rel) => (rel.to_string_lossy().into_owned(), false),
        Err(_) => (path.to_string_lossy().into_owned(), true),
    }
}

/// `Location | Location[] | LocationLink[] | null`, from definition-style requests.
pub fn locations(result: &Value, repo_root: &Path) -> Vec<CodeLocation> {
    let items: Vec<&Value> = match result {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        one => vec![one],
    };
    items
        .into_iter()
        .filter_map(|item| {
            // A LocationLink has targetUri and targetSelectionRange; a Location has uri and range.
            let (uri, range) = match item.get("targetUri") {
                Some(uri) => (uri, item.get("targetSelectionRange").or_else(|| item.get("targetRange"))?),
                None => (item.get("uri")?, item.get("range")?),
            };
            let path = uri_path(uri.as_str()?)?;
            let (path, external) = location_path(&path, repo_root);
            let start = range.get("start")?;
            Some(CodeLocation {
                path,
                external,
                line: start.get("line")?.as_u64()? as u32 + 1,
                col: start.get("character")?.as_u64()? as u32,
            })
        })
        .collect()
}

/// A hover's contents as Markdown: `MarkupContent`, a `MarkedString`, or a list of them.
pub fn hover_markdown(result: &Value) -> Option<String> {
    let contents = result.get("contents")?;
    let text = marked(contents);
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn marked(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(marked).filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n\n"),
        Value::Object(o) => match (o.get("language").and_then(Value::as_str), o.get("value").and_then(Value::as_str)) {
            // A MarkedString with a language is a code block.
            (Some(lang), Some(value)) => format!("```{lang}\n{value}\n```"),
            // MarkupContent: markdown or plaintext; plain text is valid Markdown near enough.
            (None, Some(value)) => value.to_owned(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// A `$/progress` value (begin, report or end) applied to what that token said
/// before: what it's working on now, or `None` once it's done.
pub fn progress(value: &Value, before: Option<LanguageServerState>) -> Option<LanguageServerState> {
    let message = value["message"].as_str().map(str::to_owned);
    let percentage = value["percentage"].as_u64().map(|p| p.min(100) as u32);
    match value["kind"].as_str()? {
        "begin" => Some(LanguageServerState::Busy { title: value["title"].as_str().unwrap_or_default().to_owned(), message, percentage }),
        "report" => match before? {
            LanguageServerState::Busy { title, message: old, percentage: was } => {
                Some(LanguageServerState::Busy { title, message: message.or(old), percentage: percentage.or(was) })
            }
            other => Some(other),
        },
        _ => None,
    }
}

/// `textDocument/publishDiagnostics` params → the file and its diagnostics.
pub fn diagnostics(params: &Value) -> Option<(PathBuf, Vec<Diagnostic>)> {
    let path = uri_path(params.get("uri")?.as_str()?)?;
    let items = params.get("diagnostics")?.as_array()?;
    let diagnostics = items
        .iter()
        .filter_map(|d| {
            let range = d.get("range")?;
            let (start, end) = (range.get("start")?, range.get("end")?);
            let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).map(|n| n as u32);
            Some(Diagnostic {
                line: num(start, "line")? + 1,
                col: num(start, "character")?,
                end_line: num(end, "line")? + 1,
                end_col: num(end, "character")?,
                severity: match d.get("severity").and_then(Value::as_u64) {
                    Some(2) => Severity::Warning,
                    Some(3) => Severity::Info,
                    Some(4) => Severity::Hint,
                    _ => Severity::Error,
                },
                message: d.get("message")?.as_str()?.to_owned(),
                source: d.get("source").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect();
    Some((path, diagnostics))
}

/// Answer `workspace/configuration`: each item's `section` looked up in the server's settings.
pub fn configuration(params: &Value, settings: &Value) -> Value {
    let items = params.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .iter()
            .map(|item| match item.get("section").and_then(Value::as_str) {
                Some(section) => section.split('.').try_fold(settings, |v, key| v.get(key)).cloned().unwrap_or(Value::Null),
                None => settings.clone(),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_and_links() {
        let root = Path::new("/repo");
        let loc = json!({ "uri": "file:///repo/src/a.rs", "range": { "start": { "line": 4, "character": 7 }, "end": { "line": 4, "character": 9 } } });
        let got = locations(&loc, root);
        assert_eq!(got, vec![CodeLocation { path: "src/a.rs".into(), external: false, line: 5, col: 7 }]);

        let link = json!([{ "targetUri": "file:///usr/lib/x.rs", "targetRange": { "start": { "line": 0, "character": 0 }, "end": { "line": 9, "character": 0 } },
            "targetSelectionRange": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 8 } } }]);
        let got = locations(&link, root);
        assert_eq!(got[0], CodeLocation { path: "/usr/lib/x.rs".into(), external: true, line: 3, col: 4 });
        assert!(locations(&Value::Null, root).is_empty());
    }

    #[test]
    fn hovers_in_every_shape() {
        assert_eq!(hover_markdown(&json!({ "contents": { "kind": "markdown", "value": "**x**" } })).unwrap(), "**x**");
        assert_eq!(hover_markdown(&json!({ "contents": { "language": "rust", "value": "fn f()" } })).unwrap(), "```rust\nfn f()\n```");
        assert_eq!(hover_markdown(&json!({ "contents": ["a", { "language": "go", "value": "b" }] })).unwrap(), "a\n\n```go\nb\n```");
        assert!(hover_markdown(&json!({ "contents": "" })).is_none());
    }

    #[test]
    fn progress_begins_reports_and_ends() {
        let busy = |message: Option<&str>, percentage| LanguageServerState::Busy {
            title: "Indexing".into(),
            message: message.map(Into::into),
            percentage,
        };
        let begun = progress(&json!({ "kind": "begin", "title": "Indexing", "percentage": 0 }), None);
        assert_eq!(begun, Some(busy(None, Some(0))));
        let reported = progress(&json!({ "kind": "report", "message": "4/10 (core)", "percentage": 40 }), begun);
        assert_eq!(reported, Some(busy(Some("4/10 (core)"), Some(40))));
        // A report without a percentage keeps the last one.
        let again = progress(&json!({ "kind": "report", "message": "5/10" }), reported);
        assert_eq!(again, Some(busy(Some("5/10"), Some(40))));
        assert_eq!(progress(&json!({ "kind": "end" }), again), None);
        // A report for a token that never began is ignored.
        assert_eq!(progress(&json!({ "kind": "report", "percentage": 3 }), None), None);
    }

    #[test]
    fn diagnostics_and_configuration() {
        let params = json!({ "uri": "file:///repo/a.py", "diagnostics": [
            { "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } }, "severity": 2, "message": "unused", "source": "pyright" },
            { "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "message": "boom" } ] });
        let (path, d) = diagnostics(&params).unwrap();
        assert_eq!(path, PathBuf::from("/repo/a.py"));
        assert_eq!((d[0].line, d[0].col, d[0].severity, d[0].source.as_deref()), (2, 2, Severity::Warning, Some("pyright")));
        assert_eq!(d[1].severity, Severity::Error, "no severity reads as an error");

        let settings = json!({ "yaml": { "validate": true } });
        let asked = json!({ "items": [{ "section": "yaml" }, { "section": "yaml.validate" }, { "section": "other" }] });
        assert_eq!(configuration(&asked, &settings), json!([{ "validate": true }, true, null]));
    }
}
