import type { ReactNode } from 'react';

/** Shared card shell for the T1 demo sections. */
export function SectionCard(props: { title: string; children: ReactNode; id?: string }): JSX.Element {
  return (
    <section id={props.id} className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-[var(--text-primary)]">{props.title}</h2>
      {props.children}
    </section>
  );
}
