//! `diffd install` / `diffd uninstall`: set diffd up for your user without Nix.
//!
//! Install copies the binary somewhere stable, starts it at login (a systemd
//! user unit on Linux, a launchd agent on macOS), and installs diffd as a
//! Claude Code and a Codex plugin (its MCP server and the wake hooks), for the
//! agents it finds. Running it again is an upgrade. What it did is recorded in
//! a manifest, and uninstall removes exactly that; your reviews stay unless
//! you ask (`--purge`).
//!
//! Everything is planned first, from the user's directories, then printed
//! (`--print`) or applied, so tests can run it against a temporary home.

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::Context;
use etcetera::BaseStrategy;
use serde::{Deserialize, Serialize};

use crate::hook::Harness;
use crate::setup;

/// Where things go, following XDG (on macOS too, like the rest of diffd's files).
#[derive(Debug, Clone)]
pub struct Dirs {
    pub home: PathBuf,
    /// `$XDG_BIN_HOME`, else `~/.local/bin` (XDG's user binary directory).
    pub bin: PathBuf,
    /// diffd's data directory: the reviews database and the install manifest.
    pub data: PathBuf,
    /// `$XDG_CONFIG_HOME`: systemd user units go under it.
    pub config: PathBuf,
    /// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    pub claude: PathBuf,
    /// `$CODEX_HOME`, else `~/.codex`.
    pub codex: PathBuf,
}

impl Dirs {
    pub fn from_env() -> anyhow::Result<Self> {
        let xdg = etcetera::choose_base_strategy().context("can't find your home directory")?;
        let home = xdg.home_dir().to_path_buf();
        let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        Ok(Self {
            bin: env("XDG_BIN_HOME").unwrap_or_else(|| home.join(".local/bin")),
            data: xdg.data_dir().join("diffd"),
            config: xdg.config_dir(),
            claude: env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            codex: env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            home,
        })
    }

    fn manifest(&self) -> PathBuf {
        self.data.join("install.json")
    }
    fn systemd_unit(&self) -> PathBuf {
        self.config.join("systemd/user/diffd.service")
    }
    fn launchd_plist(&self) -> PathBuf {
        self.home.join("Library/LaunchAgents/dev.diffd.plist")
    }
    fn claude_plugin(&self) -> PathBuf {
        // Claude Code loads personal plugins from here (`diffd@skills-dir`).
        self.claude.join("skills/diffd")
    }
    /// A local Codex marketplace holding diffd's plugin: Codex installs plugins from marketplaces.
    fn codex_marketplace(&self) -> PathBuf {
        self.data.join("codex-marketplace")
    }
}

/// The Codex marketplace diffd's plugin comes from: installed as `diffd@diffd`.
const CODEX_MARKETPLACE: &str = "diffd";
const LAUNCHD_LABEL: &str = "dev.diffd";

#[derive(Debug, Clone)]
pub struct Options {
    /// Which agents to set up; `None` means every one found on `PATH`.
    pub agents: Option<Vec<Harness>>,
    pub port: u16,
    /// Start diffd at login.
    pub service: bool,
    /// Copy the binary to the bin directory (off for `diffd setup`, which keeps it where it is).
    pub copy_binary: bool,
    /// Install even from a Nix store path.
    pub force: bool,
}

/// What an install did, so uninstall can undo exactly that.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub port: u16,
    /// The binary it copied (not one a package manager owns).
    pub binary: Option<PathBuf>,
    pub systemd_unit: Option<PathBuf>,
    pub launchd_plist: Option<PathBuf>,
    pub claude_plugin: Option<PathBuf>,
    /// The Codex marketplace it added (and installed diffd's plugin from).
    pub codex_marketplace: Option<PathBuf>,
}

/// One change. Planned, then printed or applied.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Copy a file through a temporary sibling, so it's never half-written.
    Copy {
        from: PathBuf,
        to: PathBuf,
    },
    /// Write a whole file (new, or a settings file edited in memory).
    Write {
        path: PathBuf,
        contents: String,
        why: &'static str,
    },
    RemoveFile(PathBuf),
    RemoveDir(PathBuf),
    /// A command; `must` is whether its failure stops the install.
    Run {
        program: String,
        args: Vec<String>,
        must: bool,
    },
}

impl fmt::Display for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Step::Copy { from, to } => write!(f, "copy {} → {}", from.display(), to.display()),
            Step::Write { path, why, .. } => write!(f, "write {} ({why})", path.display()),
            Step::RemoveFile(p) => write!(f, "remove {}", p.display()),
            Step::RemoveDir(p) => write!(f, "remove {}/", p.display()),
            Step::Run { program, args, .. } => write!(f, "run {program} {}", args.join(" ")),
        }
    }
}

/// A plan: the steps, and what to tell the user once they're done.
#[derive(Debug, Default)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub report: Vec<(String, String)>,
}

impl Plan {
    fn say(&mut self, what: &str, detail: impl Into<String>) {
        self.report.push((what.to_owned(), detail.into()));
    }

    pub fn apply(&self) -> anyhow::Result<()> {
        for step in &self.steps {
            apply(step).with_context(|| step.to_string())?;
        }
        Ok(())
    }

    pub fn print_report(&self) {
        for (what, detail) in &self.report {
            println!("{what:<12} {detail}");
        }
    }
}

fn apply(step: &Step) -> anyhow::Result<()> {
    match step {
        Step::Copy { from, to } => {
            if let Some(dir) = to.parent() {
                std::fs::create_dir_all(dir)?;
            }
            // A running diffd keeps its old file: replace it by renaming, never by writing into it.
            let tmp = to.with_extension("diffd-new");
            std::fs::copy(from, &tmp)?;
            set_executable(&tmp)?;
            std::fs::rename(&tmp, to)?;
        }
        Step::Write { path, contents, .. } => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("diffd-tmp");
            std::fs::write(&tmp, contents)?;
            std::fs::rename(&tmp, path)?;
        }
        Step::RemoveFile(p) => match std::fs::remove_file(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        },
        Step::RemoveDir(p) => match std::fs::remove_dir_all(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        },
        Step::Run { program, args, must } => {
            // Quiet unless it fails: agents' CLIs chatter about what they did.
            let out = std::process::Command::new(program).args(args).output();
            match out {
                Ok(o) if o.status.success() => {}
                Ok(o) if *must => {
                    anyhow::bail!("`{program} {}` failed ({}): {}", args.join(" "), o.status, String::from_utf8_lossy(&o.stderr).trim())
                }
                Err(e) if *must => anyhow::bail!("running `{program}`: {e}"),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn set_executable(_: &Path) -> std::io::Result<()> {
    Ok(())
}

/// What install needs from the machine, gathered once (and faked in tests).
#[derive(Debug, Clone)]
pub struct Host {
    /// This binary, resolved.
    pub exe: PathBuf,
    pub version: String,
    /// `PATH`, for finding agents and for the service (service managers start programs with a bare one).
    pub path: String,
    pub os: Os,
    /// Whether `systemctl --user` works here.
    pub systemd: bool,
    /// Whether the user's services keep running after they log out.
    pub linger: bool,
    pub uid: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Os {
    Linux,
    Mac,
    Other,
}

impl Host {
    pub fn detect() -> anyhow::Result<Self> {
        let exe = std::env::current_exe().context("finding this binary")?;
        let exe = exe.canonicalize().unwrap_or(exe);
        let os = match std::env::consts::OS {
            "linux" => Os::Linux,
            "macos" => Os::Mac,
            _ => Os::Other,
        };
        let succeeds = |program: &str, args: &[&str]| {
            std::process::Command::new(program)
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let output = |program: &str, args: &[&str]| {
            std::process::Command::new(program)
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        };
        let user = std::env::var("USER").unwrap_or_default();
        Ok(Self {
            exe,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            path: std::env::var("PATH").unwrap_or_default(),
            os,
            systemd: os == Os::Linux && succeeds("systemctl", &["--user", "show-environment"]),
            linger: output("loginctl", &["show-user", &user, "-p", "Linger", "--value"]).is_some_and(|v| v == "yes"),
            uid: output("id", &["-u"]).unwrap_or_default(),
        })
    }

    fn find(&self, program: &str) -> Option<PathBuf> {
        std::env::split_paths(&self.path).map(|dir| dir.join(program)).find(|p| p.is_file())
    }
}

/// Whether home-manager (or anything else Nix) owns this path: a link into the store.
fn nix_managed(path: &Path) -> bool {
    path.is_symlink() && std::fs::canonicalize(path).is_ok_and(|p| p.starts_with("/nix/store"))
}

pub fn plan_install(dirs: &Dirs, host: &Host, opts: &Options) -> anyhow::Result<Plan> {
    let mut plan = Plan::default();
    let mut manifest = Manifest { port: opts.port, ..read_manifest(dirs)?.unwrap_or_default() };

    // The binary, somewhere that stays put: the service and hooks point at it,
    // so an upgrade is a new binary and `diffd install` again.
    if host.exe.starts_with("/nix/store") && !opts.force {
        anyhow::bail!(
            "this diffd comes from Nix: use its NixOS or home-manager module instead (see the README), \
             or pass --force to install this copy anyway"
        );
    }
    let exe = if !opts.copy_binary || host.exe.components().any(|c| c.as_os_str() == "Cellar") {
        // Homebrew (or `diffd setup`): the package manager owns it; use it where it is.
        host.exe.clone()
    } else {
        let to = dirs.bin.join("diffd");
        if host.exe != to {
            plan.steps.push(Step::Copy { from: host.exe.clone(), to: to.clone() });
        }
        manifest.binary = Some(to.clone());
        if !std::env::split_paths(&host.path).any(|d| d == dirs.bin) {
            plan.say("", format!("note: {} isn't on your PATH; add it in your shell's rc file", dirs.bin.display()));
        }
        to
    };
    plan.report.insert(0, ("diffd".into(), format!("{} → {}", host.version, exe.display())));

    if opts.service {
        plan_service(dirs, host, opts.port, &exe, &mut plan, &mut manifest);
    }

    let agents = match &opts.agents {
        Some(list) => list.clone(),
        None => [Harness::Claude, Harness::Codex].into_iter().filter(|h| host.find(agent_program(*h)).is_some()).collect(),
    };
    for agent in &agents {
        match agent {
            Harness::Claude => plan_claude(dirs, opts.port, &exe, &mut plan, &mut manifest)?,
            Harness::Codex => plan_codex(dirs, host, opts.port, &exe, &mut plan, &mut manifest)?,
        }
    }
    if agents.is_empty() {
        plan.say("agents", format!("none found; any agent can use http://localhost:{}/mcp (and `diffd hook wait`)", opts.port));
    }

    plan.steps.push(Step::Write {
        path: dirs.manifest(),
        contents: serde_json::to_string_pretty(&manifest)? + "\n",
        why: "what was installed",
    });
    Ok(plan)
}

fn agent_program(h: Harness) -> &'static str {
    match h {
        Harness::Claude => "claude",
        Harness::Codex => "codex",
    }
}

fn plan_service(dirs: &Dirs, host: &Host, port: u16, exe: &Path, plan: &mut Plan, manifest: &mut Manifest) {
    let run = |program: &str, args: &[&str], must: bool| Step::Run {
        program: program.into(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        must,
    };
    match host.os {
        Os::Linux if host.systemd => {
            let unit = dirs.systemd_unit();
            if nix_managed(&unit) {
                plan.say("service", "managed by home-manager; leaving it");
                return;
            }
            plan.steps.push(Step::Write { path: unit.clone(), contents: systemd_unit(exe, port, &host.path), why: "systemd user unit" });
            plan.steps.push(run("systemctl", &["--user", "daemon-reload"], true));
            plan.steps.push(run("systemctl", &["--user", "enable", "diffd.service"], true));
            plan.steps.push(run("systemctl", &["--user", "restart", "diffd.service"], true));
            manifest.systemd_unit = Some(unit);
            plan.say("service", format!("systemd user unit, running at http://localhost:{port}"));
            if !host.linger {
                plan.say("", "note: it stops when you log out; to keep it running: sudo loginctl enable-linger $USER");
            }
        }
        Os::Mac => {
            let plist = dirs.launchd_plist();
            let log = dirs.data.join("diffd.log");
            plan.steps.push(Step::Write {
                path: plist.clone(),
                contents: launchd_plist(exe, port, &host.path, &log),
                why: "launchd agent",
            });
            let target = format!("gui/{}", host.uid);
            plan.steps.push(run("launchctl", &["bootout", &format!("{target}/{LAUNCHD_LABEL}")], false));
            plan.steps.push(run("launchctl", &["bootstrap", &target, &plist.to_string_lossy()], true));
            manifest.launchd_plist = Some(plist);
            plan.say("service", format!("launchd agent, running at http://localhost:{port} (log: {})", log.display()));
        }
        _ => plan.say("service", format!("no systemd user session or launchd here: run `{} serve` yourself", exe.display())),
    }
}

fn systemd_unit(exe: &Path, port: u16, path: &str) -> String {
    format!(
        "[Unit]\n\
         Description=diffd: live code review of your agent's changes\n\
         After=network.target\n\
         \n\
         [Service]\n\
         ExecStart=\"{exe}\" serve --port {port}\n\
         # Service managers start programs with a bare PATH: this is the one diffd was\n\
         # installed from, so it finds git, difft and your language servers.\n\
         Environment=\"PATH={path}\"\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         # Language servers run under diffd: a runaway stays inside this service.\n\
         MemoryHigh=50%\n\
         MemoryMax=75%\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe.display()
    )
}

fn launchd_plist(exe: &Path, port: u16, path: &str, log: &Path) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>serve</string><string>--port</string><string>{port}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        exe = esc(&exe.to_string_lossy()),
        path = esc(path),
        log = esc(&log.to_string_lossy()),
    )
}

fn plugin_writes(dir: &Path, harness: Harness, exe: &Path, port: u16, plan: &mut Plan) {
    for (rel, contents) in setup::plugin_files(harness, &exe.to_string_lossy(), port, true) {
        plan.steps.push(Step::Write { path: dir.join(rel), contents, why: "plugin" });
    }
}

fn plan_claude(dirs: &Dirs, port: u16, exe: &Path, plan: &mut Plan, manifest: &mut Manifest) -> anyhow::Result<()> {
    let dir = dirs.claude_plugin();
    if nix_managed(&dir) {
        plan.say("Claude Code", "plugin managed by home-manager; leaving it");
        return Ok(());
    }
    plan.steps.push(Step::RemoveDir(dir.clone()));
    plugin_writes(&dir, Harness::Claude, exe, port, plan);
    manifest.claude_plugin = Some(dir.clone());
    // What an older `diffd setup` added: hooks in settings.json, and the MCP server.
    let settings = dirs.claude.join("settings.json");
    if let Some(cleaned) = without_setup_hooks(&settings)? {
        plan.steps.push(Step::Write { path: settings, contents: cleaned, why: "remove hooks from an older `diffd setup`" });
    }
    let state = dirs.home.join(".claude.json");
    if setup::read_json(&state)?.pointer("/mcpServers/diffd").is_some() {
        plan.steps.push(Step::Run {
            program: "claude".into(),
            args: ["mcp", "remove", "--scope", "user", "diffd"].map(String::from).to_vec(),
            must: false,
        });
    }
    plan.say("Claude Code", format!("plugin in {} (MCP + wake hooks); restart Claude Code to load it", dir.display()));
    Ok(())
}

fn plan_codex(dirs: &Dirs, host: &Host, port: u16, exe: &Path, plan: &mut Plan, manifest: &mut Manifest) -> anyhow::Result<()> {
    let config = dirs.codex.join("config.toml");
    if nix_managed(&config) {
        plan.say("Codex", "config.toml is managed by home-manager; use the module's plugin instead");
        return Ok(());
    }
    let Some(codex) = host.find("codex") else {
        plan.say("Codex", "`codex` isn't on your PATH: install Codex, then run `diffd install` again");
        return Ok(());
    };
    // Codex installs plugins from marketplaces: diffd keeps a local one with just its plugin,
    // and lets Codex's own commands add it (Codex copies it into its plugin cache and enables it).
    let root = dirs.codex_marketplace();
    plan.steps.push(Step::RemoveDir(root.clone()));
    let listing = serde_json::json!({
        "name": CODEX_MARKETPLACE,
        "interface": { "displayName": "diffd" },
        "plugins": [{
            "name": "diffd",
            "source": { "source": "local", "path": "./plugins/diffd" },
            "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
            "category": "Productivity",
        }],
    });
    plan.steps.push(Step::Write {
        path: root.join(".agents/plugins/marketplace.json"),
        contents: serde_json::to_string_pretty(&listing)? + "\n",
        why: "a local Codex marketplace",
    });
    plugin_writes(&root.join("plugins/diffd"), Harness::Codex, exe, port, plan);
    let text = std::fs::read_to_string(&config).unwrap_or_default();
    let edited = codex_enable(&text, port)?;
    if edited != text {
        plan.steps.push(Step::Write { path: config, contents: edited, why: "turn on plugins and hooks" });
    }
    let codex = codex.to_string_lossy().into_owned();
    let run = |args: &[&str], must: bool| Step::Run { program: codex.clone(), args: args.iter().map(|a| (*a).to_owned()).collect(), must };
    let plugin = format!("diffd@{CODEX_MARKETPLACE}");
    // Removed first, so an upgrade's files are copied again; the marketplace may already be there.
    plan.steps.push(run(&["plugin", "remove", &plugin], false));
    plan.steps.push(run(&["plugin", "marketplace", "add", &root.to_string_lossy()], false));
    plan.steps.push(run(&["plugin", "add", &plugin], true));
    manifest.codex_marketplace = Some(root);
    let hooks = dirs.codex.join("hooks.json");
    if let Some(cleaned) = without_setup_hooks(&hooks)? {
        plan.steps.push(Step::Write { path: hooks, contents: cleaned, why: "remove hooks from an older `diffd setup`" });
    }
    plan.say("Codex", format!("plugin {plugin} (MCP + wake hooks); in Codex, run /hooks and trust diffd's once"));
    Ok(())
}

/// A settings file without hooks an older `diffd setup` merged in, if it had any.
fn without_setup_hooks(path: &Path) -> anyhow::Result<Option<String>> {
    if nix_managed(path) {
        return Ok(None);
    }
    let doc = setup::read_json(path)?;
    let cleaned = setup::merge_hooks(doc.clone(), &[])?;
    // merge_hooks leaves an empty `hooks` object behind: drop it if it wasn't there.
    let cleaned = match cleaned {
        serde_json::Value::Object(mut map) if doc.get("hooks").is_none() => {
            map.remove("hooks");
            serde_json::Value::Object(map)
        }
        other => other,
    };
    Ok((cleaned != doc).then(|| serde_json::to_string_pretty(&cleaned).unwrap_or_default() + "\n"))
}

/// Codex's config.toml with the plugin and hook features on, keeping everything
/// else, comments included. An MCP server an older `diffd setup` registered
/// goes: the plugin has it now.
fn codex_enable(text: &str, port: u16) -> anyhow::Result<String> {
    let mut doc: toml_edit::DocumentMut = text.parse().context("Codex's config.toml isn't valid TOML")?;
    // A [features] section, like people write it (indexing a missing key would make an inline table).
    if doc.get("features").is_none() {
        doc["features"] = toml_edit::table();
    }
    doc["features"]["plugins"] = toml_edit::value(true);
    doc["features"]["hooks"] = toml_edit::value(true);
    let ours = format!("http://localhost:{port}/mcp");
    if let Some(servers) = doc.get_mut("mcp_servers").and_then(|s| s.as_table_like_mut())
        && servers.get("diffd").and_then(|d| d.get("url")).and_then(|u| u.as_str()).is_some_and(|u| u.starts_with(&ours))
    {
        servers.remove("diffd");
    }
    Ok(doc.to_string())
}

fn read_manifest(dirs: &Dirs) -> anyhow::Result<Option<Manifest>> {
    match std::fs::read_to_string(dirs.manifest()) {
        Ok(text) => Ok(Some(serde_json::from_str(&text).context("the install manifest is damaged")?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn plan_uninstall(dirs: &Dirs, host: &Host, purge: bool) -> anyhow::Result<Plan> {
    let mut plan = Plan::default();
    let Some(m) = read_manifest(dirs)? else {
        plan.say("diffd", format!("nothing to uninstall ({} doesn't exist)", dirs.manifest().display()));
        return Ok(plan);
    };
    let run = |program: &str, args: Vec<String>| Step::Run { program: program.into(), args, must: false };
    if let Some(unit) = m.systemd_unit {
        plan.steps.push(run("systemctl", ["--user", "disable", "--now", "diffd.service"].map(String::from).to_vec()));
        plan.steps.push(Step::RemoveFile(unit));
        plan.steps.push(run("systemctl", ["--user", "daemon-reload"].map(String::from).to_vec()));
    }
    if let Some(plist) = m.launchd_plist {
        plan.steps.push(run("launchctl", vec!["bootout".into(), format!("gui/{}/{LAUNCHD_LABEL}", host.uid)]));
        plan.steps.push(Step::RemoveFile(plist));
    }
    if let Some(dir) = m.claude_plugin {
        plan.steps.push(Step::RemoveDir(dir));
    }
    if let Some(root) = m.codex_marketplace {
        let codex = host.find("codex").map_or_else(|| "codex".to_owned(), |p| p.to_string_lossy().into_owned());
        plan.steps.push(run(&codex, ["plugin", "remove", "diffd@diffd"].map(String::from).to_vec()));
        plan.steps.push(run(&codex, ["plugin", "marketplace", "remove", CODEX_MARKETPLACE].map(String::from).to_vec()));
        plan.steps.push(Step::RemoveDir(root));
    }
    if let Some(bin) = m.binary {
        plan.steps.push(Step::RemoveFile(bin));
    }
    if purge {
        plan.steps.push(Step::RemoveDir(dirs.data.clone()));
        plan.say("diffd", "uninstalled, and your reviews deleted");
    } else {
        plan.steps.push(Step::RemoveFile(dirs.manifest()));
        plan.say("diffd", format!("uninstalled; your reviews are still in {} (--purge deletes them)", dirs.data.display()));
    }
    Ok(plan)
}

/// Run a plan, or with `print` show it and change nothing.
pub fn execute(plan: &Plan, print: bool) -> anyhow::Result<()> {
    if print {
        println!("Would do (nothing is changed with --print):");
        for step in &plan.steps {
            println!("  {step}");
        }
        println!();
    } else {
        plan.apply()?;
    }
    plan.print_report();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Dirs, Host) {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let dirs = Dirs {
            bin: home.join(".local/bin"),
            data: home.join(".local/share/diffd"),
            config: home.join(".config"),
            claude: home.join(".claude"),
            codex: home.join(".codex"),
            home: home.clone(),
        };
        let exe = home.join("download/diffd");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        // A stand-in `codex` that logs what it's asked to do.
        let agents = home.join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        let codex = agents.join("codex");
        std::fs::write(&codex, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", home.join("codex.log").display())).unwrap();
        set_executable(&codex).unwrap();
        let host = Host {
            exe,
            version: "1.2.3".into(),
            path: agents.to_string_lossy().into_owned(),
            os: Os::Linux,
            systemd: false,
            linger: false,
            uid: "1000".into(),
        };
        (tmp, dirs, host)
    }

    fn opts() -> Options {
        Options { agents: Some(vec![Harness::Claude, Harness::Codex]), port: 3433, service: false, copy_binary: true, force: false }
    }

    #[test]
    fn installs_plugins_and_uninstalls_exactly_that() {
        let (_tmp, dirs, host) = fixture();
        let codex_config = "# mine\nmodel = \"x\"\n\n[features]\nhooks = false # set by me\n\n[mcp_servers.diffd]\nurl = \"http://localhost:3433/mcp?agent=codex\"\n\n[mcp_servers.other]\nurl = \"http://other\"\n";
        std::fs::create_dir_all(&dirs.codex).unwrap();
        std::fs::write(dirs.codex.join("config.toml"), codex_config).unwrap();
        std::fs::create_dir_all(&dirs.claude).unwrap();
        let settings = r#"{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/old/diffd hook claude","async":true}]},{"hooks":[{"type":"command","command":"keep-me"}]}]}}"#;
        std::fs::write(dirs.claude.join("settings.json"), settings).unwrap();

        plan_install(&dirs, &host, &opts()).unwrap().apply().unwrap();

        let bin = dirs.bin.join("diffd");
        assert!(bin.is_file(), "the binary is copied");
        let hooks = std::fs::read_to_string(dirs.claude_plugin().join("hooks/hooks.json")).unwrap();
        assert!(hooks.contains(&format!("{} hook claude", bin.display())), "hooks call the installed binary: {hooks}");
        assert!(dirs.claude_plugin().join(".claude-plugin/plugin.json").is_file());
        assert!(dirs.claude_plugin().join(".mcp.json").is_file());
        let market = dirs.codex_marketplace();
        assert!(market.join(".agents/plugins/marketplace.json").is_file());
        assert!(market.join("plugins/diffd/.codex-plugin/plugin.json").is_file());
        let log = std::fs::read_to_string(dirs.home.join("codex.log")).unwrap();
        assert_eq!(
            log,
            format!("plugin remove diffd@diffd\nplugin marketplace add {}\nplugin add diffd@diffd\n", market.display()),
            "Codex's own commands install it"
        );

        let settings = std::fs::read_to_string(dirs.claude.join("settings.json")).unwrap();
        assert!(!settings.contains("/old/diffd") && settings.contains("keep-me"), "old setup hooks go, others stay: {settings}");

        let config = std::fs::read_to_string(dirs.codex.join("config.toml")).unwrap();
        let parsed: toml::Table = config.parse().unwrap();
        assert_eq!(parsed["features"]["hooks"].as_bool(), Some(true));
        assert_eq!(parsed["features"]["plugins"].as_bool(), Some(true));
        assert!(parsed["mcp_servers"].get("diffd").is_none(), "setup's MCP server goes: the plugin has it");
        assert!(parsed["mcp_servers"].get("other").is_some());
        assert!(config.starts_with("# mine\n"), "comments stay: {config}");

        // Installing again changes nothing.
        let again = plan_install(&dirs, &host, &opts()).unwrap();
        assert!(!again.steps.iter().any(|s| matches!(s, Step::Write { why: "turn on plugins and hooks", .. })));
        again.apply().unwrap();
        assert_eq!(std::fs::read_to_string(dirs.codex.join("config.toml")).unwrap(), config);

        plan_uninstall(&dirs, &host, false).unwrap().apply().unwrap();
        assert!(!bin.exists() && !dirs.claude_plugin().exists() && !market.exists());
        let log = std::fs::read_to_string(dirs.home.join("codex.log")).unwrap();
        assert!(log.ends_with("plugin remove diffd@diffd\nplugin marketplace remove diffd\n"), "{log}");
        assert!(!dirs.manifest().exists());
        let config = std::fs::read_to_string(dirs.codex.join("config.toml")).unwrap();
        assert!(!config.contains("diffd@diffd") && config.contains("[mcp_servers.other]"), "{config}");
        assert!(dirs.claude.join("settings.json").is_file(), "the user's own files stay");
    }

    #[test]
    fn a_fresh_codex_config_gets_a_features_section() {
        let config = codex_enable("model = \"gpt\"\n", 3433).unwrap();
        assert_eq!(config, "model = \"gpt\"\n\n[features]\nplugins = true\nhooks = true\n");
    }

    #[test]
    fn a_nix_binary_points_at_the_modules() {
        let (_tmp, dirs, mut host) = fixture();
        host.exe = "/nix/store/abc-diffd-0.1.0/bin/diffd".into();
        let err = plan_install(&dirs, &host, &opts()).unwrap_err().to_string();
        assert!(err.contains("home-manager module"), "{err}");
        assert!(plan_install(&dirs, &host, &Options { force: true, ..opts() }).is_ok());
    }

    #[test]
    fn services_carry_the_path_and_the_port() {
        let (_tmp, dirs, mut host) = fixture();
        host.systemd = true;
        host.path = "/opt/tools/bin:/usr/bin".into();
        let plan = plan_install(&dirs, &host, &Options { service: true, port: 4000, ..opts() }).unwrap();
        let unit = plan
            .steps
            .iter()
            .find_map(|s| match s {
                Step::Write { contents, why: "systemd user unit", .. } => Some(contents.clone()),
                _ => None,
            })
            .unwrap();
        assert!(unit.contains(&format!("ExecStart=\"{}\" serve --port 4000", dirs.bin.join("diffd").display())), "{unit}");
        assert!(unit.contains("Environment=\"PATH=/opt/tools/bin:/usr/bin\""));
        assert!(plan.steps.contains(&Step::Run {
            program: "systemctl".into(),
            args: vec!["--user".into(), "restart".into(), "diffd.service".into()],
            must: true
        }));

        host.os = Os::Mac;
        let plan = plan_install(&dirs, &host, &Options { service: true, ..opts() }).unwrap();
        assert!(
            plan.steps
                .iter()
                .any(|s| matches!(s, Step::Write { why: "launchd agent", contents, .. } if contents.contains("<string>serve</string>")))
        );
    }

    #[test]
    fn only_agents_on_path_by_default() {
        // The fixture's PATH has `codex` and no `claude`.
        let (_tmp, dirs, host) = fixture();
        let plan = plan_install(&dirs, &host, &Options { agents: None, ..opts() }).unwrap();
        let wrote = |dir: &Path| plan.steps.iter().any(|s| matches!(s, Step::Write { path, .. } if path.starts_with(dir)));
        assert!(wrote(&dirs.codex_marketplace()) && !wrote(&dirs.claude_plugin()));
    }
}
