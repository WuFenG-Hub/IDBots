import type { ReactNode } from 'react';
import { useNativeBackHandler } from '../hooks/useNativeBackHandler';

/**
 * Bottom sheet used by the chat permission request and the Me screen's
 * confirm/form sheets. Renders above the tab bar with a backdrop tap to
 * dismiss (when dismissable).
 */
export function BottomSheet(props: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
}): JSX.Element {
  useNativeBackHandler(() => {
    props.onClose?.();
    return true;
  }, true, 100);
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label={props.title}
        className="absolute inset-0 bg-black/40"
        onClick={props.onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-label={props.title}
        className="relative max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-[var(--border-color)] bg-[var(--bg-panel)] px-4 pt-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{props.title}</h2>
          {props.onClose ? (
            <button
              type="button"
              onClick={props.onClose}
              className="min-h-[44px] min-w-[44px] px-2 text-sm text-[var(--text-secondary)] active:text-[var(--text-primary)]"
            >
              {'✕'}
            </button>
          ) : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}
