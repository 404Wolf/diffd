//! `diffd`: the local server agents share their changes through.

mod hook;
mod install;
mod setup;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::{Parser, Subcommand};
use diffd_server::App;
use diffd_server::adapters::difft::{Difftastic, NoEngine};
use diffd_server::adapters::git::GitCli;
use diffd_server::adapters::http;
use diffd_server::adapters::lsp::LspPool;
use diffd_server::adapters::store::Store;
use diffd_server::adapters::watch::Watcher;
use diffd_server::config::{Config, DEFAULT_CONFIG};
use diffd_server::ports::{DiffEngine, SystemClock};
use tokio_util::sync::CancellationToken;

/// How long a stop waits for open connections after telling them to close.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// The review page, built by `web/` and embedded at compile time.
const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/index.html"));

#[derive(Parser)]
#[command(name = "diffd", version, about = "Live code review of your agent's changes, in your browser")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server (the default).
    Serve(ServeArgs),
    /// Print the default configuration (a documented config.toml to start from).
    Config,
    /// Install diffd for your user (without Nix): the binary in ~/.local/bin, a
    /// service that starts it at login, and plugins for Claude Code and Codex.
    /// Run it again to upgrade.
    Install {
        /// Agents to set up (default: those on your PATH).
        #[arg(long, value_enum, value_delimiter = ',')]
        agents: Option<Vec<hook::Harness>>,
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
        /// Don't start diffd at login.
        #[arg(long)]
        no_service: bool,
        /// Show what it would do, and change nothing.
        #[arg(long)]
        print: bool,
        /// Install even though this diffd comes from Nix (use its modules instead).
        #[arg(long)]
        force: bool,
    },
    /// Undo `diffd install`: the service, the plugins and the binary.
    Uninstall {
        /// Delete your reviews too.
        #[arg(long)]
        purge: bool,
        /// Show what it would do, and change nothing.
        #[arg(long)]
        print: bool,
    },
    /// Add diffd to one agent only (as `install --agents <agent> --no-service`,
    /// keeping this binary where it is).
    Setup {
        #[command(subcommand)]
        agent: Agent,
    },
    /// Write diffd's plugin for an agent into a directory (for packagers).
    #[command(hide = true)]
    Plugin {
        #[arg(value_enum)]
        agent: hook::Harness,
        #[arg(long)]
        out: PathBuf,
        /// The diffd the hooks call (default: this one).
        #[arg(long)]
        program: Option<PathBuf>,
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
        /// Leave the MCP server out (registered elsewhere).
        #[arg(long)]
        no_mcp: bool,
    },
    /// Run by an agent's hooks (see `diffd setup`): wait for your feedback, then wake the agent.
    Hook {
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
        #[command(subcommand)]
        action: HookAction,
    },
}

#[derive(Subcommand)]
enum HookAction {
    /// Claude Code's hook (async, asyncRewake): exits 2 with the feedback notice, which wakes Claude.
    Claude,
    /// Codex's hook (async): queues the feedback notice into the session with `codex queue`.
    Codex,
    /// A SessionEnd hook: stop waiting for that session.
    End {
        #[arg(value_enum)]
        harness: hook::Harness,
    },
    /// For any other agent or script: wait for feedback on reviews of a
    /// directory, then print the notice to stderr and exit 2.
    Wait {
        /// The agent's working directory (default: the current one).
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Names the waiter: a newer wait with the same name replaces this one.
        #[arg(long, default_value = "default")]
        session: String,
        /// Print the notice as JSON on stdout and exit 0 instead.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum Agent {
    /// Claude Code: the diffd plugin (MCP server and wake hooks).
    Claude {
        /// Print what it would do instead of doing it.
        #[arg(long)]
        print: bool,
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
    },
    /// Codex: the diffd plugin (MCP server and wake hooks; trust them once with /hooks).
    Codex {
        /// Print what it would do instead of doing it.
        #[arg(long)]
        print: bool,
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
    },
}

#[derive(clap::Args, Clone)]
struct ServeArgs {
    /// Port to listen on; overrides the config.
    #[arg(long, env = "DIFFD_PORT")]
    port: Option<u16>,
    /// Address to listen on (default 127.0.0.1); overrides the config.
    #[arg(long, env = "DIFFD_BIND")]
    bind: Option<IpAddr>,
    /// Extra host names the review pages answer to, comma-separated; overrides the config.
    #[arg(long, env = "DIFFD_ALLOWED_HOSTS", value_delimiter = ',')]
    allowed_hosts: Option<Vec<String>>,
    /// Base URL for the review links agents hand out; overrides the config.
    #[arg(long, env = "DIFFD_PUBLIC_URL")]
    public_url: Option<String>,
    /// SQLite database file; overrides the config.
    #[arg(long, env = "DIFFD_DB")]
    db: Option<PathBuf>,
    /// Config file (default: $DIFFD_CONFIG, then ~/.config/diffd/config.toml).
    #[arg(long)]
    config: Option<PathBuf>,
}

fn default_db() -> anyhow::Result<PathBuf> {
    use etcetera::BaseStrategy;
    let dir = etcetera::choose_base_strategy().context("set HOME or DIFFD_DB")?.data_dir().join("diffd");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir.join("diffd.db"))
}

#[tokio::main]
async fn main() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();
    // Hooks answer through their exit code and stderr: no logging, no chatter.
    if let Some(Command::Hook { port, action }) = cli.command {
        return match action {
            HookAction::Claude => hook::wait_and_wake(hook::Harness::Claude, port).await,
            HookAction::Codex => hook::wait_and_wake(hook::Harness::Codex, port).await,
            HookAction::End { harness } => hook::end(harness, port).await,
            HookAction::Wait { cwd, session, json } => hook::wait_generic(port, cwd, session, json).await,
        };
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "diffd=info,diffd_server=info".into()))
        .init();
    match cli.command {
        Some(Command::Install { agents, port, no_service, print, force }) => {
            let opts = install::Options { agents, port, service: !no_service, copy_binary: true, force };
            install::execute(&install::plan_install(&install::Dirs::from_env()?, &install::Host::detect()?, &opts)?, print)
        }
        Some(Command::Uninstall { purge, print }) => {
            install::execute(&install::plan_uninstall(&install::Dirs::from_env()?, &install::Host::detect()?, purge)?, print)
        }
        Some(Command::Setup { agent }) => {
            let (harness, print, port) = match agent {
                Agent::Claude { print, port } => (hook::Harness::Claude, print, port),
                Agent::Codex { print, port } => (hook::Harness::Codex, print, port),
            };
            let opts = install::Options { agents: Some(vec![harness]), port, service: false, copy_binary: false, force: false };
            install::execute(&install::plan_install(&install::Dirs::from_env()?, &install::Host::detect()?, &opts)?, print)
        }
        Some(Command::Plugin { agent, out, program, port, no_mcp }) => {
            let program = match program {
                Some(p) => p,
                None => std::env::current_exe()?,
            };
            for (rel, contents) in setup::plugin_files(agent, &program.to_string_lossy(), port, !no_mcp) {
                let path = out.join(rel);
                std::fs::create_dir_all(path.parent().expect("a file in a directory"))?;
                std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
            }
            Ok(())
        }
        Some(Command::Config) => {
            print!("{DEFAULT_CONFIG}");
            Ok(())
        }
        Some(Command::Hook { .. }) => unreachable!("handled above"),
        Some(Command::Serve(args)) => serve(args).await,
        None => serve(cli.serve).await,
    }
    .map(|()| ExitCode::SUCCESS)
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let config = Arc::new(Config::load(args.config.as_deref())?);
    let port = args.port.unwrap_or(config.server.port);
    let db = match (args.db, config.server.db.as_str()) {
        (Some(p), _) => p,
        (None, "") => default_db()?,
        (None, p) => PathBuf::from(p),
    };
    let store = Store::open(&format!("sqlite://{}", db.display())).await.with_context(|| format!("opening {}", db.display()))?;
    let engine: Arc<dyn DiffEngine> = match Difftastic::detect() {
        Some(d) => Arc::new(d),
        None => {
            tracing::warn!("difftastic (`difft`) not found; falling back to line diffs");
            Arc::new(NoEngine)
        }
    };
    let bind: IpAddr = match args.bind {
        Some(ip) => ip,
        None => config.server.bind.parse().with_context(|| format!("server.bind = {:?} isn't an IP address", config.server.bind))?,
    };
    let allowed_hosts = args.allowed_hosts.unwrap_or_else(|| config.server.allowed_hosts.clone());
    let allowed_hosts: Vec<String> = allowed_hosts.into_iter().map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect();
    let local_url = format!("http://localhost:{port}");
    let base_url = match args.public_url.unwrap_or_else(|| config.server.public_url.clone()) {
        u if u.trim().is_empty() => local_url.clone(),
        u => u.trim().trim_end_matches('/').to_string(),
    };
    let app = App::new(store, Arc::new(GitCli), engine, Arc::new(SystemClock), base_url.clone());
    if config.lsp.enabled {
        app.set_code_intel(LspPool::new(config.clone()));
    }
    let watcher = Watcher::install(&app, tokio::runtime::Handle::current());
    app.resume_watches().await?;
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_secs(30));
            loop {
                every.tick().await;
                app.tick();
            }
        });
    }

    let addr = SocketAddr::new(bind, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("can't listen on {addr}; is diffd already running? (--port to pick another)"))?;
    tracing::info!(db = %db.display(), %addr, ?allowed_hosts, "diffd is running at {base_url}  ·  MCP: {local_url}/mcp");
    let shutdown = CancellationToken::new();
    let access = http::Access { allowed_hosts };
    let serve = axum::serve(listener, http::router_with_access(app, PAGE, shutdown.clone(), access)).with_graceful_shutdown({
        let shutdown = shutdown.clone();
        async move {
            stop_signal().await;
            shutdown.cancel();
        }
    });
    tokio::select! {
        served = serve => served?,
        // Everything long-lived was told to close; don't wait forever on a stuck connection.
        () = async { shutdown.cancelled().await; tokio::time::sleep(SHUTDOWN_GRACE).await } => {
            tracing::warn!("stopping with connections still open");
        }
    }
    drop(watcher);
    Ok(())
}

/// Ctrl+C, or SIGTERM from a service manager such as systemd.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
                return;
            }
            Err(e) => tracing::warn!(error = %e, "can't listen for SIGTERM; only Ctrl+C stops diffd"),
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
