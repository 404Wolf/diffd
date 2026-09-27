//! `diffd setup claude|codex`: register diffd's MCP server with an agent and
//! install the hooks that wake it when the user leaves feedback (see `hook`).
//! Running it again replaces diffd's hooks instead of adding more.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::{Value, json};

use crate::hook::Harness;

const DEFAULT_PORT: u16 = 3433;

/// How hooks should call this binary: `diffd` when it was found on `PATH`,
/// else the path it was run by (not resolved, so a Nix profile link keeps working).
fn self_command() -> String {
    let argv0 = std::env::args_os().next().map(PathBuf::from).unwrap_or_else(|| "diffd".into());
    let program = if argv0.components().count() == 1 {
        "diffd".to_owned()
    } else {
        std::path::absolute(&argv0).unwrap_or(argv0).to_string_lossy().into_owned()
    };
    shell_quote(&program)
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+:@".contains(c)) {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// `diffd … hook <args>`, with the port when it isn't the default.
fn hook_command(args: &str, port: u16) -> String {
    let port = if port == DEFAULT_PORT { String::new() } else { format!(" --port {port}") };
    format!("{} hook{port} {args}", self_command())
}

/// Whether a hook command is one of ours: a `diffd` binary (any path) running `hook …`.
fn is_ours(command: &str) -> bool {
    // The program may be quoted and contain spaces: it's everything before ` hook `.
    let Some((program, _)) = command.split_once(" hook ") else { return false };
    Path::new(program.trim_matches('\'')).file_name().is_some_and(|n| n.to_string_lossy().starts_with("diffd"))
}

/// The hooks to install, per event: what the harness should run.
fn hooks(harness: Harness, port: u16) -> Vec<(&'static str, Value)> {
    let name = match harness {
        Harness::Claude => "claude",
        Harness::Codex => "codex",
    };
    let stop = match harness {
        // Runs in the background; exit 2 wakes Claude with the notice.
        Harness::Claude => json!({
            "type": "command",
            "command": hook_command(name, port),
            "async": true,
            "asyncRewake": true,
        }),
        // Runs in the background; queues the notice into the session.
        Harness::Codex => json!({
            "type": "command",
            "command": hook_command(name, port),
            "async": true,
            "timeout": 86_400,
        }),
    };
    let end = json!({ "type": "command", "command": hook_command(&format!("end {name}"), port), "timeout": 3 });
    // Waiting starts again when a session starts (a restart shouldn't need a first
    // message) and when the user writes (an interrupted turn runs no Stop hook).
    // All share one waiter per session: each replaces the one before.
    vec![("SessionStart", stop.clone()), ("UserPromptSubmit", stop.clone()), ("Stop", stop), ("SessionEnd", end)]
}

/// Put our hooks into a hooks settings document, replacing earlier ones of ours.
fn merge_hooks(mut doc: Value, hooks: &[(&str, Value)]) -> anyhow::Result<Value> {
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

fn read_json(path: &Path) -> anyhow::Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("{} isn't valid JSON", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Write through a temporary file, so a crash never leaves half a settings file.
fn write_json(path: &Path, doc: &Value) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.diffd-tmp");
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(doc)?))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

fn home() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).context("HOME isn't set")
}

fn run(program: &str, args: &[&str]) -> anyhow::Result<std::process::Output> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running `{program}` (is it installed? use --print to see what to do by hand)"))
}

pub fn claude(print: bool, port: u16) -> anyhow::Result<()> {
    // The page names the agent from this (its MCP client doesn't say).
    let url = format!("http://localhost:{port}/mcp?agent=claude");
    let add = ["mcp", "add", "--transport", "http", "--scope", "user", "diffd", url.as_str()];
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).map_or_else(|| home().map(|h| h.join(".claude")), Ok)?;
    let settings = dir.join("settings.json");
    let hooks = hooks(Harness::Claude, port);
    if print {
        println!(
            "claude {}\n\nand in {}:\n{}",
            add.join(" "),
            settings.display(),
            serde_json::to_string_pretty(&merge_hooks(json!({}), &hooks)?)?
        );
        return Ok(());
    }
    let out = run("claude", &add)?;
    let said = String::from_utf8_lossy(&out.stderr);
    anyhow::ensure!(out.status.success() || said.contains("already exists"), "`claude mcp add` failed: {}", said.trim());
    write_json(&settings, &merge_hooks(read_json(&settings)?, &hooks)?)?;
    println!(
        "Added diffd to Claude Code, with hooks in {} so Claude hears your review comments even when it's idle.\n\
         Start the server with `diffd`, then ask Claude to share its changes.",
        settings.display()
    );
    Ok(())
}

pub fn codex(print: bool, port: u16) -> anyhow::Result<()> {
    let url = format!("http://localhost:{port}/mcp?agent=codex");
    let add = ["mcp", "add", "diffd", "--url", url.as_str()];
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).map_or_else(|| home().map(|h| h.join(".codex")), Ok)?;
    let file = home.join("hooks.json");
    let hooks = hooks(Harness::Codex, port);
    if print {
        println!(
            "codex {}\n\nand in {}:\n{}",
            add.join(" "),
            file.display(),
            serde_json::to_string_pretty(&merge_hooks(json!({}), &hooks)?)?
        );
        return Ok(());
    }
    let out = run("codex", &add)?;
    let said = String::from_utf8_lossy(&out.stderr);
    anyhow::ensure!(out.status.success() || said.contains("already exists"), "`codex mcp add` failed: {}", said.trim());
    write_json(&file, &merge_hooks(read_json(&file)?, &hooks)?)?;
    println!(
        "Added diffd to Codex, with hooks in {} so Codex hears your review comments even when it's idle.\n\
         Codex runs new hooks only once you trust them: open Codex, run /hooks, and trust diffd's hooks (press t to trust all).\n\
         Start the server with `diffd`, then ask Codex to share its changes.",
        file.display()
    );
    Ok(())
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
        let ours = hooks(Harness::Claude, 3433);
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
        let c = hook_command("codex", 4000);
        assert!(c.ends_with(" hook --port 4000 codex"), "{c}");
        assert!(is_ours(&c));
        assert!(is_ours("'/a b/diffd' hook claude"));
        assert!(!is_ours("notdiffd hook claude"));
        assert_eq!(shell_quote("/a b/diffd"), "'/a b/diffd'");
    }
}
