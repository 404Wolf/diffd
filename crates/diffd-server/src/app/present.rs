//! Showing boards: files an agent puts in front of the user (`present`).
//!
//! An item is a snapshot of the file, plus the local images a Markdown
//! document shows, taken when it's presented. It stays readable after the
//! checkout, the agent or its machine goes away. Presenting the same file
//! again updates its item rather than adding another.
//!
//! Only files the [`PresentPolicy`] allows are read: under a configured root,
//! or in a git work tree and not ignored by git, and never one that looks
//! private (keys, `.env`, …). Paths are resolved to real paths first, so a
//! symlink or `..` can't lead around the check. The pages only ever serve
//! stored snapshots, by item id: nothing a browser sends names a file.

use std::path::{Path, PathBuf};

use anyhow::anyhow;
use diffd_core::lang::Lang;
use diffd_core::model::{BoardItem, BoardItemContent, BoardItemId, BoardItemKind, BoardItemSource, BoardItemState};
use diffd_core::text::looks_binary;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{App, AppError, Result, new_id};
use crate::adapters::store::BoardAsset;
use crate::ports::RepoSource;

/// A Markdown, code or text file larger than this isn't shown: it wouldn't be read on a phone either.
pub const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
/// Each image, presented or shown by a document.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Everything one item stores: the file and its images.
pub const MAX_BUNDLE_BYTES: u64 = 25 * 1024 * 1024;
/// Images bundled with one document at most.
pub const MAX_ASSETS: usize = 50;
/// Code and text are shown up to this many lines; the page says how many there were.
pub const MAX_SHOWN_LINES: usize = 5000;

/// Files never shown, whatever the roots say. Patterns match anywhere in the
/// real path unless they start with `/`: `*.pem` is any `.pem` file, and
/// `secrets/**` anything under any `secrets` directory.
pub const DEFAULT_DENY: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "*.jks",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "*.sops.*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "**/.ssh/**",
    "**/.gnupg/**",
    "**/.git/**",
    "**/.aws/**",
    "**/.kube/**",
    "**/.docker/**",
    "**/secrets/**",
];

/// Which files `present` may read.
#[derive(Debug, Clone)]
pub struct PresentPolicy {
    /// Real paths of directories whose files may be shown, git or not.
    roots: Vec<PathBuf>,
    deny: GlobSet,
}

impl PresentPolicy {
    /// `roots` are directories whose files may be shown even outside git, or
    /// ignored by it (`~/` is the home directory; missing ones are skipped, so
    /// one config can serve several machines). `deny` adds globs to
    /// [`DEFAULT_DENY`].
    pub fn new(roots: &[String], deny: &[String]) -> anyhow::Result<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let roots = roots
            .iter()
            .map(|root| root.trim())
            .filter(|root| !root.is_empty())
            .filter_map(|root| {
                let path = match (root, &home) {
                    ("~", Some(home)) => home.clone(),
                    (r, Some(home)) if r.starts_with("~/") => home.join(&r[2..]),
                    (r, _) => PathBuf::from(r),
                };
                path.canonicalize().ok()
            })
            .collect();
        let mut builder = GlobSetBuilder::new();
        for pattern in DEFAULT_DENY.iter().copied().chain(deny.iter().map(String::as_str)) {
            let pattern = pattern.trim();
            if pattern.is_empty() {
                continue;
            }
            // Patterns match real (absolute) paths: anything not anchored at `/` or `**` may sit anywhere.
            let full = if pattern.starts_with('/') || pattern.starts_with("**") { pattern.to_owned() } else { format!("**/{pattern}") };
            let glob = GlobBuilder::new(&full).literal_separator(true).build().map_err(|e| anyhow!("bad deny pattern `{pattern}`: {e}"))?;
            builder.add(glob);
        }
        Ok(Self { roots, deny: builder.build()? })
    }

    fn denied(&self, path: &Path) -> bool {
        self.deny.is_match(path)
    }

    fn under_root(&self, path: &Path) -> bool {
        self.roots.iter().any(|root| path.starts_with(root))
    }
}

impl Default for PresentPolicy {
    fn default() -> Self {
        Self::new(&[], &[]).expect("the default deny patterns are valid")
    }
}

/// Who is presenting, as the transport found out (its headers, Herdr labels).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Caller {
    pub terminal: Option<String>,
    pub agent: Option<String>,
    /// The Herdr machine (core) name.
    pub machine: Option<String>,
    /// The terminal's `role` label: `deacon`, `pm`, `worker`.
    pub role: Option<String>,
    /// The terminal's `project` label.
    pub project: Option<String>,
}

/// What the agent (MCP `present`) or a shell (`diffd present`) asks to show.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PresentRequest {
    /// The file to show: absolute, or relative to `cwd`. Markdown is rendered with the images it shows, code is
    /// highlighted, images are shown, and other text is shown as it is.
    pub file: String,
    /// The directory a relative `file` is in (normally your working directory).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Default: the document's first heading, else the file's name.
    #[serde(default)]
    pub title: Option<String>,
    /// One short line shown with the item, e.g. "the plan for item 31; needs your OK".
    #[serde(default)]
    pub message: Option<String>,
    /// For code: the first and last line (1-based) to light up and scroll to.
    #[serde(default)]
    pub lines: Option<[u32; 2]>,
    /// The board. Leave it out for your own: your project's, or the deacon's for the deacon. A project manager or
    /// the deacon may pass "deacon" to put it on the deacon's board.
    #[serde(default)]
    pub scope: Option<String>,
    /// Add a second item instead of updating the one already showing this file.
    #[serde(default)]
    pub new: bool,
}

/// An image a document names that wasn't included, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PresentResult {
    pub id: String,
    /// The item, opened on its board: give the user this link.
    pub url: String,
    /// The whole board.
    pub board: String,
    pub scope: String,
    pub title: String,
    pub kind: BoardItemKind,
    /// 1 for a new item; more when this replaced an earlier presentation of the same file.
    pub revision: u32,
    pub replaced: bool,
    /// Images the document names that weren't included, and why.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<Skipped>,
}

/// A file read for presenting, with what was learned about it.
struct Capture {
    path: PathBuf,
    kind: BoardItemKind,
    language: Option<String>,
    /// A Markdown document's first heading.
    heading: Option<String>,
    main: BoardAsset,
    images: Vec<BoardAsset>,
    skipped: Vec<Skipped>,
    /// The git repository the file is in, if any.
    repo_name: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn no_item(id: &BoardItemId) -> AppError {
    AppError::NotFound(format!("no board item with id `{id}`"))
}

impl App {
    /// Use `policy` for which files `present` may read (the default allows git work trees only).
    pub fn set_present_policy(&self, policy: PresentPolicy) {
        *self.present.lock().expect("present lock") = std::sync::Arc::new(policy);
    }

    fn present_policy(&self) -> std::sync::Arc<PresentPolicy> {
        self.present.lock().expect("present lock").clone()
    }

    /// The link to a board, or to one item opened on it.
    pub fn board_url(&self, scope: &str, item: Option<&BoardItemId>) -> String {
        match item {
            Some(id) => format!("{}/show/{scope}/{id}", self.base_url),
            None => format!("{}/show/{scope}", self.base_url),
        }
    }

    /// `item` with its link filled in.
    fn linked(&self, mut item: BoardItem) -> BoardItem {
        item.url = self.board_url(&item.scope, Some(&item.id));
        item
    }

    /// Put a file on a board: read it (if the policy allows), snapshot it with
    /// its images, and save it as a new item or the next revision of the item
    /// already showing it.
    pub async fn present_file(&self, req: PresentRequest, caller: Caller) -> Result<PresentResult> {
        let policy = self.present_policy();
        let repo = self.repo.clone();
        let request = req.clone();
        // git and the disk can be slow: off the async threads.
        let capture = tokio::task::spawn_blocking(move || capture(&request, &policy, repo.as_ref()))
            .await
            .map_err(|e| AppError::Internal(anyhow!("reading the file to present: {e}")))??;
        let scope = scope_for(req.scope.as_deref(), &caller, capture.repo_name.as_deref())?;
        let lines = match req.lines {
            Some([first, last]) if first == 0 || last < first => {
                return Err(invalid("`lines` are the first and last line, 1-based, e.g. [41, 60]"));
            }
            lines if matches!(capture.kind, BoardItemKind::Code | BoardItemKind::Text) => lines,
            _ => None,
        };
        let id = BoardItemId(new_id("s"));
        let mut key = format!("{}:{}", caller.machine.as_deref().unwrap_or("local"), capture.path.display());
        if req.new {
            key.push('#');
            key.push_str(&id.0);
        }
        let file_name = capture.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let title = clean(req.title.as_deref(), 200).or(capture.heading).unwrap_or(file_name);
        let now = self.now();
        let item = BoardItem {
            id,
            scope,
            url: String::new(),
            kind: capture.kind,
            title,
            message: clean(req.message.as_deref(), 300),
            lines,
            language: capture.language,
            source: BoardItemSource {
                path: capture.path.display().to_string(),
                machine: caller.machine,
                terminal: caller.terminal,
                agent: caller.agent,
                role: caller.role,
                project: caller.project,
            },
            revision: 1,
            state: BoardItemState::Open,
            seen_revision: 0,
            assets: capture.images.iter().map(|a| a.name.clone()).collect(),
            created_at: now,
            updated_at: now,
        };
        let mut assets = Vec::with_capacity(capture.images.len() + 1);
        assets.push(capture.main);
        assets.extend(capture.images);
        let (saved, replaced) = self.store.present_item(&item, &key, &assets).await?;
        Ok(PresentResult {
            url: self.board_url(&saved.scope, Some(&saved.id)),
            board: self.board_url(&saved.scope, None),
            id: saved.id.0,
            scope: saved.scope,
            title: saved.title,
            kind: saved.kind,
            revision: saved.revision,
            replaced,
            skipped: capture.skipped,
        })
    }

    /// A board's items, or every board's.
    pub async fn board(&self, scope: Option<&str>) -> Result<Vec<BoardItem>> {
        Ok(self.store.board_items(scope).await?.into_iter().map(|item| self.linked(item)).collect())
    }

    /// An item with what it shows: the text (cut at [`MAX_SHOWN_LINES`] for
    /// code and text), highlighted when it's code.
    pub async fn board_item(&self, id: &BoardItemId) -> Result<BoardItemContent> {
        let item = self.linked(self.store.board_item(id).await?.ok_or_else(|| no_item(id))?);
        if item.kind == BoardItemKind::Image {
            return Ok(BoardItemContent { item, text: None, syntax: Vec::new(), total_lines: None });
        }
        let main = self.store.board_asset(id, "").await?.ok_or_else(|| AppError::Internal(anyhow!("board item {id} has no content")))?;
        let mut text = String::from_utf8(main.bytes).map_err(|e| AppError::Internal(anyhow!("board item {id} isn't text: {e}")))?;
        let mut total_lines = None;
        if item.kind != BoardItemKind::Markdown {
            let count = text.split('\n').count();
            if count > MAX_SHOWN_LINES {
                let cut = text.match_indices('\n').nth(MAX_SHOWN_LINES - 1).map_or(text.len(), |(i, _)| i);
                text.truncate(cut);
                total_lines = Some(u32::try_from(count).unwrap_or(u32::MAX));
            }
        }
        let lang = (item.kind == BoardItemKind::Code).then(|| Lang::from_path(&item.source.path)).flatten();
        let syntax = match lang {
            Some(lang) => {
                let source = text.clone();
                tokio::task::spawn_blocking(move || {
                    let count = source.split('\n').count();
                    diffd_core::highlight::highlight(lang, &source, count)
                })
                .await
                .unwrap_or_default()
            }
            None => Vec::new(),
        };
        Ok(BoardItemContent { item, text: Some(text), syntax, total_lines })
    }

    /// An image item's picture (`name` `""`), or an image its document shows.
    pub async fn board_asset(&self, id: &BoardItemId, name: &str) -> Result<BoardAsset> {
        let item = self.store.board_item(id).await?.ok_or_else(|| no_item(id))?;
        let allowed = if name.is_empty() { item.kind == BoardItemKind::Image } else { item.assets.iter().any(|a| a == name) };
        if !allowed {
            return Err(AppError::NotFound(format!("board item `{id}` has no image `{name}`")));
        }
        self.store.board_asset(id, name).await?.ok_or_else(|| AppError::NotFound(format!("board item `{id}` has no image `{name}`")))
    }

    /// Open, minimise or hide an item, and/or note which revision the user saw.
    pub async fn set_board_item_state(&self, id: &BoardItemId, state: Option<BoardItemState>, seen: Option<u32>) -> Result<BoardItem> {
        let item = self.store.set_board_item_state(id, state, seen).await?.ok_or_else(|| no_item(id))?;
        Ok(self.linked(item))
    }
}

/// Trimmed, on one line, and at most `max` characters; `None` when empty.
fn clean(text: Option<&str>, max: usize) -> Option<String> {
    let one_line = text?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one_line.is_empty()).then(|| one_line.chars().take(max).collect())
}

/// Read and check the file a request names.
fn capture(req: &PresentRequest, policy: &PresentPolicy, repo: &dyn RepoSource) -> Result<Capture> {
    let file = req.file.trim();
    if file.is_empty() {
        return Err(invalid("`file` is empty: pass the path of the file to show"));
    }
    let given = Path::new(file);
    let joined = if given.is_absolute() {
        given.to_path_buf()
    } else {
        let cwd = req.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()).ok_or_else(|| {
            invalid(format!("`{file}` is a relative path: pass `cwd` (your working directory), or an absolute path"))
        })?;
        if !Path::new(cwd).is_absolute() {
            return Err(invalid("`cwd` must be an absolute path"));
        }
        Path::new(cwd).join(given)
    };
    let path = joined.canonicalize().map_err(|e| invalid(format!("can't open {}: {e}", joined.display())))?;
    let meta = std::fs::metadata(&path).map_err(|e| invalid(format!("can't open {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(invalid(format!("{} isn't a file", path.display())));
    }
    allowed(&path, policy, repo).map_err(AppError::Invalid)?;
    let repo_name = path.parent().and_then(|dir| repo.open(dir).ok()).map(|r| r.name).filter(|n| !n.is_empty());

    if let Some(mime) = image_mime(&path) {
        check_size(&path, meta.len(), MAX_IMAGE_BYTES)?;
        let bytes = std::fs::read(&path).map_err(|e| invalid(format!("can't read {}: {e}", path.display())))?;
        if !looks_like(mime, &bytes) {
            return Err(invalid(format!("{} doesn't look like the {mime} image its name says", path.display())));
        }
        return Ok(Capture {
            path,
            kind: BoardItemKind::Image,
            language: None,
            heading: None,
            main: BoardAsset { name: String::new(), mime: mime.to_owned(), bytes },
            images: Vec::new(),
            skipped: Vec::new(),
            repo_name,
        });
    }

    check_size(&path, meta.len(), MAX_DOCUMENT_BYTES)?;
    let bytes = std::fs::read(&path).map_err(|e| invalid(format!("can't read {}: {e}", path.display())))?;
    if looks_binary(&bytes) {
        return Err(invalid(format!("{} is a binary file: diffd shows Markdown, code, text and images", path.display())));
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid(format!("{} isn't UTF-8 text", path.display())))?;
    let path_str = path.to_string_lossy();
    let (kind, language) = match Lang::from_path(&path_str) {
        Some(Lang::Markdown | Lang::MarkdownInline) => (BoardItemKind::Markdown, None),
        Some(lang) => (BoardItemKind::Code, Some(lang.display_name().to_owned())),
        None if is_diff(&path) => (BoardItemKind::Code, Some("Diff".to_owned())),
        None => (BoardItemKind::Text, None),
    };
    let (heading, images, skipped) = if kind == BoardItemKind::Markdown {
        let dir = path.parent().unwrap_or(Path::new("/"));
        let (images, skipped) = bundle_images(&text, dir, policy, repo, text.len() as u64);
        (first_heading(&text), images, skipped)
    } else {
        (None, Vec::new(), Vec::new())
    };
    let mime = if kind == BoardItemKind::Markdown { "text/markdown; charset=utf-8" } else { "text/plain; charset=utf-8" };
    Ok(Capture {
        path,
        kind,
        language,
        heading,
        main: BoardAsset { name: String::new(), mime: mime.to_owned(), bytes: text.into_bytes() },
        images,
        skipped,
        repo_name,
    })
}

fn check_size(path: &Path, size: u64, max: u64) -> Result<()> {
    if size > max {
        return Err(invalid(format!("{} is {}, more than the {} a board item can show", path.display(), mib(size), mib(max))));
    }
    Ok(())
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// Why `path` (a real path) may not be shown, if it may not.
fn allowed(path: &Path, policy: &PresentPolicy, repo: &dyn RepoSource) -> std::result::Result<(), String> {
    if policy.denied(path) {
        return Err(format!("{} looks private (it matches a deny pattern), so diffd won't show it", path.display()));
    }
    if policy.under_root(path) {
        return Ok(());
    }
    let dir = path.parent().unwrap_or(path);
    match repo.open(dir) {
        Ok(r) => match repo.ignored(&r, path) {
            Ok(false) => Ok(()),
            Ok(true) => Err(format!(
                "{} is ignored by git; diffd only shows ignored files under a `[present] roots` directory",
                path.display()
            )),
            Err(e) => Err(format!("couldn't ask git about {}: {e:#}", path.display())),
        },
        Err(_) => Err(format!(
            "{} is outside every git repository and every `[present] roots` directory, so diffd won't show it; \
             add its directory to `roots` under `[present]` in diffd's config to allow it",
            path.display()
        )),
    }
}

/// The image types a board shows, by file name.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Whether `bytes` start the way an image of `mime` does, so a file can't pass for one by its name.
fn looks_like(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/svg+xml" => std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg")),
        _ => false,
    }
}

fn is_diff(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("diff") || e.eq_ignore_ascii_case("patch"))
}

/// The local images a document shows, read and checked like the document;
/// the rest are listed with the reason. `used` is what the bundle holds already.
fn bundle_images(
    text: &str,
    dir: &Path,
    policy: &PresentPolicy,
    repo: &dyn RepoSource,
    mut used: u64,
) -> (Vec<BoardAsset>, Vec<Skipped>) {
    let mut images = Vec::new();
    let mut skipped = Vec::new();
    for target in image_targets(text) {
        let skip = |reason: String| Skipped { path: target.clone(), reason };
        if images.len() >= MAX_ASSETS {
            skipped.push(skip(format!("a document shows at most {MAX_ASSETS} images")));
            continue;
        }
        let candidate = if Path::new(&target).is_absolute() { PathBuf::from(&target) } else { dir.join(&target) };
        let Ok(path) = candidate.canonicalize() else {
            skipped.push(skip("not found".into()));
            continue;
        };
        let Some(mime) = image_mime(&path) else {
            skipped.push(skip("not a PNG, JPEG, GIF, WebP or SVG image".into()));
            continue;
        };
        if let Err(reason) = allowed(&path, policy, repo) {
            skipped.push(skip(reason));
            continue;
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX);
        if size > MAX_IMAGE_BYTES {
            skipped.push(skip(format!("{}, more than the {} an image may be", mib(size), mib(MAX_IMAGE_BYTES))));
            continue;
        }
        if used.saturating_add(size) > MAX_BUNDLE_BYTES {
            skipped.push(skip(format!("the document and its images would be more than {}", mib(MAX_BUNDLE_BYTES))));
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) if looks_like(mime, &bytes) => {
                used += bytes.len() as u64;
                images.push(BoardAsset { name: target.clone(), mime: mime.to_owned(), bytes });
            }
            Ok(_) => skipped.push(skip(format!("doesn't look like the {mime} image its name says"))),
            Err(e) => skipped.push(skip(format!("can't read it: {e}"))),
        }
    }
    (images, skipped)
}

/// The local image paths a Markdown document names, decoded, each once, in
/// order: `![alt](path)`, `![alt](<path with spaces>)`, and reference
/// definitions (`[logo]: path.png`). Links to the web, `data:` URLs and
/// anything inside fenced code are left out. The page looks images up by
/// these names, so they're kept as written (minus `?query` and `#fragment`).
pub fn image_targets(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |raw: &str| {
        if let Some(target) = local_target(raw)
            && !found.contains(&target)
        {
            found.push(target);
        }
    };
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(c) = marker {
            let run = trimmed.chars().take_while(|x| *x == c).count();
            if run >= 3 {
                match fence {
                    None => fence = Some((c, run)),
                    Some((open, len)) if open == c && run >= len && trimmed[run..].trim().is_empty() => fence = None,
                    Some(_) => {}
                }
                continue;
            }
        }
        if fence.is_some() {
            continue;
        }
        // A reference definition that names an image: `[name]: path "title"`.
        if let Some(rest) = trimmed.strip_prefix('[')
            && let Some((label, after)) = rest.split_once("]:")
            && !label.is_empty()
        {
            if let Some(dest) = destination(after.trim_start())
                && image_mime(Path::new(dest)).is_some()
            {
                add(dest);
            }
            continue;
        }
        let mut rest = line;
        while let Some(start) = rest.find("![") {
            rest = &rest[start + 2..];
            let Some(close) = rest.find("](") else { break };
            rest = &rest[close + 2..];
            if let Some(dest) = destination(rest) {
                add(dest);
            }
        }
    }
    found
}

/// The link destination at the start of `s`: `<…>`, or up to a space or the closing `)`.
fn destination(s: &str) -> Option<&str> {
    if let Some(inner) = s.strip_prefix('<') {
        return inner.split_once('>').map(|(d, _)| d);
    }
    let mut depth = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => return Some(&s[..i]),
            ')' => depth -= 1,
            c if c.is_whitespace() => return Some(&s[..i]),
            _ => {}
        }
    }
    (!s.is_empty()).then_some(s)
}

/// A destination naming a local file, decoded; `None` for the web, `data:`, `#anchors` and the like.
fn local_target(raw: &str) -> Option<String> {
    let raw = raw.trim();
    // A scheme (`https:`, `data:`, `mailto:`) or a protocol-relative `//host/…` isn't a local file.
    let has_scheme = raw.contains(':') && !raw.starts_with('/');
    if raw.is_empty() || raw.starts_with('#') || raw.starts_with("//") || has_scheme {
        return None;
    }
    let path = raw.split(['?', '#']).next().unwrap_or(raw);
    let decoded = percent_decode(path);
    (!decoded.is_empty()).then_some(decoded)
}

/// `%20` and friends; anything malformed stays as it is.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

/// A document's first level-1 heading (`# Title`), without its Markdown, outside fenced code.
pub fn first_heading(text: &str) -> Option<String> {
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title: String = rest.trim().trim_end_matches('#').trim().chars().filter(|c| !matches!(c, '`' | '*')).collect();
            return clean(Some(&title), 200);
        }
    }
    None
}

/// The board an item goes on. Without one asked for: the deacon's for the
/// deacon, else the caller's project, else the file's repository. Choosing
/// another board is for project managers and the deacon (and for callers
/// outside Herdr, who have no board of their own).
pub fn scope_for(requested: Option<&str>, caller: &Caller, repo_name: Option<&str>) -> Result<String> {
    let own = own_scope(caller, repo_name);
    let Some(requested) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(own);
    };
    let wanted = slug(requested)
        .ok_or_else(|| invalid(format!("`{requested}` isn't a board name: use letters, digits, `-`, `_` and `.` (at most 64)")))?;
    let leads = matches!(caller.role.as_deref(), Some("pm" | "deacon"));
    if wanted != own && caller.terminal.is_some() && !leads {
        return Err(invalid(format!(
            "only a project manager or the deacon may choose a board; yours is `{own}`. Leave out `scope`, or ask your manager to escalate."
        )));
    }
    Ok(wanted)
}

fn own_scope(caller: &Caller, repo_name: Option<&str>) -> String {
    if caller.role.as_deref() == Some("deacon") {
        return "deacon".into();
    }
    caller.project.as_deref().and_then(slug).or_else(|| repo_name.and_then(slug)).unwrap_or_else(|| "default".into())
}

/// A board name that reads well in a URL: lowercase letters, digits, `-`, `_`
/// and `.` (not first), at most 64. Other names give `None`.
pub fn slug(name: &str) -> Option<String> {
    let lower = name.trim().to_lowercase();
    let ok = !lower.is_empty()
        && lower.len() <= 64
        && !lower.starts_with('.')
        && lower.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then_some(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(terminal: Option<&str>, role: Option<&str>, project: Option<&str>) -> Caller {
        Caller {
            terminal: terminal.map(str::to_owned),
            role: role.map(str::to_owned),
            project: project.map(str::to_owned),
            ..Caller::default()
        }
    }

    #[test]
    fn boards_follow_herdr_labels_and_only_leads_choose() {
        let worker = caller(Some("t1n7"), Some("worker"), Some("herdr-android"));
        let pm = caller(Some("t1jf"), Some("pm"), Some("herdr-android"));
        let deacon = caller(Some("t16b"), Some("deacon"), None);
        let outside = Caller::default();
        assert_eq!(scope_for(None, &worker, Some("diffd")).unwrap(), "herdr-android");
        assert_eq!(scope_for(None, &pm, None).unwrap(), "herdr-android");
        assert_eq!(scope_for(None, &deacon, Some("diffd")).unwrap(), "deacon");
        assert_eq!(scope_for(None, &outside, Some("Diffd")).unwrap(), "diffd");
        assert_eq!(scope_for(None, &outside, None).unwrap(), "default");
        // Escalating is for leads; naming your own board is always fine.
        assert_eq!(scope_for(Some("deacon"), &pm, None).unwrap(), "deacon");
        assert!(scope_for(Some("deacon"), &worker, None).unwrap_err().to_string().contains("ask your manager"));
        assert_eq!(scope_for(Some("Herdr-Android"), &worker, None).unwrap(), "herdr-android");
        // Outside Herdr there's no board of your own to keep to.
        assert_eq!(scope_for(Some("notes"), &outside, None).unwrap(), "notes");
        for bad in ["../x", "a/b", ".hidden", "with space", &"x".repeat(65)] {
            assert!(scope_for(Some(bad), &pm, None).is_err(), "{bad}");
        }
    }

    #[test]
    fn image_targets_are_local_decoded_and_outside_code() {
        let doc = "# Report\n\
            ![cover](phone-shots/cover.png) and ![x](<shots/with space.png> \"t\")\n\
            ![remote](https://example.com/a.png) ![data](data:image/png;base64,AAA) ![anchor](#top)\n\
            ![again](phone-shots/cover.png) ![q](a%20b.png?raw=1#frag) ![paren](img/a(1).png)\n\
            ```md\n![in code](secret.png)\n```\n\
            [logo]: ./logo.svg \"Logo\"\n[docs]: ./PLAN.md\n![abs](/home/wolf/x.png)\n";
        assert_eq!(
            image_targets(doc),
            ["phone-shots/cover.png", "shots/with space.png", "a b.png", "img/a(1).png", "./logo.svg", "/home/wolf/x.png"]
        );
    }

    #[test]
    fn the_title_is_the_first_heading_outside_code() {
        assert_eq!(first_heading("```\n# not this\n```\nintro\n# Item 31: `present` a *file* #\n# second").as_deref(), Some("Item 31: present a file"));
        assert_eq!(first_heading("## only a subheading\ntext"), None);
    }

    #[test]
    fn images_must_look_like_their_type() {
        assert!(looks_like("image/png", b"\x89PNG\r\n\x1a\n...."));
        assert!(!looks_like("image/png", b"<svg onload=alert(1)>"));
        assert!(looks_like("image/svg+xml", b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
        assert!(looks_like("image/webp", b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!looks_like("image/jpeg", b"GIF89a"));
    }

    #[test]
    fn private_looking_files_are_denied_anywhere() {
        let policy = PresentPolicy::new(&[], &["*.secret".into(), "private/**".into()]).unwrap();
        for path in [
            "/home/u/repo/.env",
            "/home/u/repo/.env.local",
            "/home/u/.ssh/config",
            "/home/u/repo/certs/server.pem",
            "/home/u/repo/.git/config",
            "/home/u/id_ed25519.pub",
            "/home/u/repo/nix/secrets/db.yaml",
            "/home/u/repo/keys.sops.yaml",
            "/home/u/repo/a.secret",
            "/home/u/repo/private/notes.md",
        ] {
            assert!(policy.denied(Path::new(path)), "{path}");
        }
        for path in ["/home/u/repo/README.md", "/home/u/repo/src/env.rs", "/home/u/repo/docs/keyboard.png", "/home/u/repo/environment.md"] {
            assert!(!policy.denied(Path::new(path)), "{path}");
        }
        assert!(PresentPolicy::new(&[], &["[".into()]).is_err());
    }

    #[test]
    fn clean_keeps_one_short_line() {
        assert_eq!(clean(Some("  a\n  b  "), 10).as_deref(), Some("a b"));
        assert_eq!(clean(Some("   "), 10), None);
        assert_eq!(clean(Some("abcdef"), 3).as_deref(), Some("abc"));
        assert_eq!(percent_decode("a%20b%zz%2"), "a b%zz%2");
    }
}
