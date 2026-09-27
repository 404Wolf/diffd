//! diffd as an agent plugin: the files of the Claude Code and Codex plugins
//! (its MCP server, and the hooks that wake the agent when the user leaves
//! feedback; see `hook`), for `diffd install`, `diffd plugin` and the Nix
//! modules. Also recognises hooks an older `diffd setup` merged into a
//! settings file, so they can be taken out again.

use std::path::Path;

use anyhow::Context;
use serde_json::{Value, json};

use crate::hook::Harness;

const DEFAULT_PORT: u16 = 3433;

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+:@".contains(c)) {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// `<program> hook <args>`, with the port when it isn't the default.
fn hook_command(program: &str, args: &str, port: u16) -> String {
    let port = if port == DEFAULT_PORT { String::new() } else { format!(" --port {port}") };
    format!("{} hook{port} {args}", shell_quote(program))
}

/// Whether a hook command is one of ours: a `diffd` binary (any path) running `hook …`.
fn is_ours(command: &str) -> bool {
    // The program may be quoted and contain spaces: it's everything before ` hook `.
    let Some((program, _)) = command.split_once(" hook ") else { return false };
    Path::new(program.trim_matches('\'')).file_name().is_some_and(|n| n.to_string_lossy().starts_with("diffd"))
}

/// The hooks to install, per event: what the harness should run.
fn hooks(harness: Harness, program: &str, port: u16) -> Vec<(&'static str, Value)> {
    let name = match harness {
        Harness::Claude => "claude",
        Harness::Codex => "codex",
    };
    let stop = match harness {
        // Runs in the background; exit 2 wakes Claude with the notice.
        Harness::Claude => json!({
            "type": "command",
            "command": hook_command(program, name, port),
            "async": true,
            "asyncRewake": true,
        }),
        // Runs in the background; queues the notice into the session.
        Harness::Codex => json!({
            "type": "command",
            "command": hook_command(program, name, port),
            "async": true,
            "timeout": 86_400,
        }),
    };
    let end = json!({ "type": "command", "command": hook_command(program, &format!("end {name}"), port), "timeout": 3 });
    // Waiting starts again when a session starts (a restart shouldn't need a first
    // message) and when the user writes (an interrupted turn runs no Stop hook).
    // All share one waiter per session: each replaces the one before.
    vec![("SessionStart", stop.clone()), ("UserPromptSubmit", stop.clone()), ("Stop", stop), ("SessionEnd", end)]
}

/// Put our hooks into a hooks settings document, replacing earlier ones of ours
/// (with none, it just takes ours out).
pub(crate) fn merge_hooks(mut doc: Value, hooks: &[(&str, Value)]) -> anyhow::Result<Value> {
    if !doc.is_object() {
        doc = json!({});
    }
    let all = doc.as_object_mut().expect("an object").entry("hooks").or_insert_with(|| json!({}));
    let all = all.as_object_mut().context("`hooks` in the settings isn't an object")?;
    // Drop ours everywhere first, so a renamed or removed hook doesn't linger.
    for groups in all.values_mut() {
        let Some(groups) = groups.as_array_mut() else { continue };
        for group in groups.iter_mut() {
            if let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                list.retain(|h| !h.get("command").and_then(Value::as_str).is_some_and(is_ours));
            }
        }
        groups.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|l| !l.is_empty()));
    }
    all.retain(|_, groups| groups.as_array().is_none_or(|g| !g.is_empty()));
    for (event, handler) in hooks {
        let groups = all.entry(*event).or_insert_with(|| json!([]));
        groups.as_array_mut().context("a hook event isn't a list")?.push(json!({ "hooks": [handler] }));
    }
    Ok(doc)
}

pub(crate) fn read_json(path: &Path) -> anyhow::Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("{} isn't valid JSON", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// A plugin's files, relative to its root: the manifest, the hooks (which call
/// `program`), and unless `with_mcp` is off (another place registers it), the MCP server.
pub fn plugin_files(harness: Harness, program: &str, port: u16, with_mcp: bool) -> Vec<(String, String)> {
    let (agent, manifest_dir) = match harness {
        Harness::Claude => ("claude", ".claude-plugin"),
        Harness::Codex => ("codex", ".codex-plugin"),
    };
    let url = format!("http://localhost:{port}/mcp?agent={agent}");
    let mut manifest = json!({
        "name": "diffd",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Live code review of your changes in the browser; wakes you when the user leaves feedback",
        "homepage": "https://github.com/404Wolf/diffd",
        "license": "MIT",
    });
    // Claude finds hooks/hooks.json and .mcp.json by convention; Codex is told where they are.
    let server = match harness {
        Harness::Claude => json!({ "type": "http", "url": url }),
        Harness::Codex => {
            manifest["hooks"] = json!("./hooks/hooks.json");
            if with_mcp {
                manifest["mcpServers"] = json!("./.mcp.json");
            }
            json!({ "url": url })
        }
    };
    let pretty = |v: &Value| serde_json::to_string_pretty(v).expect("JSON") + "\n";
    let hooks = merge_hooks(json!({}), &hooks(harness, program, port)).expect("an empty document");
    let mut files = vec![(format!("{manifest_dir}/plugin.json"), pretty(&manifest)), ("hooks/hooks.json".to_owned(), pretty(&hooks))];
    if with_mcp {
        files.push((".mcp.json".to_owned(), pretty(&json!({ "mcpServers": { "diffd": server } }))));
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_merge_without_duplicates_or_losing_others() {
        let theirs = json!({
            "model": "x",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "/old/diffd hook claude" }] }],
            }
        });
        let ours = hooks(Harness::Claude, "/bin/diffd", 3433);
        let once = merge_hooks(theirs, &ours).unwrap();
        let twice = merge_hooks(once.clone(), &ours).unwrap();
        assert_eq!(once, twice, "running setup again changes nothing");
        assert_eq!(twice["model"], "x");
        let stop = twice["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(twice["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(stop.len(), 2, "their Stop hook stays, ours is added once: {stop:?}");
        assert!(twice["hooks"].get("PreToolUse").is_none(), "an old hook of ours elsewhere is gone");
        assert_eq!(stop[1]["hooks"][0]["asyncRewake"], true);
        assert!(twice["hooks"]["SessionEnd"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("hook end claude"));
    }

    #[test]
    fn commands_carry_the_port_and_are_recognised() {
        let c = hook_command("/opt/diffd", "codex", 4000);
        assert_eq!(c, "/opt/diffd hook --port 4000 codex");
        assert!(is_ours(&c));
        assert!(is_ours("'/a b/diffd' hook claude"));
        assert!(!is_ours("notdiffd hook claude"));
        assert_eq!(shell_quote("/a b/diffd"), "'/a b/diffd'");
    }

    #[test]
    fn plugins_carry_hooks_and_the_mcp_server() {
        let files: std::collections::BTreeMap<_, _> = plugin_files(Harness::Codex, "/opt/diffd", 3433, true).into_iter().collect();
        let manifest: Value = serde_json::from_str(&files[".codex-plugin/plugin.json"]).unwrap();
        assert_eq!(manifest["hooks"], "./hooks/hooks.json");
        assert!(files[".mcp.json"].contains("/mcp?agent=codex"));
        assert!(files["hooks/hooks.json"].contains("/opt/diffd hook codex"));
        let claude: Vec<String> = plugin_files(Harness::Claude, "/opt/diffd", 3433, false).into_iter().map(|(p, _)| p).collect();
        assert_eq!(claude, [".claude-plugin/plugin.json", "hooks/hooks.json"]);
    }
}
