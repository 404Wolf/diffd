//! Reading repositories with the `git` CLI, so worktrees, sparse checkouts and
//! config behave exactly as they do in the user's shell.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{Context, bail};
use diffd_core::build::FileInput;
use diffd_core::model::{Commit, FileStatus, Millis};
use diffd_core::text::looks_binary;

use crate::ports::{Repo, RepoSource, Resolved};

/// Files larger than this are listed but not diffed.
const MAX_FILE_BYTES: usize = 3 * 1024 * 1024;

pub struct GitCli;

fn git(root: &Path, args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().context("running git (is it installed?)")?;
    if !out.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

impl RepoSource for GitCli {
    fn open(&self, path: &Path) -> anyhow::Result<Repo> {
        let root =
            git(path, &["rev-parse", "--show-toplevel"]).with_context(|| format!("{} is not inside a git repository", path.display()))?;
        let root = std::path::PathBuf::from(root.trim());
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Repo { root, name })
    }

    fn resolve(&self, repo: &Repo, from: &str, to: Option<&str>, merge_base: Option<bool>) -> anyhow::Result<Resolved> {
        let commit = |rev: &str| -> anyhow::Result<String> {
            git(&repo.root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
                .map(|s| s.trim().to_owned())
                .with_context(|| format!("unknown revision `{rev}`"))
        };
        let to_commit = to.map(commit).transpose()?;
        let is_branch = git(&repo.root, &["rev-parse", "--symbolic-full-name", from])
            .map(|r| r.starts_with("refs/heads/") || r.starts_with("refs/remotes/"))
            .unwrap_or(false);
        let base = if merge_base.unwrap_or(is_branch) {
            let other = to_commit.clone().unwrap_or_else(|| "HEAD".to_owned());
            git(&repo.root, &["merge-base", from, &other])
                .map(|s| s.trim().to_owned())
                .with_context(|| format!("`{from}` and `{other}` have no common history"))?
        } else {
            commit(from)?
        };
        Ok(Resolved { base, to: to_commit })
    }

    fn changes(&self, repo: &Repo, resolved: &Resolved, paths: &[String]) -> anyhow::Result<Vec<FileInput>> {
        let mut args = vec!["diff", "--name-status", "-z", "-M", "--no-ext-diff", resolved.base.as_str()];
        if let Some(to) = &resolved.to {
            args.push(to);
        }
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        let mut entries = parse_name_status(&git(&repo.root, &args)?);

        if resolved.to.is_none() {
            let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
            args.extend(paths.iter().map(String::as_str));
            for path in git(&repo.root, &args)?.split('\0').filter(|p| !p.is_empty()) {
                entries.push(Entry { status: FileStatus::Added, old_path: None, path: path.to_owned() });
            }
        }
        entries.sort_by(|a, b| tree_order(&a.path, &b.path));

        let mut cat = CatFile::spawn(&repo.root)?;
        let mut inputs = Vec::with_capacity(entries.len());
        for e in entries {
            let old_name = e.old_path.as_deref().unwrap_or(&e.path);
            let old = match e.status {
                FileStatus::Added => None,
                _ => cat.read(&format!("{}:{}", resolved.base, old_name))?,
            };
            let new = match (e.status, &resolved.to) {
                (FileStatus::Deleted, _) => None,
                (_, Some(to)) => cat.read(&format!("{to}:{}", e.path))?,
                (_, None) => std::fs::read(repo.root.join(&e.path)).ok(),
            };
            inputs.push(to_input(e, old, new));
        }
        Ok(inputs)
    }

    fn commits(&self, repo: &Repo, resolved: &Resolved, limit: usize) -> anyhow::Result<(Vec<Commit>, bool)> {
        let tip = resolved.to.as_deref().unwrap_or("HEAD");
        let range = format!("{}..{tip}", resolved.base);
        let max = format!("--max-count={}", limit + 1);
        let out = git(&repo.root, &["log", "--first-parent", &max, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e", &range, "--"])?;
        let mut commits: Vec<Commit> = out.split('\x1e').filter_map(parse_commit).collect();
        let truncated = commits.len() > limit;
        commits.truncate(limit);
        commits.reverse();
        Ok((commits, truncated))
    }

    fn files(&self, repo: &Repo, resolved: &Resolved) -> anyhow::Result<Vec<String>> {
        let out = match &resolved.to {
            Some(to) => git(&repo.root, &["ls-tree", "-r", "-z", "--name-only", to])?,
            None => git(&repo.root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?,
        };
        let mut paths: Vec<String> = out.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
        paths.sort_by(|a, b| tree_order(a, b));
        paths.dedup();
        Ok(paths)
    }

    fn read(&self, repo: &Repo, resolved: &Resolved, path: &str) -> anyhow::Result<Option<Vec<u8>>> {
        if !safe_path(path) {
            bail!("`{path}` isn't a path inside the repository");
        }
        match &resolved.to {
            Some(to) => CatFile::spawn(&repo.root)?.read(&format!("{to}:{path}")),
            None => {
                let full = match repo.root.join(path).canonicalize() {
                    Ok(full) => full,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(e.into()),
                };
                // A symlink can point anywhere; only read what's really inside the repository.
                if !full.starts_with(repo.root.canonicalize()?) || !full.is_file() {
                    return Ok(None);
                }
                Ok(Some(std::fs::read(full)?))
            }
        }
    }
}

/// A relative path that stays inside the repository: no `..`, no absolute paths, no `.git`.
fn safe_path(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty() && p.is_relative() && p.components().all(|c| matches!(c, std::path::Component::Normal(n) if n != ".git"))
}

fn parse_commit(record: &str) -> Option<Commit> {
    let mut f = record.trim_start_matches('\n').splitn(5, '\x1f');
    let (sha, short, author, time, subject) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
    if sha.is_empty() {
        return None;
    }
    Some(Commit {
        sha: sha.to_owned(),
        short: short.to_owned(),
        author: author.to_owned(),
        time: time.trim().parse::<Millis>().ok()? * 1000,
        subject: subject.trim_end().to_owned(),
    })
}

/// Order paths the way the file tree shows them: at each level, folders
/// before files, then by name.
fn tree_order(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut pa, mut pb) = (a.split('/').peekable(), b.split('/').peekable());
    loop {
        match (pa.next(), pb.next()) {
            (Some(x), Some(y)) => {
                let (x_dir, y_dir) = (pa.peek().is_some(), pb.peek().is_some());
                if x_dir != y_dir {
                    return y_dir.cmp(&x_dir);
                }
                match x.cmp(y) {
                    std::cmp::Ordering::Equal => continue,
                    other => return other,
                }
            }
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

struct Entry {
    status: FileStatus,
    old_path: Option<String>,
    path: String,
}

fn parse_name_status(out: &str) -> Vec<Entry> {
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut entries = Vec::new();
    while let Some(code) = parts.next() {
        let Some(first) = parts.next() else { break };
        let entry = match code.as_bytes()[0] {
            b'R' | b'C' => {
                let Some(second) = parts.next() else { break };
                let status = if code.starts_with('R') { FileStatus::Renamed } else { FileStatus::Added };
                Entry { status, old_path: Some(first.to_owned()), path: second.to_owned() }
            }
            b'A' => Entry { status: FileStatus::Added, old_path: None, path: first.to_owned() },
            b'D' => Entry { status: FileStatus::Deleted, old_path: None, path: first.to_owned() },
            _ => Entry { status: FileStatus::Modified, old_path: None, path: first.to_owned() },
        };
        entries.push(entry);
    }
    entries
}

fn to_input(e: Entry, old: Option<Vec<u8>>, new: Option<Vec<u8>>) -> FileInput {
    let too_big = [&old, &new].iter().any(|c| c.as_ref().is_some_and(|c| c.len() > MAX_FILE_BYTES));
    let binary = too_big || [&old, &new].iter().any(|c| c.as_ref().is_some_and(|c| looks_binary(c)));
    let text = |c: Option<Vec<u8>>| if binary { c.map(|_| String::new()) } else { c.map(|c| String::from_utf8_lossy(&c).into_owned()) };
    // A copy (C) is reported as added with its source; keep the source as old_path only for renames.
    let old_path = if e.status == FileStatus::Renamed { e.old_path } else { None };
    let status = if e.status == FileStatus::Added && old.is_some() { FileStatus::Modified } else { e.status };
    FileInput {
        path: e.path,
        old_path,
        status,
        old: if status == FileStatus::Added { None } else { text(old) },
        new: text(new),
        binary,
        collapsed: too_big.then(|| "too large to diff".to_owned()),
    }
}

/// A long-running `git cat-file --batch`, so reading N blobs costs one process.
struct CatFile {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl CatFile {
    fn spawn(root: &Path) -> anyhow::Result<Self> {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .context("running git cat-file")?;
        let stdin = child.stdin.take().context("git cat-file stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("git cat-file stdout")?);
        Ok(Self { child, stdin, stdout })
    }

    /// Contents of `rev:path`, or `None` when it doesn't exist.
    fn read(&mut self, object: &str) -> anyhow::Result<Option<Vec<u8>>> {
        writeln!(self.stdin, "{object}")?;
        self.stdin.flush()?;
        let mut header = String::new();
        self.stdout.read_line(&mut header)?;
        let fields: Vec<&str> = header.split_whitespace().collect();
        match fields.as_slice() {
            [_, "missing"] | [_, "ambiguous"] => Ok(None),
            [_, kind, size] => {
                let size: usize = size.parse().context("git cat-file size")?;
                let mut buf = vec![0; size + 1];
                self.stdout.read_exact(&mut buf)?;
                buf.pop();
                Ok((*kind == "blob").then_some(buf))
            }
            _ => bail!("unexpected git cat-file output: {header:?}"),
        }
    }
}

impl Drop for CatFile {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_like_the_tree() {
        let mut paths = vec!["README.md", "src/lib.rs", "Cargo.lock", "src/a/b.rs", "web/x.ts"];
        paths.sort_by(|a, b| tree_order(a, b));
        assert_eq!(paths, vec!["src/a/b.rs", "src/lib.rs", "web/x.ts", "Cargo.lock", "README.md"]);
    }

    #[test]
    fn parses_name_status() {
        let e = parse_name_status("M\0src/a.rs\0R087\0old.rs\0new.rs\0D\0gone.rs\0A\0added.rs\0");
        assert_eq!(e.len(), 4);
        assert_eq!(e[1].status, FileStatus::Renamed);
        assert_eq!(e[1].old_path.as_deref(), Some("old.rs"));
        assert_eq!(e[1].path, "new.rs");
        assert_eq!(e[2].status, FileStatus::Deleted);
        assert_eq!(e[3].status, FileStatus::Added);
    }
}
