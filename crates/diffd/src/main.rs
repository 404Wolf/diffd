//! `diffd`: the local server agents share their changes through.

use std::net::SocketAddr;
use std::path::PathBuf;
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
    /// Register diffd as an MCP server with an agent.
    Setup {
        #[command(subcommand)]
        agent: Agent,
    },
}

#[derive(Subcommand)]
enum Agent {
    /// Claude Code: runs `claude mcp add --transport http --scope user diffd <url>`.
    Claude {
        /// Print the command instead of running it.
        #[arg(long)]
        print: bool,
        #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
        port: u16,
    },
}

#[derive(clap::Args, Clone)]
struct ServeArgs {
    /// Port to listen on (localhost only); overrides the config.
    #[arg(long, env = "DIFFD_PORT")]
    port: Option<u16>,
    /// SQLite database file; overrides the config.
    #[arg(long, env = "DIFFD_DB")]
    db: Option<PathBuf>,
    /// Config file (default: $DIFFD_CONFIG, then ~/.config/diffd/config.toml).
    #[arg(long)]
    config: Option<PathBuf>,
}

fn default_db() -> anyhow::Result<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .context("set HOME or DIFFD_DB")?;
    let dir = base.join("diffd");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir.join("diffd.db"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "diffd=info,diffd_server=info".into()))
        .init();
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Setup { agent: Agent::Claude { print, port } }) => setup_claude(print, port),
        Some(Command::Config) => {
            print!("{DEFAULT_CONFIG}");
            Ok(())
        }
        Some(Command::Serve(args)) => serve(args).await,
        None => serve(cli.serve).await,
    }
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
    let base_url = format!("http://localhost:{port}");
    let app = App::new(store, Arc::new(GitCli), engine, Arc::new(SystemClock), base_url.clone()).await;
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

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("port {port} is taken; is diffd already running? (--port to pick another)"))?;
    tracing::info!(db = %db.display(), "diffd is running at {base_url}  ·  MCP: {base_url}/mcp");
    let shutdown = CancellationToken::new();
    let serve = axum::serve(listener, http::router(app, PAGE, shutdown.clone())).with_graceful_shutdown({
        let shutdown = shutdown.clone();
        async move {
            let _ = tokio::signal::ctrl_c().await;
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

fn setup_claude(print: bool, port: u16) -> anyhow::Result<()> {
    let url = format!("http://localhost:{port}/mcp");
    let args = ["mcp", "add", "--transport", "http", "--scope", "user", "diffd", url.as_str()];
    if print {
        println!("claude {}", args.join(" "));
        return Ok(());
    }
    let status = std::process::Command::new("claude")
        .args(args)
        .status()
        .context("running `claude` (is Claude Code installed? use --print to see the command)")?;
    anyhow::ensure!(status.success(), "`claude mcp add` failed");
    println!("Added diffd to Claude Code. Start the server with `diffd`, then ask Claude to share its changes.");
    Ok(())
}
