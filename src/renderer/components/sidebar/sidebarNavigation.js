// Feature flag: the Group Tasks nav entry (and everything behind it) stays
// implemented. This is currently enabled for Group Task testing; set to
// `false` to hide the link on the Bot home page before a public release.
const GROUP_TASKS_NAV_ENABLED = true;

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
