//! Files outside the diff: listing the repository, and opening any file for
//! context (to read, comment on, or be shown by the agent).

use std::path::Path;

use diffd_core::build::{FileInput, build_file};
use diffd_core::model::{FileDiff, FileStatus, ReviewId};
use diffd_core::text::looks_binary;

use super::rebuild::resolve;
use super::{App, AppError, Result};

/// Larger files are listed but not opened.
const MAX_CONTEXT_BYTES: usize = 3 * 1024 * 1024;

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
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| AppError::Invalid(format!("{e:#}")))
    }

    /// A file as it is on the review's `to` side, highlighted, as an unchanged "diff".
    pub async fn context_file(&self, id: &ReviewId, path: &str) -> Result<FileDiff> {
        let (meta, spec) = self.meta(id).await?;
        let (source, path) = (self.repo.clone(), path.to_owned());
        let bytes = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let repo = source.open(Path::new(&meta.repo_path))?;
                let resolved = resolve(source.as_ref(), &repo, &meta.from, meta.to.as_deref(), &spec)?;
                source.read(&repo, &resolved, &path)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?
            .map_err(|e| AppError::Invalid(format!("{e:#}")))?
        };
        let bytes = bytes.ok_or_else(|| AppError::NotFound(format!("no file `{path}` in this repository")))?;
        let binary = bytes.len() > MAX_CONTEXT_BYTES || looks_binary(&bytes);
        let text = if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() };
        let input = FileInput {
            path,
            old_path: None,
            status: FileStatus::Unchanged,
            old: Some(text.clone()),
            new: Some(text),
            binary,
            collapsed: None,
        };
        Ok(tokio::task::spawn_blocking(move || build_file(&input, None)).await.map_err(|e| anyhow::anyhow!(e))?)
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
        let lines = file.new.map(|t| t.lines).unwrap_or_default();
        let n = lines.len() as u32;
        if start == 0 || start > end || end > n {
            return Err(AppError::Invalid(format!("lines {start}-{end} are outside `{path}` ({n} lines)")));
        }
        Ok(lines[start as usize - 1..end as usize].join("\n"))
    }
}
