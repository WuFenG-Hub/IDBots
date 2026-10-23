import type { ReactNode } from 'react';

/** Titled section card shared by the Me and Tasks screens. */
export function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-[var(--text-primary)]">{props.title}</h2>
      {props.children}
    </section>
  );
}
