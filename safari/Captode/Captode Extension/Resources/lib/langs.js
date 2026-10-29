// Language codes as video files name them: ISO 639-2 (three letters), from a tag
// such as 'fr' or 'zh-Hant'. MP4 uses the "T" codes; WebM's older field, the "B" ones.

const T = {
  ar: 'ara', bn: 'ben', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', fa: 'fas', fi: 'fin',
  fr: 'fra', he: 'heb', hi: 'hin', hu: 'hun', id: 'ind', it: 'ita', ja: 'jpn', ko: 'kor', ml: 'mal', mr: 'mar',
  ms: 'msa', nl: 'nld', no: 'nor', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus', sv: 'swe', ta: 'tam', te: 'tel',
  th: 'tha', tr: 'tur', uk: 'ukr', ur: 'urd', vi: 'vie', zh: 'zho',
};
const B = { ces: 'cze', deu: 'ger', ell: 'gre', fas: 'per', fra: 'fre', msa: 'may', nld: 'dut', ron: 'rum', zho: 'chi' };

/** The three-letter code for `tag` ('und' when unknown); `b`: the bibliographic form. */
export function iso639(tag, b = false) {
  const base = String(tag || '').split('-')[0].toLowerCase();
  const t = T[base] || (/^[a-z]{3}$/.test(base) ? base : 'und');
  return b ? B[t] || t : t;
}
