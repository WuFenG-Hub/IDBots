import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

/** Renders the Alipay QR code onto a canvas (loaded only in the recharge chunk). */
export function QrCanvas(props: { value: string; size?: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !props.value) return;
    void QRCode.toCanvas(canvas, props.value, { width: props.size ?? 220, margin: 1 }).catch(() => {
      // Canvas draw failure: the browser-open fallback remains available.
    });
  }, [props.value, props.size]);

  return <canvas ref={canvasRef} className="rounded-xl bg-white p-2" />;
}
