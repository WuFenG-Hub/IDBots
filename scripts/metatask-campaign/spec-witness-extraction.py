#!/usr/bin/env python3
"""
spec-witness-extraction.py — witness-extraction submission checker (MetaTask
spec script, protocol v1.2.1 §spec contract). Used by search-kind nodes.

Node shape it judges: "extract the counterexample witness from the source
record/literature AND re-derive its own factorization certificate with a citable
provenance block" (T1-JSP-000301 node `witness`). This script closes everything
machine-checkable about that submission — schema, consecutiveness, provenance
binding, certificate validity. The mathematical substance (is this really the
published pair, does the locator exist) stays with the review node's
semantic_check; the primary witness verification is the proof node's
spec-powerful-pair.py run, deliberately independent of this one.

Input (stdin, JSON):
  {
    "jsp": "JSP-000301",
    "claim": { "n": 12167, "m": 12168 },
    "provenance": {
      "reference": "Solomon W. Golomb, Powerful numbers, Amer. Math. Monthly 77(8) (1970), 848-852",
      "locator": "https://doi.org/10.2307/2317020",
      "recordField": "JSP-000301 review note (Record correction)",
      "quotedText": "... 12167 = 23^3 and 12168 = 2^3 x 3^2 x 13^2 are consecutive powerful numbers ..."
    },
    "factorization": { "n": [[23, 3]], "m": [[2, 3], [3, 2], [13, 2]] }
  }
Output (stdout, JSON): { "verdict": "pass" | "fail" | "invalid", "detail": "..." }
Criteria (all must hold for pass):
  1) jsp matches ^JSP-[0-9]{6}$; claim.n and claim.m are integers >= 1 and
     m == n + 1 (a consecutive pair is the whole point of the node)
  2) provenance: reference / locator / recordField / quotedText are non-empty
     strings AND quotedText contains both n and m as decimal substrings — the
     extraction must bind the pair back to a citable source text
  3) every factorization entry [p, e]: p prime (deterministic Miller-Rabin,
     fixed witness set), e >= 2, and the product of all entries equals the
     labelled value — a powerful witness must exhibit an exponent >= 2 for
     every prime, not just a plausible-looking pair
null/missing input, or a shape that cannot be judged -> verdict=invalid with the
offending location (protocol null_tolerance criterion).
"""
import json
import re
import sys

# Deterministic Miller-Rabin fixed bases (proof-level for n < 3,317,044,064,679,887,385,961,981)
_WITNESSES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
JSP_RE = re.compile(r"^JSP-\d{6}$")


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


def check_certificate(pairs, value, label):
    """pairs: [[p, e], ...] -> (primes, error or None). Every exponent must be >= 2."""
    if not isinstance(pairs, list) or not pairs:
        return None, "%s: empty factorization certificate" % label
    product = 1
    primes = []
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2:
            return None, "%s: malformed [p, e] pair %r" % (label, pair)
        p, e = pair
        if not isinstance(p, int) or not isinstance(e, int):
            return None, "%s: non-integer pair %r" % (label, pair)
        if not is_prime(p):
            return None, "%s: %d is not prime" % (label, p)
        if e < 2:
            return None, "%s: prime %d has exponent %d (< 2) — not a powerful witness" % (label, p, e)
        product *= p ** e
        primes.append(p)
    if product != value:
        return None, "%s: certificate product %d != %d" % (label, product, value)
    return primes, None


def emit(verdict, detail, **extra):
    payload = {"verdict": verdict, "detail": detail}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as err:
        emit("invalid", "input json: %s" % err)
    if not isinstance(raw, dict):
        emit("invalid", "input must be an object")

    jsp = raw.get("jsp")
    if not isinstance(jsp, str) or not JSP_RE.match(jsp):
        emit("invalid", "jsp: must be a string matching JSP-######")
    claim = raw.get("claim")
    if not isinstance(claim, dict):
        emit("invalid", "claim: missing or not an object")
    n, m = claim.get("n"), claim.get("m")
    if not isinstance(n, int) or not isinstance(m, int) or n < 1 or m < 1:
        emit("invalid", "claim.n/claim.m: missing or not integers >= 1")
    if m != n + 1:
        emit("fail", "claim: not consecutive (m != n + 1)")

    prov = raw.get("provenance")
    if not isinstance(prov, dict):
        emit("invalid", "provenance: missing or not an object")
    for field in ("reference", "locator", "recordField", "quotedText"):
        value = prov.get(field)
        if not isinstance(value, str) or not value.strip():
            emit("invalid", "provenance.%s: missing or empty" % field)
    quoted = prov["quotedText"]
    for label, value in (("n", n), ("m", m)):
        if str(value) not in quoted:
            emit("fail", "provenance.quotedText does not contain %s = %d" % (label, value))

    factors = raw.get("factorization")
    if not isinstance(factors, dict):
        emit("invalid", "factorization: missing or not an object")
    primes = []
    for key, value in (("n", n), ("m", m)):
        cert = factors.get(key)
        if cert is None:
            emit("invalid", "factorization.%s: missing" % key)
        found, err = check_certificate(cert, value, key)
        if err:
            emit("fail", err)
        primes.extend(found)
    print(json.dumps({
        "verdict": "pass",
        "detail": "witness extraction verified: %s n=%d m=%d; provenance bound to %s"
                  % (jsp, n, m, prov["recordField"]),
        "primeSupport": sorted(set(primes)),
        "expected_count": len(set(primes)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
