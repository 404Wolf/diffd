//! Reading repositories with the `git` CLI, so worktrees, sparse checkouts and
//! config behave exactly as they do in the user's shell.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{Context, bail};
use diffd_core::build::FileInput;
use diffd_core::model::{Commit, FileStatus, Millis, Omitted};
use diffd_core::text::{invisible_changes, looks_binary};

use crate::ports::{Contents, MAX_FILE_BYTES, Repo, RepoSource, Resolved};

pub struct GitCli;

/// git's id for the empty tree: the base of a repository with no commits yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
            if rev == EMPTY_TREE {
                return Ok(EMPTY_TREE.to_owned());
            }
            git(&repo.root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^{{commit}}")])
                .map(|s| s.trim().to_owned())
                .with_context(|| format!("unknown revision `{rev}`"))
        };
        // Before the first commit there's nothing to compare with but the empty tree.
        if from == "HEAD" && to.is_none() && commit("HEAD").is_err() {
            return Ok(Resolved { base: EMPTY_TREE.to_owned(), to: None });
        }
        let to_commit = to.map(commit).transpose()?;
        // Only a branch name compares from where it forked; `HEAD`, tags and commits compare directly.
        let is_branch = ["refs/heads/", "refs/remotes/"].iter().any(|prefix| {
            let full = if from.starts_with(prefix) { from.to_owned() } else { format!("{prefix}{from}") };
            git(&repo.root, &["show-ref", "--verify", "--quiet", &full]).is_ok()
        });
        let base = if merge_base.unwrap_or(is_branch) {
            let other = to_commit.clone().unwrap_or_else(|| "HEAD".to_owned());
            git(&repo.root, &["merge-base", "--end-of-options", from, &other])
                .map(|s| s.trim().to_owned())
                .with_context(|| format!("`{from}` and `{other}` have no common history"))?
        } else {
            commit(from)?
        };
        Ok(Resolved { base, to: to_commit })
    }

    fn changes(&self, repo: &Repo, resolved: &Resolved, paths: &[String]) -> anyhow::Result<Vec<FileInput>> {
        // --raw gives each side's blob id, so contents are read by id: paths
        // (which can hold spaces or even newlines) never go through cat-file.
        let mut args = vec!["diff", "--raw", "--no-abbrev", "-z", "-M", "--no-ext-diff", resolved.base.as_str()];
        if let Some(to) = &resolved.to {
            args.push(to);
        }
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        let mut entries = parse_raw(&git(&repo.root, &args)?);

        if resolved.to.is_none() {
            let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
            args.extend(paths.iter().map(String::as_str));
            for path in git(&repo.root, &args)?.split('\0').filter(|p| !p.is_empty()) {
                entries.push(Entry { path: path.to_owned(), ..Entry::added() });
            }
        }
        entries.sort_by(|a, b| tree_order(&a.path, &b.path));

        let mut cat = CatFile::spawn(&repo.root)?;
        let mut inputs = Vec::with_capacity(entries.len());
        for e in entries {
            let old = match &e.old_blob {
                Some(id) => cat.read_blob(id)?,
                None => Content::Missing,
            };
            let new = match (&resolved.to, &e.new_blob) {
                (Some(_), Some(id)) => cat.read_blob(id)?,
                (Some(_), None) => Content::Missing,
                // The working tree: read the file itself (for a deleted file, nothing). The id
                // git prints for it can be a hash of its contents that was never stored.
                (None, _) if e.status == FileStatus::Deleted || e.submodule => Content::Missing,
                (None, _) => read_worktree(&repo.root.join(&e.path))?,
            };
            inputs.push(to_input(e, old, new));
        }
        Ok(inputs)
    }

    fn commits(&self, repo: &Repo, resolved: &Resolved, limit: usize) -> anyhow::Result<(Vec<Commit>, bool)> {
        let tip = resolved.to.as_deref().unwrap_or("HEAD");
        if git(&repo.root, &["rev-parse", "--verify", "--quiet", tip]).is_err() {
            return Ok((Vec::new(), false));
        }
        // From the empty tree, every commit counts.
        let range = if resolved.base == EMPTY_TREE { tip.to_owned() } else { format!("{}..{tip}", resolved.base) };
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

    fn read(&self, repo: &Repo, resolved: &Resolved, path: &str) -> anyhow::Result<Option<Contents>> {
        if !safe_path(path) {
            bail!("`{path}` isn't a path inside the repository");
        }
        match &resolved.to {
            Some(to) => {
                // Look the blob up by path with ls-tree (-z: any path is fine), then read it by id.
                let out = git(&repo.root, &["ls-tree", "-z", to, "--", path])?;
                let Some(id) = out.split('\0').next().and_then(|rec| rec.split('\t').next()?.split(' ').nth(2)) else {
                    return Ok(None);
                };
                Ok(CatFile::spawn(&repo.root)?.read_blob(id)?.into())
            }
            None => {
                let full = match repo.root.join(path).canonicalize() {
                    Ok(full) => full,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(e.into()),
                };
                // A symlink can point anywhere; only read what's really inside the repository.
                if !full.starts_with(repo.root.canonicalize()?) {
                    return Ok(None);
                }
                Ok(read_worktree(&full)?.into())
            }
        }
    }
}

/// A relative path that stays inside the repository: no `..`, no absolute paths, no `.git`.
fn safe_path(path: &str) -> bool {
    let p = Path::new(path);
    // `.git` in any case: on case-insensitive filesystems `.GIT` is the same folder.
    !path.is_empty()
        && p.is_relative()
        && p.components().all(|c| matches!(c, std::path::Component::Normal(n) if !n.eq_ignore_ascii_case(".git")))
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
    /// Blob ids; `None` when that side doesn't exist (or, sometimes, is the working tree).
    old_blob: Option<String>,
    new_blob: Option<String>,
    /// What the rows can't show: mode changes, a submodule's commits.
    details: Vec<String>,
    submodule: bool,
}

impl Entry {
    /// An untracked file.
    fn added() -> Self {
        Self {
            status: FileStatus::Added,
            old_path: None,
            path: String::new(),
            old_blob: None,
            new_blob: None,
            details: Vec::new(),
            submodule: false,
        }
    }
}

const SUBMODULE: &str = "160000";
const SYMLINK: &str = "120000";
const ABSENT: &str = "000000";

/// A mode change, in words: "mode 100644 → 100755", or "symlink → file".
fn mode_change(old: &str, new: &str) -> Option<String> {
    let kind = |m: &str| match m {
        SYMLINK => "symlink",
        SUBMODULE => "submodule",
        _ => "file",
    };
    if old == new || old == ABSENT || new == ABSENT {
        None
    } else if kind(old) != kind(new) {
        Some(format!("{} → {}", kind(old), kind(new)))
    } else {
        Some(format!("mode {old} → {new}"))
    }
}

/// A submodule's commits, in words.
fn submodule_change(old: Option<&str>, new: Option<&str>) -> String {
    let short = |id: &str| id.chars().take(10).collect::<String>();
    match (old, new) {
        (Some(a), Some(b)) => format!("submodule {} → {}", short(a), short(b)),
        (None, Some(b)) => format!("submodule at {}", short(b)),
        (Some(a), None) => format!("submodule was at {}", short(a)),
        (None, None) => "submodule changed".to_owned(),
    }
}

/// Parse `git diff --raw -z --no-abbrev`: `:mode mode id id status\0path\0[path\0]`.
fn parse_raw(out: &str) -> Vec<Entry> {
    let mut parts = out.split('\0');
    let mut entries = Vec::new();
    while let Some(meta) = parts.next() {
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let fields: Vec<&str> = meta.split(' ').collect();
        let [old_mode, new_mode, old_id, new_id, code] = fields.as_slice() else { continue };
        let Some(first) = parts.next() else { break };
        // All zeros: that side doesn't exist, or it's the working tree.
        let blob = |id: &str| (!id.bytes().all(|b| b == b'0')).then(|| id.to_owned());
        let (old_blob, new_blob) = (blob(old_id), blob(new_id));
        // A submodule is a commit, not a blob: it has no contents to show.
        let submodule = *old_mode == SUBMODULE || *new_mode == SUBMODULE;
        let mut details: Vec<String> = mode_change(old_mode, new_mode).into_iter().collect();
        if submodule {
            let side = |mode: &str, id: &Option<String>| if mode == SUBMODULE { id.clone() } else { None };
            details.push(submodule_change(side(old_mode, &old_blob).as_deref(), side(new_mode, &new_blob).as_deref()));
        }
        let (status, old_path, path) = match code.as_bytes().first() {
            Some(b'R' | b'C') => {
                let Some(second) = parts.next() else { break };
                let status = if code.starts_with('R') { FileStatus::Renamed } else { FileStatus::Added };
                (status, Some(first.to_owned()), second.to_owned())
            }
            Some(b'A') => (FileStatus::Added, None, first.to_owned()),
            Some(b'D') => (FileStatus::Deleted, None, first.to_owned()),
            _ => (FileStatus::Modified, None, first.to_owned()),
        };
        let (old_blob, new_blob) = if submodule { (None, None) } else { (old_blob, new_blob) };
        entries.push(Entry { status, old_path, path, old_blob, new_blob, details, submodule });
    }
    entries
}

/// One side's contents, read without ever holding more than [`MAX_FILE_BYTES`].
enum Content {
    Missing,
    TooBig,
    Bytes(Vec<u8>),
}

/// A file in the working tree, as git sees it: a symlink is its target's path
/// (never followed out of the repository), a directory (a submodule) has no contents.
fn read_worktree(path: &Path) -> anyhow::Result<Content> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        // Deleted since git listed it: nothing to show.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Missing),
        Err(e) => return Err(anyhow::Error::new(e).context(format!("reading {}", path.display()))),
    };
    if meta.is_symlink() {
        let target = std::fs::read_link(path)?;
        return Ok(Content::Bytes(target.to_string_lossy().into_owned().into_bytes()));
    }
    if !meta.is_file() {
        return Ok(Content::Missing);
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(Content::TooBig);
    }
    match std::fs::read(path) {
        Ok(bytes) => Ok(Content::Bytes(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Content::Missing),
        Err(e) => Err(anyhow::Error::new(e).context(format!("reading {}", path.display()))),
    }
}

impl From<Content> for Option<Contents> {
    fn from(c: Content) -> Self {
        match c {
            Content::Missing => None,
            Content::TooBig => Some(Contents::TooLarge),
            Content::Bytes(b) => Some(Contents::Bytes(b)),
        }
    }
}

fn to_input(e: Entry, old: Content, new: Content) -> FileInput {
    let too_large = matches!(old, Content::TooBig) || matches!(new, Content::TooBig);
    let bytes = |c: Content| match c {
        Content::Bytes(b) => Some(b),
        // Too large: the side exists, but its contents aren't read.
        Content::TooBig => Some(Vec::new()),
        Content::Missing => None,
    };
    let (old, new) = (bytes(old), bytes(new));
    let omitted = if e.submodule {
        Some(Omitted::Submodule)
    } else if too_large {
        Some(Omitted::TooLarge)
    } else if [&old, &new].iter().any(|c| c.as_ref().is_some_and(|c| looks_binary(c))) {
        Some(Omitted::Binary)
    } else {
        None
    };
    let mut details = e.details;
    if omitted.is_none()
        && let (Some(a), Some(b)) = (&old, &new)
    {
        details.extend(invisible_changes(a, b));
    }
    let text = |c: Option<Vec<u8>>| {
        if omitted.is_some() { c.map(|_| String::new()) } else { c.map(|c| String::from_utf8_lossy(&c).into_owned()) }
    };
    // A copy (C) is reported as added with its source; keep the source as old_path only for renames.
    let old_path = if e.status == FileStatus::Renamed { e.old_path } else { None };
    let status = if e.status == FileStatus::Added && old.is_some() { FileStatus::Modified } else { e.status };
    FileInput {
        path: e.path,
        old_path,
        status,
        old: if status == FileStatus::Added { None } else { text(old) },
        new: text(new),
        omitted,
        details,
        collapsed: None,
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

    /// A blob by id (hex, so no quoting issues). Blobs over [`MAX_FILE_BYTES`]
    /// are skipped over in the stream, never held in memory.
    fn read_blob(&mut self, id: &str) -> anyhow::Result<Content> {
        writeln!(self.stdin, "{id}")?;
        self.stdin.flush()?;
        let mut header = String::new();
        self.stdout.read_line(&mut header)?;
        let fields: Vec<&str> = header.split_whitespace().collect();
        match fields.as_slice() {
            [_, "missing"] | [_, "ambiguous"] => Ok(Content::Missing),
            [_, kind, size] => {
                let size: u64 = size.parse().context("git cat-file size")?;
                // The object, then a newline.
                if size > MAX_FILE_BYTES || *kind != "blob" {
                    std::io::copy(&mut (&mut self.stdout).take(size + 1), &mut std::io::sink())?;
                    return Ok(if *kind == "blob" { Content::TooBig } else { Content::Missing });
                }
                let mut buf = vec![0; size as usize + 1];
                self.stdout.read_exact(&mut buf)?;
                buf.pop();
                Ok(Content::Bytes(buf))
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
    fn parses_raw_diffs() {
        let (a, b, z) = ("a".repeat(40), "b".repeat(40), "0".repeat(40));
        let out = format!(
            ":100644 100644 {a} {b} M\0src/a b.rs\0:100644 100644 {a} {b} R087\0old.rs\0new\nline.rs\0\
             :100644 000000 {a} {z} D\0gone.rs\0:000000 100644 {z} {z} A\0added.rs\0:160000 160000 {a} {b} M\0sub\0"
        );
        let e = parse_raw(&out);
        assert_eq!(e.len(), 5);
        assert_eq!(
            (e[0].path.as_str(), e[0].old_blob.as_deref(), e[0].new_blob.as_deref()),
            ("src/a b.rs", Some(a.as_str()), Some(b.as_str()))
        );
        assert_eq!(e[1].status, FileStatus::Renamed);
        assert_eq!((e[1].old_path.as_deref(), e[1].path.as_str()), (Some("old.rs"), "new\nline.rs"));
        assert_eq!((e[2].status, e[2].new_blob.as_deref()), (FileStatus::Deleted, None));
        assert_eq!((e[3].status, e[3].new_blob.as_deref()), (FileStatus::Added, None), "the working tree side");
        assert_eq!(e[4].new_blob, None, "submodules have no contents");
    }
}
