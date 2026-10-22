import { useEffect, useState } from 'react';

/**
 * On-screen keyboard inset from visualViewport (REQ-E-11): the composer sits
 * above the keyboard by padding its container with the viewport shrink
 * amount. Returns 0 on desktops and whenever the keyboard is closed.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const compute = () => {
      const shrink = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(Math.max(0, Math.round(shrink)));
    };
    compute();
    viewport.addEventListener('resize', compute);
    viewport.addEventListener('scroll', compute);
    return () => {
      viewport.removeEventListener('resize', compute);
      viewport.removeEventListener('scroll', compute);
    };
  }, []);

  return inset;
}
