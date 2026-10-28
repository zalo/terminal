#!/usr/bin/env python3
"""Claude Code hook: write per-tmux-session metadata the terminal UI reads.

Fires on UserPromptSubmit / Stop / SessionStart / SessionEnd. Looks up the
current tmux session via $TMUX and writes /tmp/claude-terminal-meta/<session>.json
with status, task summary (gist of Claude's last reply), cwd, and claude
session id. Preserves any fields set by `tm-meta` (like preview_url) across turns.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# Per-context dir: the terminal server exports CLAUDE_META_DIR into each tmux
# session it spawns (server/src/contexts.ts), so agent-* contexts write to
# their own dir instead of the admin one.
META_DIR = Path(os.environ.get("CLAUDE_META_DIR", "/tmp/claude-terminal-meta"))
TASK_MAX = 160
# Headings/meta-prefixes that make poor glance-summaries — skip them when extracting.
BORING_PREFIXES = ("let me ", "i'll ", "i will ", "now ", "ok ", "okay ", "sure")


def tmux_session():
    t = os.environ.get("TMUX")
    if not t:
        return None
    sock = t.split(",", 1)[0]
    try:
        r = subprocess.run(
            ["tmux", "-S", sock, "display-message", "-p", "#S"],
            capture_output=True, text=True, timeout=2,
        )
        name = r.stdout.strip()
        if not name:
            return None
        return re.sub(r"[/\\]", "_", name)
    except Exception:
        return None


def clean_line(text: str) -> str:
    """Flatten whitespace, strip markdown adornments that don't read well inline."""
    text = " ".join((text or "").split())
    # Strip common markdown: leading #, leading list markers, wrapping *, `
    text = re.sub(r"^#+\s*", "", text)
    text = re.sub(r"^[-*]\s+", "", text)
    text = text.replace("**", "")
    return text.strip()


def summarize_reply(text: str) -> str:
    """Pick the most meaningful line from an assistant reply and truncate it."""
    if not text:
        return ""
    # Prefer a non-trivial first line; fall back to subsequent lines if boring.
    candidates = [clean_line(l) for l in text.splitlines() if clean_line(l)]
    for line in candidates:
        low = line.lower()
        if len(line) < 8:
            continue
        if any(low.startswith(p) for p in BORING_PREFIXES) and len(candidates) > 1:
            continue
        return line[:TASK_MAX] + ("…" if len(line) > TASK_MAX else "")
    # Nothing passed the filter — return the first line we've got.
    if candidates:
        line = candidates[0]
        return line[:TASK_MAX] + ("…" if len(line) > TASK_MAX else "")
    return ""


def last_assistant_text(transcript_path: str) -> str:
    """Read the transcript JSONL and return the last assistant text block.
    Reads only the tail of large files to stay fast."""
    if not transcript_path or not os.path.exists(transcript_path):
        return ""
    try:
        size = os.path.getsize(transcript_path)
        tail_bytes = 200 * 1024  # last 200KB is plenty for one turn
        with open(transcript_path, "rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
                f.readline()  # discard partial line
            data = f.read().decode("utf-8", errors="replace")
        lines = [l for l in data.splitlines() if l.strip()]
        for line in reversed(lines):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "assistant":
                continue
            content = ((obj.get("message") or {}).get("content")) or []
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text":
                    t = (block.get("text") or "").strip()
                    if t:
                        return t
    except Exception:
        pass
    return ""


def main():
    sess = tmux_session()
    if not sess:
        return 0

    META_DIR.mkdir(exist_ok=True)
    path = META_DIR / f"{sess}.json"

    meta = {}
    if path.exists():
        try:
            meta = json.loads(path.read_text())
        except Exception:
            meta = {}

    try:
        event = json.loads(sys.stdin.read() or "{}")
    except Exception:
        event = {}

    hook = event.get("hook_event_name", "")
    meta["session"] = sess
    meta["cwd"] = event.get("cwd") or meta.get("cwd") or os.getcwd()
    meta["claude_session_id"] = event.get("session_id") or meta.get("claude_session_id")
    meta["updated_at"] = int(time.time())
    transcript = event.get("transcript_path") or ""

    if hook == "UserPromptSubmit":
        # Mark as working. Keep the previous turn's task so the mobile UI has useful
        # context while Claude starts a new response — it updates on Stop.
        meta["status"] = "working"
    elif hook == "Stop":
        meta["status"] = "waiting"
        # Extract a human-readable summary from Claude's latest reply.
        summary = summarize_reply(last_assistant_text(transcript))
        if summary:
            meta["task"] = summary
    elif hook == "SessionStart":
        meta.setdefault("status", "idle")
        meta.setdefault("task", "")
        # On resume, try to seed task from the transcript.
        if not meta.get("task"):
            summary = summarize_reply(last_assistant_text(transcript))
            if summary:
                meta["task"] = summary
    elif hook == "SessionEnd":
        meta["status"] = "finished"

    try:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, indent=2))
        tmp.replace(path)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
