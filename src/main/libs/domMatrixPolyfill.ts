/**
 * Minimal 2D DOMMatrix polyfill for pdfjs-dist in the Electron main process.
 *
 * pdfjs-dist 6 only sources DOMMatrix from the optional native
 * @napi-rs/canvas package, and that package resolves through
 * platform-specific binaries. When the binary is missing or was built for
 * another platform — e.g. a Windows installer whose node_modules only carry
 * the builder's darwin binary — the legacy build's module-level
 * `const SCALE_MATRIX = new DOMMatrix()` throws `DOMMatrix is not defined`
 * while evaluating pdf.mjs, so every PDF extraction fails. Knowledge-base
 * text extraction never renders, so a spec-subset 2D matrix that exists and
 * supports the handful of methods pdfjs calls is fully sufficient.
 *
 * Installed by knowledgeBaseConverters.loadPdfjs() before the first pdfjs
 * import; a real DOMMatrix (renderer processes, or a loadable @napi-rs/canvas)
 * always wins because the polyfill is skipped when globalThis.DOMMatrix is
 * already defined.
 */
export class MinimalDomMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(init?: unknown) {
    if (Array.isArray(init)) {
      if (init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init.map(Number);
      } else if (init.length === 16) {
        // 3D column-major layout: m11 m12 m13 m14 m21 … — keep the 2D plane.
        [this.a, this.b] = [Number(init[0]), Number(init[1])];
        [this.c, this.d] = [Number(init[4]), Number(init[5])];
        [this.e, this.f] = [Number(init[12]), Number(init[13])];
      } else {
        throw new TypeError('MinimalDomMatrix: init array must have 6 or 16 elements');
      }
    } else if (init && typeof init === 'object') {
      const source = init as Record<string, unknown>;
      this.a = Number(source.a ?? 1);
      this.b = Number(source.b ?? 0);
      this.c = Number(source.c ?? 0);
      this.d = Number(source.d ?? 1);
      this.e = Number(source.e ?? 0);
      this.f = Number(source.f ?? 0);
    } else {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
  }

  get is2D(): boolean {
    return true;
  }

  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  /** this × other, applied to a point as "this first, then other". */
  multiplySelf(other: MinimalDomMatrix): this {
    const o = new MinimalDomMatrix(other);
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b;
    this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d;
    this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e;
    this.f = b * o.e + d * o.f + f;
    return this;
  }

  preMultiplySelf(other: MinimalDomMatrix): this {
    const o = new MinimalDomMatrix(other);
    const { a, b, c, d, e, f } = this;
    this.a = o.a * a + o.c * b;
    this.b = o.b * a + o.d * b;
    this.c = o.a * c + o.c * d;
    this.d = o.b * c + o.d * d;
    this.e = o.a * e + o.c * f + o.e;
    this.f = o.b * e + o.d * f + o.f;
    return this;
  }

  translateSelf(x: number, y: number): this {
    this.e += this.a * x + this.c * y;
    this.f += this.b * x + this.d * y;
    return this;
  }

  scaleSelf(x: number, y: number = x): this {
    this.a *= x;
    this.b *= x;
    this.c *= y;
    this.d *= y;
    return this;
  }

  /** Per the geometry spec a singular matrix inverts to all-NaN components. */
  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  multiply(other: MinimalDomMatrix): MinimalDomMatrix {
    return new MinimalDomMatrix(this).multiplySelf(other);
  }

  inverse(): MinimalDomMatrix {
    return new MinimalDomMatrix(this).invertSelf();
  }

  translate(x: number, y: number): MinimalDomMatrix {
    return new MinimalDomMatrix(this).translateSelf(x, y);
  }

  scale(x: number, y: number = x): MinimalDomMatrix {
    return new MinimalDomMatrix(this).scaleSelf(x, y);
  }

  toJSON(): Record<string, number | boolean> {
    return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, is2D: true };
  }
}

/** Defines globalThis.DOMMatrix (as the 2D subset above) only when missing. */
export function ensureDomMatrixPolyfill(): void {
  const globals = globalThis as { DOMMatrix?: unknown };
  if (typeof globals.DOMMatrix !== 'undefined') return;
  globals.DOMMatrix = MinimalDomMatrix;
}
