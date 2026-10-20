// File names for downloads, from a pattern chosen in Settings: {title}, {site},
// {date} and {time} are filled in, and anything a file system won't take is replaced.

export const DEFAULT_FILE_NAME = 'captode-{title}-{date}-{time}';
export const FILE_NAME_TOKENS = ['{title}', '{site}', '{date}', '{time}'];

const slug = (s, max) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');

/**
 * A file name without its extension. `title` and `url` are the page's; `when` the
 * moment of the capture (local time). Empty parts drop out with their separator.
 */
export function fileStem(pattern, { title = '', url = '', when = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  let site = '';
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const values = {
    title: slug(title, 40),
    site: slug(site.replace(/\./g, '-'), 40),
    date: `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`,
    time: `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`,
  };
  const name = (pattern || DEFAULT_FILE_NAME).trim()
    .replace(/\{(title|site|date|time)\}/g, (_, k) => values[k])
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    // Separators left beside an empty part, doubled or at either end.
    .replace(/([-_ .])[-_ .]+/g, '$1').replace(/^[-_ .]+|[-_ .]+$/g, '')
    .slice(0, 120);
  return name || 'captode';
}
