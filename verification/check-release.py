#!/usr/bin/env python3
"""Check the publishable source tree, without reading ignored deployment files."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def local_source_path(name):
    path = PurePosixPath(name)
    return (path.parts[0] in {"state", "dist", ".git", "LOCAL_SETUP.md"}
            or "__pycache__" in path.parts or name == "config/local.env"
            or path.name.endswith(".local.js")
            or (path.name.startswith(".env") and path.name != ".env.example")
            or path.name == "expected-ip.txt" or path.suffix == ".log"
            or path.name in {"id_rsa", "id_ed25519"})


def source_files(root, ref=None):
    if ref:
        commit = git(root, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()
        result = {}
        for entry in git(root, "ls-tree", "-r", "-z", commit).split(b"\0"):
            if not entry:
                continue
            header, name = entry.split(b"\t", 1)
            mode, kind, oid = header.split()
            if kind != b"blob" or mode not in (b"100644", b"100755"):
                raise ValueError("Unexpected source entry: " + name.decode())
            result[name.decode()] = git(root, "cat-file", "blob", oid.decode())
        return result
    if (root / ".git").exists():
        names = [p.decode() for p in git(root, "ls-files", "-z").split(b"\0") if p]
        if not names:
            raise ValueError("No tracked files; stage the release files before checking")
    else:
        # Extracted sources have no Git index. Do not read deployment files added
        # after extraction. Packaging checks the actual committed tree separately.
        names = []
        for parent, directories, filenames in os.walk(root):
            directories[:] = [d for d in directories
                               if not local_source_path((Path(parent) / d).relative_to(root).as_posix())]
            names.extend((Path(parent) / f).relative_to(root).as_posix() for f in filenames
                         if not local_source_path((Path(parent) / f).relative_to(root).as_posix()))
    result = {}
    for name in names:
        p = root / name
        if p.is_symlink():
            raise ValueError("Source symlinks are not supported: " + name)
        result[name] = p.read_bytes()
    return result


def validate(files):
    errors = []
    home_path = re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+(?:/|\b)")
    credential = re.compile(
        r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
        r"sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)"
    )
    # 项目禁止这种哈希（AGENTS.md）：任何被跟踪的文件都不能使用或提到它，AGENTS.md 本身除外
    forbidden_hash = re.compile(r"sha[-_ ]?256|shasum\s+-a\s*256", re.I)
    for name, data in files.items():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            errors.append(name + ": unsafe source path")
            continue
        if local_source_path(name):
            errors.append(name + ": local configuration or runtime data")
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(name + ": unexpected binary source file")
            continue
        if any(not m.group().rstrip("/") == "/home/cc" for m in home_path.finditer(content)):
            errors.append(name + ": machine-specific absolute home path")
        if credential.search(content):
            errors.append(name + ": possible credential material")
        if name != "AGENTS.md" and (forbidden_hash.search(content) or forbidden_hash.search(name)):
            errors.append(name + ": uses a hash algorithm this project forbids (see AGENTS.md)")

    version = files.get("VERSION", b"").decode("utf-8").strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        errors.append("VERSION: expected x.y.z")
    template = files.get("config/clash-verge-script.js", b"").decode("utf-8")
    if not re.search(r'^const NODE = "REPLACE_WITH_EXACT_NODE_NAME";$', template, re.M):
        errors.append("config/clash-verge-script.js: NODE must remain an unconfigured placeholder")
    try:
        json.loads(files["config/sing-box.json"])
    except (KeyError, ValueError):
        errors.append("config/sing-box.json: missing or invalid JSON")
    if "README.md" not in files:
        errors.append("README.md: missing")
    if "AGENTS.md" not in files:
        errors.append("AGENTS.md: missing")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Check committed blobs instead of working files")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        files = source_files(root, args.ref)
        errors = validate(files)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print("FAIL release source:", exc, file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print("FAIL", error, file=sys.stderr)
        return 1
    print(f"PASS release source: {len(files)} files; generic template; local state excluded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
