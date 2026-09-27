#!/usr/bin/env bash
# spec-lean-build.sh — 通用 Lean 形式化验证器（MetaTask spec 脚本，协议 v1.2.1 §spec 契约）
#
# 输入（stdin，JSON）: { "repo": "pin://|metafile://|本地路径", "target": "相对于 repo 根的 .lean 文件" }
# 输出（stdout，JSON）: { "verdict": "pass" | "fail" | "invalid", "detail": "..." }
# 判据: 在仓库根执行 lake build <target>，退出码 0 = pass（全部定理无 sorry 报错即视为
#       编译判定；--warning-as-error=error 保证 sorry/lint 失败即失败）。
# null/缺失 → invalid 并注明位置（协议 null_tolerance 判据）。
# 离线性: 输入为 pin://|metafile:// 时先经 metaid 内容端点拉取（发射环境自带工具）；
#         拉取失败 → invalid，不悬挂。
set -euo pipefail

input="$(cat)"

repo="$(printf '%s' "$input" | python3 -c 'import json,sys; d=sys.stdin.read(); print(json.loads(d).get("repo") or "")' 2>/dev/null || true)"
target="$(printf '%s' "$input" | python3 -c 'import json,sys; d=sys.stdin.read(); print(json.loads(d).get("target") or "")' 2>/dev/null || true)"

invalid() { printf '{"verdict":"invalid","detail":"%s"}\n' "$1"; exit 0; }
[ -n "$repo" ] || invalid "missing field: repo"
[ -n "$target" ] || invalid "missing field: target"

workdir="$repo"
case "$repo" in
  pin://*|metafile://*)
    tmp="$(mktemp -d)"
    if ! fetch_output="$(metabot "$repo" --download "$tmp" 2>&1)"; then
      invalid "artifact fetch failed: $fetch_output"
    fi
    workdir="$tmp"
    ;;
esac

[ -f "$workdir/lakefile.lean" ] || [ -f "$workdir/lakefile.toml" ] || invalid "not a lake project root: $workdir"

if (cd "$workdir" && lake build "$target" --warning-as-error=error >/dev/null 2>&1); then
  printf '{"verdict":"pass","detail":"lake build %s clean"}\n' "$target"
else
  printf '{"verdict":"fail","detail":"lake build %s failed (or contains sorry/admitted)"}\n' "$target"
fi
