function isWordCharacter(character) {
  return Boolean(character) && /[\p{L}\p{N}_]/u.test(character);
}

function normalizeText(text) {
  return String(text).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function censorText(text, terms, replacement = '█') {
  const source = String(text ?? '');
  if (!source || !Array.isArray(terms) || !terms.length) return source;

  const normalizedSource = normalizeText(source);
  const ranges = [];
  for (const rawTerm of terms) {
    const term = String(rawTerm ?? '').trim();
    if (!term) continue;
    const needle = normalizeText(term);
    let from = 0;
    while (from <= normalizedSource.length - needle.length) {
      const index = normalizedSource.indexOf(needle, from);
      if (index < 0) break;
      const end = index + needle.length;
      const startsAsWord = isWordCharacter(needle[0]);
      const endsAsWord = isWordCharacter(needle.at(-1));
      const leftOkay = !startsAsWord || !isWordCharacter(normalizedSource[index - 1]);
      const rightOkay = !endsAsWord || !isWordCharacter(normalizedSource[end]);
      if (leftOkay && rightOkay) ranges.push([index, end]);
      from = Math.max(index + 1, end);
    }
  }

  if (!ranges.length) return source;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }

  let result = '';
  let position = 0;
  for (const [start, end] of merged) {
    result += source.slice(position, start);
    result += [...source.slice(start, end)]
      .map((character) => /\s/u.test(character) ? character : replacement)
      .join('');
    position = end;
  }
  return result + source.slice(position);
}

export function censorTelegramMessage(message, terms) {
  return {
    ...message,
    ...(typeof message.text === 'string' ? { text: censorText(message.text, terms) } : {}),
    ...(typeof message.caption === 'string' ? { caption: censorText(message.caption, terms) } : {})
  };
}
