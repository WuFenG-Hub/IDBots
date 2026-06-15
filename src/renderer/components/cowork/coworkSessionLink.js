export const buildCoworkSessionLink = (sessionId) => {
  if (typeof sessionId !== 'string') {
    return '';
  }

  const trimmed = sessionId.trim();
  if (!trimmed) {
    return '';
  }

  return `IDBots://${trimmed}`;
};

export const copyCoworkSessionLinkToClipboard = (sessionId, clipboard) => {
  const link = buildCoworkSessionLink(sessionId);
  if (!link || typeof clipboard?.writeText !== 'function') {
    return false;
  }

  try {
    const result = clipboard.writeText(link);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
};
