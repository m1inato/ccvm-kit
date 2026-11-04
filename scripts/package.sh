#!/usr/bin/env bash
# Package only files reachable from a reviewed commit, never the deployment directory.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-HEAD}"
DIST="${CCVM_DIST_DIR:-$KIT/dist}"

die() { printf 'package: %s\n' "$*" >&2; exit 1; }
command -v python3 >/dev/null || die "需要 Python 3（仅开发/打包使用）"
command -v git >/dev/null || die "需要 Git"
case "$DIST" in /*) ;; *) die "CCVM_DIST_DIR 必须是绝对路径" ;; esac
[ -z "$(git -C "$KIT" status --porcelain --untracked-files=normal)" ] || die "先提交发布文件，再打包（忽略的本地配置与 state 不影响打包）"
COMMIT="$(git -C "$KIT" rev-parse --verify --end-of-options "${REF}^{commit}")"
VERSION="$(git -C "$KIT" show "${COMMIT}:VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION 必须是 x.y.z"
python3 "$KIT/verification/check-release.py" --ref "$COMMIT"

mkdir -p "$DIST"
WORK="$(mktemp -d "$DIST/.package.XXXXXX")"
trap 'rm -rf -- "${WORK:?}"' EXIT
NAME="ccvm-kit-$VERSION"
git -C "$KIT" archive --format=tar --prefix="$NAME/" "$COMMIT" | gzip -n > "$WORK/$NAME.tar.gz"
git -C "$KIT" archive --format=zip --prefix="$NAME/" "$COMMIT" > "$WORK/$NAME.zip"
# 不生成校验文件（见 AGENTS.md）
for suffix in .tar.gz .zip; do
  mv "$WORK/$NAME$suffix" "$DIST/$NAME$suffix"
  printf '%s\n' "$DIST/$NAME$suffix"
done
