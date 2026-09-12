// Feature flag: the Group Tasks nav entry (and everything behind it) stays
// implemented. This is currently enabled for Group Task testing; set to
// `false` to hide the link on the Bot home page before a public release.
const GROUP_TASKS_NAV_ENABLED = true;

// Feature flag: the Bot Hub (gigSquare) nav entry and everything behind it
// stay implemented; Bot Hub is just not a promoted column for now. Set to
// `true` to restore the entry on the Bot Internet page.
const BOT_HUB_NAV_ENABLED = false;

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
      id: 'metabots',
      label: t('metabots'),
      icon: 'cpuChip',
    },
  ];
}

export function getSidebarInternetNavModel({ t }) {
  return [
    {
      id: 'browser',
      label: t('botBrowser'),
      icon: 'globe',
    },
    {
      id: 'gigSquare',
      label: t('gigSquare'),
      icon: 'shoppingBag',
      badge: t('gigSquareAlphaBadge'),
      hidden: !BOT_HUB_NAV_ENABLED,
    },
    {
      id: 'metaapps',
      label: t('metaApps'),
      icon: 'squares2x2',
    },
  ];
}

export function isBotBrowserPaneVisible(surfaceMode, internetPane) {
  return surfaceMode === 'browser' && internetPane === 'browser';
}
