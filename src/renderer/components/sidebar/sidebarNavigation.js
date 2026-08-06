// Feature flag: Group Tasks is not yet ready for public release. The nav entry
// (and everything behind it) stays implemented; flipping this to `true`
// re-exposes the link on the Bot home page once the feature matures.
const GROUP_TASKS_NAV_ENABLED = false;

export function getSidebarPrimaryNavModel({ t, hasRunningScheduledTask }) {
  return [
    {
      id: 'scheduledTasks',
      label: t('scheduledTasks'),
      icon: 'clock',
      hasIndicator: Boolean(hasRunningScheduledTask),
    },
    {
      id: 'groupTasks',
      label: t('groupTasks'),
      icon: 'userGroup',
      hidden: !GROUP_TASKS_NAV_ENABLED,
    },
    {
      id: 'gigSquare',
      label: t('gigSquare'),
      icon: 'shoppingBag',
      badge: t('gigSquareAlphaBadge'),
    },
    {
      id: 'metaapps',
      label: t('metaApps'),
      icon: 'squares2x2',
    },
    {
      id: 'metabots',
      label: t('metabots'),
      icon: 'cpuChip',
    },
  ];
}
