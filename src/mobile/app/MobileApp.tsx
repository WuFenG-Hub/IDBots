import { t } from '../i18n';
import { ConnectionBadge } from './components/ConnectionBadge';
import { ChatDemo } from './components/ChatDemo';
import { PlansDemo } from './components/PlansDemo';
import { SectionCard } from './components/SectionCard';
import { TaskDemo } from './components/TaskDemo';

/**
 * T1 demo shell (throwaway quality on purpose): one stacked page proving the
 * mock bridge renders fake data for every REQ-E-8 scenario. Real screens
 * (tabs, Chat/Tasks/Square/Me) replace this in T2.
 */
export default function MobileApp(): JSX.Element {
  return (
    <div
      className="min-h-dvh bg-[var(--bg-main)] text-[var(--text-primary)]"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-4 py-3">
        <h1 className="text-lg font-semibold">{t('mobile.demo.title')}</h1>
        <ConnectionBadge />
      </header>
      <main className="mx-auto flex max-w-md flex-col gap-4 p-4">
        <SectionCard title={t('mobile.demo.chatTitle')}>
          <ChatDemo />
        </SectionCard>
        <SectionCard title={t('mobile.demo.tasksTitle')}>
          <TaskDemo />
        </SectionCard>
        <SectionCard id="plans-demo" title={t('mobile.demo.plansTitle')}>
          <PlansDemo />
        </SectionCard>
      </main>
    </div>
  );
}
