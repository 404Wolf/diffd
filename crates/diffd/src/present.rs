//! `diffd present FILE…`: put files on your Showing board from a shell, and
//! print their links. The running diffd reads and checks each file (the
//! same way as the agents' `present` tool) over its loopback-only
//! `/api/present`; this only says which file, and who's asking.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use diffd_server::app::{PresentRequest, PresentResult};

#[derive(clap::Args)]
pub struct Args {
    /// The files to show: Markdown (rendered, with its images), code, images or text.
    #[arg(required = true)]
    files: Vec<PathBuf>,
    /// The item's title (one file only; default: its first heading, else its name).
    #[arg(long)]
    title: Option<String>,
    /// One short line shown with each item.
    #[arg(long)]
    message: Option<String>,
    /// For code: the lines to light up and scroll to, e.g. 41-60 (one file only).
    #[arg(long, value_parser = parse_lines)]
    lines: Option<[u32; 2]>,
    /// The board (default: yours). A project manager or the deacon may pass `deacon`.
    #[arg(long)]
    scope: Option<String>,
    /// Add a second item instead of updating the one already showing the file.
    #[arg(long)]
    new: bool,
    /// Print what diffd answered, as JSON lines, instead of the links.
    #[arg(long)]
    json: bool,
    #[arg(long, env = "DIFFD_PORT", default_value_t = 3433)]
    port: u16,
}

/// `41-60`, or `41` for one line.
fn parse_lines(s: &str) -> Result<[u32; 2], String> {
    let parse = |n: &str| n.trim().parse::<u32>().ok().filter(|n| *n > 0);
    let lines = match s.split_once('-') {
        Some((first, last)) => parse(first).zip(parse(last)).map(|(a, b)| [a, b]),
        None => parse(s).map(|n| [n, n]),
    };
    lines.filter(|[a, b]| a <= b).ok_or_else(|| format!("`{s}` isn't a line range like 41-60"))
}

pub async fn run(args: Args) -> anyhow::Result<ExitCode> {
    if args.files.len() > 1 && (args.title.is_some() || args.lines.is_some()) {
        anyhow::bail!("--title and --lines are for one file at a time");
    }
    let cwd = std::env::current_dir().context("finding the current directory")?;
    // Herdr names the caller's terminal; diffd reads its labels to pick the board.
    let terminal = std::env::var("HC_TERMINAL_ID").ok().filter(|t| !t.trim().is_empty());
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/api/present", args.port);
    let mut failed = false;
    for file in &args.files {
        let request = PresentRequest {
            file: file.to_string_lossy().into_owned(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            title: args.title.clone(),
            message: args.message.clone(),
            lines: args.lines,
            scope: args.scope.clone(),
            new: args.new,
        };
        let mut post = client.post(&url).json(&request);
        if let Some(terminal) = &terminal {
            post = post.header("x-herdr-terminal", terminal);
        }
        let response = match post.send().await {
            Ok(r) => r,
            Err(e) if e.is_connect() => anyhow::bail!("diffd isn't running on port {} (start it, or pass --port)", args.port),
            Err(e) => return Err(e).context("asking diffd to present the file"),
        };
        let status = response.status();
        if !status.is_success() {
            let reason = response.text().await.unwrap_or_default();
            eprintln!("diffd present: {}: {}", file.display(), reason.trim());
            failed = true;
            continue;
        }
        let result: PresentResult = response.json().await.context("reading diffd's answer")?;
        if args.json {
            println!("{}", serde_json::to_string(&result)?);
        } else {
            println!("{}", result.url);
            for skipped in &result.skipped {
                eprintln!("diffd present: {}: left out {}: {}", file.display(), skipped.path, skipped.reason);
            }
        }
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::parse_lines;

    #[test]
    fn line_ranges() {
        assert_eq!(parse_lines("41-60"), Ok([41, 60]));
        assert_eq!(parse_lines(" 7 "), Ok([7, 7]));
        for bad in ["0", "60-41", "a-b", "", "1-", "-3"] {
            assert!(parse_lines(bad).is_err(), "{bad}");
        }
    }
}
