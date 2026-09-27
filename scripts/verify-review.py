#!/usr/bin/env python3
"""Share a range of a real repository with a running diffd and check the
review against git itself.

    scripts/verify-review.py <repo> <from> [<to>] [--port 3433]

Checks, for the whole range and for each commit in it:
- the files are exactly `git diff --name-status -M` between the two sides;
- each file's old and new text is exactly what `git show` gives;
- the aligned rows use every old and new line once, in order;
- the commit list is `git rev-list --first-parent` of the range.

Prints the review link and a summary; exits non-zero on the first mismatch.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_client import Mcp  # noqa: E402

MAX_COMMITS_CHECKED = 12


def git(repo: str, *args: str) -> bytes:
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True).stdout


def lines_of(data: bytes) -> list[str]:
    text = data.decode("utf-8", errors="replace")
    if text == "":
        return []
    out = text.split("\n")
    if out[-1] == "":
        out.pop()
    return [line[:-1] if line.endswith("\r") else line for line in out]


def show(repo: str, rev: str, path: str) -> bytes | None:
    try:
        return git(repo, "show", f"{rev}:{path}")
    except subprocess.CalledProcessError:
        return None


def expected_files(repo: str, base: str, to: str | None) -> dict[str, str]:
    args = ["diff", "--name-status", "-z", "-M", base] + ([to] if to else [])
    parts = [p for p in git(repo, *args).decode().split("\0") if p]
    files: dict[str, str] = {}
    i = 0
    while i < len(parts):
        status = parts[i]
        if status[0] in "RC":
            files[parts[i + 2]] = status[0]
            i += 3
        else:
            files[parts[i + 1]] = status[0]
            i += 2
    if to is None:
        for p in git(repo, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0"):
            if p:
                files[p] = "A"
    return files


def fail(msg: str) -> None:
    print(f"MISMATCH: {msg}")
    sys.exit(1)


def check_snapshot(repo: str, snap: dict, base: str, to: str | None, label: str) -> int:
    want = expected_files(repo, base, to)
    got = {f["path"]: f for f in snap["files"]}
    if set(got) != set(want):
        fail(f"{label}: files differ. only in diffd: {sorted(set(got) - set(want))[:5]} only in git: {sorted(set(want) - set(got))[:5]}")
    checked = 0
    for path, f in got.items():
        if f["omitted"]:
            continue
        old_path = f["oldPath"] or path
        new_text = (open(os.path.join(repo, path), "rb").read() if os.path.exists(os.path.join(repo, path)) else None) if to is None else show(repo, to, path)
        old_text = show(repo, base, old_path)
        for side, text in (("new", new_text), ("old", old_text)):
            ours = f[side]["lines"] if f[side] else None
            theirs = lines_of(text) if text is not None and f["status"] != ("added" if side == "old" else "deleted") else None
            if (ours is None) != (theirs is None) or (ours is not None and ours != theirs):
                n = next((i for i, (a, b) in enumerate(zip(ours or [], theirs or [])) if a != b), None)
                fail(f"{label}: {path} {side} side differs (first difference at line {n}; {len(ours or [])} vs {len(theirs or [])} lines)")
        # Rows use each line once, in order.
        for k, side in ((0, "old"), (1, "new")):
            seq = [r[k] for r in f["rows"] if r[k] is not None]
            n = len(f[side]["lines"]) if f[side] else 0
            if seq != list(range(n)):
                fail(f"{label}: {path} rows don't cover the {side} side exactly once, in order")
        checked += 1
    return checked


def get(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://localhost:{port}{path}") as r:
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("frm")
    ap.add_argument("to", nargs="?")
    ap.add_argument("--port", type=int, default=3433)
    a = ap.parse_args()
    repo = os.path.abspath(a.repo)

    started = time.time()
    shared = Mcp(f"http://localhost:{a.port}/mcp").call(
        "share_diff", {"repo_path": repo, "from": a.frm, **({"to": a.to} if a.to else {}), "title": f"{os.path.basename(repo)} {a.frm}..{a.to or 'working tree'}"}
    )
    took = time.time() - started
    rid = shared["review_id"]
    state = get(a.port, f"/api/reviews/{rid}")
    to = git(repo, "rev-parse", f"{a.to}^{{commit}}").decode().strip() if a.to else None
    # The review's base, resolved the way diffd does: branches from their merge base.
    def is_branch(name: str) -> bool:
        refs = [name] if name.startswith(("refs/heads/", "refs/remotes/")) else [f"refs/heads/{name}", f"refs/remotes/{name}"]
        return any(subprocess.run(["git", "-C", repo, "show-ref", "--verify", "--quiet", r]).returncode == 0 for r in refs)
    if is_branch(a.frm):
        base = git(repo, "merge-base", a.frm, to or "HEAD").decode().strip()
    else:
        base = git(repo, "rev-parse", f"{a.frm}^{{commit}}").decode().strip()
    files = check_snapshot(repo, state["snapshot"], base, to, "whole range")

    commits = [c["sha"] for c in state["history"]["commits"]]
    want = git(repo, "rev-list", "--first-parent", "--reverse", f"{base}..{to or 'HEAD'}").decode().split()
    if state["history"]["truncated"]:
        want = want[-len(commits):]
    if commits != want:
        fail(f"commits differ: {len(commits)} vs {len(want)}")
    # With a long history only the newest commits are listed, walking from the first one's parent.
    points = [state["history"]["base"]] + commits
    for i, sha in enumerate(commits[:MAX_COMMITS_CHECKED]):
        q = urllib.parse.urlencode({"from": points[i], "to": sha})
        snap = get(a.port, f"/api/reviews/{rid}/range?{q}")
        check_snapshot(repo, snap, points[i], sha, f"commit {sha[:8]}")

    rows = sum(len(f["rows"]) for f in state["snapshot"]["files"])
    print(f"ok {shared['url']}  {len(state['snapshot']['files'])} files ({files} text), {rows} rows, {len(commits)} commits "
          f"({min(len(commits), MAX_COMMITS_CHECKED)} checked), shared in {took:.1f}s")


if __name__ == "__main__":
    main()
