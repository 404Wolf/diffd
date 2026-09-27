//! diffd's configuration file. The documented defaults live in
//! `config.default.toml`; a user's file is merged over them, table by table,
//! so it only needs what it changes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;

/// The defaults, with comments: also what `diffd config` prints.
pub const DEFAULT_CONFIG: &str = include_str!("../config.default.toml");

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server: ServerSection,
    pub lsp: LspConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSection {
    pub port: u16,
    /// Empty for the default location.
    pub db: String,
    /// The address to listen on.
    pub bind: String,
    /// Extra `Host` names the review pages answer to (MCP stays loopback-only).
    pub allowed_hosts: Vec<String>,
    /// The base of the review links agents hand out. Empty means
    /// `http://localhost:<port>`.
    pub public_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspConfig {
    pub enabled: bool,
    pub request_timeout_secs: u64,
    pub idle_timeout_secs: u64,
    pub max_open_files: usize,
    pub servers: BTreeMap<String, LanguageServer>,
}

/// How to run one language server, and which files it's for.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LanguageServer {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// LSP language id → file extensions (without the dot).
    pub languages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub root_markers: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub initialization_options: Option<toml::Value>,
    /// Answers to the server's `workspace/configuration` requests, by section.
    #[serde(default)]
    pub settings: Option<toml::Value>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self::parse("").expect("the default config is valid")
    }
}

impl Config {
    /// The defaults with `user` (TOML) merged over them.
    pub fn parse(user: &str) -> anyhow::Result<Self> {
        let mut base: toml::Table = DEFAULT_CONFIG.parse().expect("the default config is valid TOML");
        let user: toml::Table = user.parse().context("the config isn't valid TOML")?;
        merge(&mut base, user);
        toml::Value::Table(base).try_into().context("the config doesn't match what diffd expects")
    }

    /// Read the config: `path` if given, else `$DIFFD_CONFIG`, else
    /// `~/.config/diffd/config.toml` when it exists, else the defaults.
    pub fn load(path: Option<&Path>) -> anyhow::Result<Self> {
        let explicit = path.map(Path::to_path_buf).or_else(|| std::env::var_os("DIFFD_CONFIG").map(PathBuf::from));
        let file =
            explicit.clone().or_else(|| Some(xdg_dir("XDG_CONFIG_HOME", ".config")?.join("diffd/config.toml")).filter(|p| p.exists()));
        match file {
            Some(file) => {
                let text = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
                Self::parse(&text).with_context(|| format!("in {}", file.display()))
            }
            None => Ok(Self::default()),
        }
    }

    /// The language server for a file, by its extension, with the language id to open it with.
    pub fn server_for(&self, path: &str) -> Option<(&str, &LanguageServer, &str)> {
        let ext = Path::new(path).extension()?.to_str()?;
        self.lsp.servers.iter().filter(|(_, s)| s.enabled).find_map(|(name, s)| {
            s.languages.iter().find(|(_, exts)| exts.iter().any(|e| e == ext)).map(|(id, _)| (name.as_str(), s, id.as_str()))
        })
    }
}

/// Merge `over` into `base`: tables recursively, anything else replaced.
/// An XDG base directory: `$var` when set, else `under_home` in the home directory.
pub fn xdg_dir(var: &str, under_home: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(under_home)))
}

fn merge(base: &mut toml::Table, over: toml::Table) {
    for (key, value) in over {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => merge(b, o),
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_parse_and_cover_the_usual_languages() {
        let c = Config::default();
        assert_eq!(c.server.port, 3433);
        for (file, server, lang) in [
            ("src/lib.rs", "rust-analyzer", "rust"),
            ("web/a.tsx", "typescript", "typescriptreact"),
            ("tool.py", "pyright", "python"),
            ("main.go", "gopls", "go"),
            ("flake.nix", "nil", "nix"),
            (".github/ci.yml", "yaml", "yaml"),
        ] {
            let (name, _, id) = c.server_for(file).unwrap_or_else(|| panic!("no server for {file}"));
            assert_eq!((name, id), (server, lang), "{file}");
        }
        assert!(c.server_for("README.md").is_none());
    }

    #[test]
    fn a_user_config_changes_only_what_it_says() {
        let c = Config::parse(
            r#"
            [server]
            port = 4000
            [lsp.servers.rust-analyzer]
            args = ["--log-file", "/tmp/ra.log"]
            [lsp.servers.pyright]
            enabled = false
            [lsp.servers.lua]
            command = "lua-language-server"
            languages = { lua = ["lua"] }
            "#,
        )
        .unwrap();
        assert_eq!(c.server.port, 4000);
        let ra = &c.lsp.servers["rust-analyzer"];
        assert_eq!((ra.command.as_str(), ra.args.len()), ("rust-analyzer", 2), "merged, not replaced");
        assert!(c.server_for("x.py").is_none(), "disabled");
        assert_eq!(c.server_for("init.lua").unwrap().0, "lua");
    }

    #[test]
    fn mistakes_are_reported() {
        assert!(Config::parse("[lsp]\nenabeld = true").is_err(), "unknown keys");
        assert!(Config::parse("[server]\nport = \"x\"").is_err(), "wrong types");
        assert!(Config::parse("[lsp.servers.x]\nargs = []").is_err(), "a new server needs a command and languages");
    }
}
