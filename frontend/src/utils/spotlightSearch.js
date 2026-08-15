const TURKISH_ASCII_EQUIVALENTS = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u'
};

export function normalizeSpotlightText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşü]/g, (character) => TURKISH_ASCII_EQUIVALENTS[character])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function spotlightItemScore(item, normalizedQuery) {
  const title = normalizeSpotlightText(item.title);
  const subtitle = normalizeSpotlightText(item.subtitle);
  const keywords = normalizeSpotlightText(
    Array.isArray(item.keywords) ? item.keywords.join(' ') : item.keywords
  );
  const searchable = `${title} ${subtitle} ${keywords}`.trim();
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);

  if (!queryTokens.every((token) => searchable.includes(token))) return null;
  if (title === normalizedQuery) return 0;
  if (title.startsWith(normalizedQuery)) return 10;
  if (title.split(' ').some((word) => word.startsWith(normalizedQuery))) return 20;
  if (title.includes(normalizedQuery)) return 30;
  if (keywords.includes(normalizedQuery)) return 40;
  if (subtitle.includes(normalizedQuery)) return 50;

  const titleTokenMatches = queryTokens.filter((token) => title.includes(token)).length;
  const keywordTokenMatches = queryTokens.filter((token) => keywords.includes(token)).length;
  return 60 - Math.min(20, (titleTokenMatches * 6) + (keywordTokenMatches * 2));
}

export function searchSpotlightItems(items, query, limit = 9) {
  const normalizedQuery = normalizeSpotlightText(query);
  const boundedLimit = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 9);

  if (!normalizedQuery) {
    return items
      .filter((item) => item.featured)
      .sort((left, right) => (left.priority || 999) - (right.priority || 999))
      .slice(0, boundedLimit);
  }

  return items
    .map((item, index) => ({
      item,
      index,
      score: spotlightItemScore(item, normalizedQuery)
    }))
    .filter((candidate) => candidate.score !== null)
    .sort((left, right) => (
      left.score - right.score ||
      (left.item.priority || 999) - (right.item.priority || 999) ||
      left.index - right.index
    ))
    .slice(0, boundedLimit)
    .map((candidate) => candidate.item);
}
