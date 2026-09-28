#!/usr/bin/env python3
"""
spec-triage-table.py — 战役任务 #0（287 题分类三角测量）批次提交表验证器
（MetaTask spec 脚本，协议 v1.2.1 §spec 契约）

命题口径：T0 每个批次节点提交一张分类表，覆盖该批 JSP 区间内全部
solved-no-lean 记录。本脚本做机器可判部分（schema + 区间覆盖 + 唯一性）；
逐题分类的实质正确性（证书类型判断是否成立等）由该节点 review 侧的
semantic_check 承接——这正是 T0 树里 review 权重存在的原因。

输入（stdin，JSON）:
  {
    "from": 1, "to": 100,                       // 本批 JSP 编号区间（含端点）
    "expected": 12,                              // 区间内 solved-no-lean 记录数（来自扫描清单）
    "records": [
      { "jsp": "JSP-000007", "certificateType": "deep-theory",
        "mathlibFeasibility": "low", "keyPaperPages": 260, "notes": "..." },
      ...
    ]
  }
输出（stdout，JSON）: { "verdict": "pass" | "fail" | "invalid", "detail": "..." }
判据（全过 = pass）:
  1) from/to 为正整数且 from <= to；expected 为非负整数；records 为数组
  2) 每条记录：jsp 匹配 ^JSP-\\d{6}$ 且编号落在 [from, to]；certificateType ∈
     {witness, bounded-computation, self-contained-proof, deep-theory}；
     mathlibFeasibility ∈ {high, medium, low, unknown}；keyPaperPages 为
     null 或正整数；jsp 编号不重复
  3) 覆盖性：records 数量 == expected（逐条对应由 review 抽查）
null/缺失 → invalid 并注明位置（协议 null_tolerance 判据）。
"""
import json
import re
import sys

CERT_TYPES = {"witness", "bounded-computation", "self-contained-proof", "deep-theory"}
FEASIBILITY = {"high", "medium", "low", "unknown"}
JSP_RE = re.compile(r"^JSP-(\d{6})$")


def bad(msg):
    print(json.dumps({"verdict": "fail", "detail": msg}, ensure_ascii=False))
    sys.exit(0)


def invalid(msg):
    print(json.dumps({"verdict": "invalid", "detail": msg}, ensure_ascii=False))
    sys.exit(0)


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as err:
        invalid("input json: %s" % err)
        return
    if not isinstance(raw, dict):
        invalid("input must be an object")
        return
    for field in ("from", "to", "expected"):
        v = raw.get(field)
        if not isinstance(v, int) or v < 0:
            invalid("missing or non-integer field: %s" % field)
            return
    lo, hi, expected = raw["from"], raw["to"], raw["expected"]
    if lo < 1 or lo > hi:
        bad("invalid range: %d..%d" % (lo, hi))
        return
    records = raw.get("records")
    if not isinstance(records, list):
        invalid("missing field: records")
        return
    seen = set()
    for i, rec in enumerate(records):
        where = "records[%d]" % i
        if not isinstance(rec, dict):
            invalid("%s: not an object" % where)
            return
        jsp = rec.get("jsp")
        m = JSP_RE.match(jsp) if isinstance(jsp, str) else None
        if not m:
            invalid("%s: jsp must match JSP-######" % where)
            return
        num = int(m.group(1))
        if not (lo <= num <= hi):
            bad("%s: %s outside batch range %d..%d" % (where, jsp, lo, hi))
            return
        if jsp in seen:
            bad("%s: duplicate %s" % (where, jsp))
            return
        seen.add(jsp)
        ct = rec.get("certificateType")
        if ct not in CERT_TYPES:
            bad("%s: certificateType must be one of %s" % (where, sorted(CERT_TYPES)))
            return
        mf = rec.get("mathlibFeasibility")
        if mf not in FEASIBILITY:
            bad("%s: mathlibFeasibility must be one of %s" % (where, sorted(FEASIBILITY)))
            return
        pages = rec.get("keyPaperPages")
        if pages is not None and (not isinstance(pages, int) or pages < 1):
            invalid("%s: keyPaperPages must be null or a positive integer" % where)
            return
        if not isinstance(rec.get("notes", ""), str):
            invalid("%s: notes must be a string" % where)
            return
    if len(records) != expected:
        bad("coverage mismatch: %d records vs expected %d" % (len(records), expected))
        return
    print(json.dumps({
        "verdict": "pass",
        "detail": "batch %04d-%04d: %d records, schema + range + uniqueness + coverage OK" % (lo, hi, len(records)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
