//! Text helpers: splitting into lines and converting byte offsets to UTF-16.

/// Split file contents into lines without their terminators. A trailing
/// newline does not produce an extra empty line.
pub fn split_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = content.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned()).collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// The UTF-16 offset of byte offset `byte` within `line`. Offsets inside a
/// multi-byte character snap to its start.
pub fn utf16_col(line: &str, byte: usize) -> u32 {
    let byte = byte.min(line.len());
    let mut end = byte;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].encode_utf16().count() as u32
}

/// Byte offset of the start of each line in `source` (split on `\n`).
pub fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0).chain(source.match_indices('\n').map(|(i, _)| i + 1)).collect()
}

/// Whether `content` looks binary (a NUL byte in the first 8 KiB), as git does.
pub fn looks_binary(content: &[u8]) -> bool {
    content.iter().take(8000).any(|&b| b == 0)
}

/// How a text's lines end.
fn line_endings(content: &[u8]) -> Option<&'static str> {
    let lf = content.iter().filter(|&&b| b == b'\n').count();
    let crlf = content.windows(2).filter(|w| w == b"\r\n").count();
    match (lf, crlf) {
        (0, _) => None,
        (_, 0) => Some("LF"),
        (lf, crlf) if lf == crlf => Some("CRLF"),
        _ => Some("mixed"),
    }
}

/// Changes between two texts that don't show in their lines: line endings
/// and the newline at the end of the file.
pub fn invisible_changes(old: &[u8], new: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if let (Some(a), Some(b)) = (line_endings(old), line_endings(new))
        && a != b
    {
        out.push(format!("line endings {a} → {b}"));
    }
    let ends = |c: &[u8]| c.last() == Some(&b'\n');
    if !old.is_empty() && !new.is_empty() && ends(old) != ends(new) {
        out.push(if ends(new) { "adds the newline at end of file" } else { "no newline at end of file" }.to_owned());
    }
    out
}

/// The range covering a line's content, minus leading whitespace, in UTF-16.
pub fn trimmed_range(line: &str) -> Option<(u32, u32)> {
    let start = line.len() - line.trim_start().len();
    if start == line.len() {
        return None;
    }
    Some((utf16_col(line, start), utf16_col(line, line.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_invisible_changes() {
        assert_eq!(invisible_changes(b"a\r\nb\r\n", b"a\nb\n"), vec!["line endings CRLF → LF"]);
        assert_eq!(invisible_changes(b"a\nb\n", b"a\nb"), vec!["no newline at end of file"]);
        assert_eq!(invisible_changes(b"a\nb", b"a\nb\n"), vec!["adds the newline at end of file"]);
        assert!(invisible_changes(b"a\n", b"b\n").is_empty());
        assert!(invisible_changes(b"", b"b").is_empty());
    }

    #[test]
    fn splits_lines() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb"), vec!["a", "b"]);
        assert_eq!(split_lines(""), Vec::<String>::new());
        assert_eq!(split_lines("\n"), vec![""]);
    }

    #[test]
    fn converts_to_utf16() {
        let line = "let s = \"héllo wörld\"; let z = 1;";
        let byte = line.find("let z").unwrap();
        assert_eq!(byte, 25);
        assert_eq!(utf16_col(line, byte), 23);
        assert_eq!(utf16_col("😀x", 4), 2);
        assert_eq!(utf16_col("é", 1), 0);
    }

    #[test]
    fn trims() {
        assert_eq!(trimmed_range("    foo"), Some((4, 7)));
        assert_eq!(trimmed_range("   "), None);
    }
}
