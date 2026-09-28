#!/usr/bin/env python3
"""
spec-powerful-pair.py — JSP-000301 反例见证验证器（MetaTask spec 脚本，协议 v1.2.1 §spec 契约）

命题（已解·反例型，Golomb 1970）：「两个相邻正整数均为 powerful（∀ 素数 p | n: p² | n），
是否必有其一为完全平方数？」 答案：否。见证 = 一对相邻 powerful 非平方整数。

输入（stdin，JSON）: { "n": <int>, "m": <int> }   （约定 m = n + 1）
输出（stdout，JSON）: { "verdict": "pass" | "fail", "detail": "..." }
判据（全过 = pass）:
  1) m == n + 1（相邻）
  2) n 与 m 均为 powerful：每个素因子 p 满足 p² | 该数
  3) n 与 m 均非完全平方数
null/缺失输入 → verdict=invalid 并注明位置（协议 null_tolerance 判据）。
"""
import json
import sys


def factorize(x):
    """试除分解（见证量级 ~10^7 级别毫秒完成；更大见证换 sympy/ECPP 由聚合件另行升级）。"""
    if not isinstance(x, int) or x < 2:
        return None
    factors = {}
    d = 2
    while d * d <= x:
        while x % d == 0:
            factors[d] = factors.get(d, 0) + 1
            x //= d
        d += 1 if d == 2 else 2
    if x > 1:
        factors[x] = factors.get(x, 0) + 1
    return factors


def is_powerful(x):
    factors = factorize(x)
    if factors is None:
        return False, "not factorizable as an integer >= 2"
    bad = [p for p, e in factors.items() if e < 2]
    return (not bad), ("weak prime %d (exp 1)" % bad[0] if bad else "all prime exponents >= 2")


def is_square(x):
    if x < 0:
        return False
    r = int(x ** 0.5)
    for c in (r - 1, r, r + 1):
        if c >= 0 and c * c == x:
            return True
    return False


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as err:
        print(json.dumps({"verdict": "invalid", "detail": "input json: %s" % err}))
        return
    n, m = raw.get("n"), raw.get("m")
    if n is None or m is None:
        print(json.dumps({"verdict": "invalid", "detail": "missing field: %s" % ("n" if n is None else "m")}))
        return
    if not isinstance(n, int) or not isinstance(m, int):
        print(json.dumps({"verdict": "invalid", "detail": "n/m must be integers"}))
        return
    if m != n + 1:
        print(json.dumps({"verdict": "fail", "detail": "not consecutive: m != n + 1"}))
        return
    notes = []
    for label, v in (("n", n), ("m", m)):
        ok, why = is_powerful(v)
        if not ok:
            notes.append("%s not powerful: %s" % (label, why))
        if is_square(v):
            notes.append("%s is a perfect square (%d)" % (label, int(v ** 0.5)))
    if notes:
        print(json.dumps({"verdict": "fail", "detail": "; ".join(notes)}))
        return
    print(json.dumps({
        "verdict": "pass",
        "detail": "adjacent powerful non-square pair verified: n=%d m=%d" % (n, m),
        "factorization": {"n": factorize(n), "m": factorize(m)},
    }))


if __name__ == "__main__":
    main()
