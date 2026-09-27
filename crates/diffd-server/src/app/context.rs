//! Files outside the diff: listing the repository, and opening any file for
//! context (to read, comment on, or be shown by the agent).

use std::path::Path;

use diffd_core::build::{FileInput, build_file};
use diffd_core::model::{FileDiff, FileStatus, Omitted, ReviewId};
use diffd_core::text::looks_binary;

use super::rebuild::resolve;
use super::{App, AppError, Result};
use crate::ports::{Contents, MAX_FILE_BYTES};

impl App {
    /// Every file in the repository on the review's `to` side.
    pub async fn repo_files(&self, id: &ReviewId) -> Result<Vec<String>> {
        let (meta, spec) = self.meta(id).await?;
        let source = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let repo = source.open(Path::new(&meta.repo_path))?;
            let resolved = resolve(source.as_ref(), &repo, &meta.from, meta.to.as_deref(), &spec)?;
            source.files(&repo, &resolved)
        })
        .await
        .map_err(anyhow::Error::from)?
        .map_err(AppError::from)
    }

    /// A file as it is on the review's `to` side, highlighted, as an unchanged "diff".
    /// An absolute path works too when a language server pointed there (a library's source).
    pub async fn context_file(&self, id: &ReviewId, path: &str) -> Result<FileDiff> {
        let (meta, spec) = self.meta(id).await?;
        let external = path.starts_with('/');
        if external && !self.external_allowed(id, path).await {
            return Err(AppError::Invalid(format!("`{path}` is outside the repository")));
        }
        let (source, path) = (self.repo.clone(), path.to_owned());
        let contents = if external {
            // A path a language server points at can be anything: check before reading.
            match tokio::fs::metadata(&path).await {
                Ok(m) if !m.is_file() => None,
                Ok(m) if m.len() > MAX_FILE_BYTES => Some(Contents::TooLarge),
                Ok(_) => Some(Contents::Bytes(tokio::fs::read(&path).await.map_err(|e| anyhow::anyhow!(e))?)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(anyhow::anyhow!(e).into()),
            }
        } else {
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let repo = source.open(Path::new(&meta.repo_path))?;
                let resolved = resolve(source.as_ref(), &repo, &meta.from, meta.to.as_deref(), &spec)?;
                source.read(&repo, &resolved, &path)
            })
            .await
            .map_err(anyhow::Error::from)??
        };
        let contents = contents.ok_or_else(|| AppError::NotFound(format!("no file `{path}` in this repository")))?;
        if !external {
            self.watch_context(id, &path).await;
        }
        let (omitted, text) = match contents {
            Contents::TooLarge => (Some(Omitted::TooLarge), String::new()),
            Contents::Bytes(bytes) if looks_binary(&bytes) => (Some(Omitted::Binary), String::new()),
            Contents::Bytes(bytes) => (None, String::from_utf8_lossy(&bytes).into_owned()),
        };
        let input = FileInput {
            path,
            old_path: None,
            status: FileStatus::Unchanged,
            old: Some(text.clone()),
            new: Some(text),
            omitted,
            details: Vec::new(),
            collapsed: None,
        };
        let mut file = tokio::task::spawn_blocking(move || build_file(&input, None)).await.map_err(|e| anyhow::anyhow!(e))?;
        // The user asked to see it: generated or not, don't fold it away.
        file.collapsed = None;
        Ok(file)
    }

    /// The lines `start..=end` (1-based) of a file on one side: from the diff
    /// when the file is in it, otherwise read from the repository.
    pub(super) async fn lines_anywhere(
        &self,
        id: &ReviewId,
        snap: &diffd_core::model::Snapshot,
        path: &str,
        side: diffd_core::model::Side,
        start: u32,
        end: u32,
    ) -> Result<String> {
        if snap.files.iter().any(|f| f.path == path) {
            return super::conversation::anchor_text(snap, path, side, start, end);
        }
        let file = self.context_file(id, path).await?;
        if let Some(why) = file.omitted {
            return Err(AppError::Invalid(format!("`{path}` can't be shown ({why})")));
        }
        super::conversation::pick_lines(&file.new.map(|t| t.lines).unwrap_or_default(), path, start, end)
    }
}
