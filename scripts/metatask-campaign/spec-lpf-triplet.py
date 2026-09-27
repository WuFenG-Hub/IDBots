#!/usr/bin/env python3
"""
spec-lpf-triplet.py — JSP-000307 见证验证器（MetaTask spec 脚本，协议 v1.2.1 §spec 契约）

命题（已解·见证型）：「存在三个相邻整数，最大素因子严格递减 P(n) > P(n+1) > P(n+2)」
（Erdős–Pomerance 1978 / Balog 2001 显式三元组）。

输入（stdin，JSON）:
  { "n": <int>, "factors": {"n": [[p,e],...], "n1": [[p,e],...], "n2": [[p,e],...] } }
  —— 见证必须自带三数的完全分解证书（素因子+指数），验证器不复算大数分解，只验证证书。
输出（stdout，JSON）: { "verdict": "pass" | "fail", "detail": "..." }
判据（全过 = pass）:
  1) 三数相邻（n, n+1, n+2）
  2) 每组因子证书：各素数确为素（确定性 Miller–Rabin，底集对 < 3.3e24 为证明性的固定底）；
     乘积恰等于对应整数
  3) 最大素因子严格递减：max P(n) > max P(n+1) > max P(n+2)
null/缺失 → invalid 并注明位置（协议 null_tolerance 判据）。
"""
import json
import sys

# 确定性 Miller–Rabin 固定底（对 n < 3,317,044,064,679,887,385,961,981 为证明性判定）
_WITNESSES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)


def is_prime(n):
    if not isinstance(n, int) or n < 2:
        return False
    for p in _WITNESSES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for a in _WITNESSES:
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def verify_certificate(value, pairs, label):
    """pairs: [[p, e], ...] → (最大素因子 or None, 错误说明 or None)"""
    if not isinstance(pairs, list) or not pairs:
        return None, "%s: empty factor certificate" % label
    product = 1
    largest = 0
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2:
            return None, "%s: malformed pair %r" % (label, pair)
        p, e = pair
        if not isinstance(p, int) or not isinstance(e, int) or p < 2 or e < 1:
            return None, "%s: bad pair values %r" % (label, pair)
        if not is_prime(p):
            return None, "%s: factor %d is not prime" % (label, p)
        product *= p ** e
        largest = max(largest, p)
    if product != value:
        return None, "%s: certificate product != value" % label
    return largest, None


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as err:
        print(json.dumps({"verdict": "invalid", "detail": "input json: %s" % err}))
        return
    n = raw.get("n")
    factors = raw.get("factors")
    if n is None:
        print(json.dumps({"verdict": "invalid", "detail": "missing field: n"}))
        return
    if not isinstance(factors, dict):
        print(json.dumps({"verdict": "invalid", "detail": "missing field: factors"}))
        return
    lps = []
    for key, value in (("n", n), ("n1", n + 1), ("n2", n + 2)):
        cert = factors.get(key)
        if cert is None:
            print(json.dumps({"verdict": "invalid", "detail": "missing factors.%s" % key}))
            return
        lp, err = verify_certificate(value, cert, key)
        if err:
            print(json.dumps({"verdict": "fail", "detail": err}))
            return
        lps.append(lp)
    if not (lps[0] > lps[1] > lps[2]):
        print(json.dumps({"verdict": "fail",
                          "detail": "largest prime factors not strictly decreasing: %s" % lps}))
        return
    print(json.dumps({
        "verdict": "pass",
        "detail": "triplet verified: P(%d)=%d > P(%d)=%d > P(%d)=%d" % (n, lps[0], n + 1, lps[1], n + 2, lps[2]),
    }))


if __name__ == "__main__":
    main()
