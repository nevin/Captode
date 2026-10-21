// A tiny TrueType font for the tests, made here so no font file needs shipping: every
// printable ASCII character is the same solid box. Text in it is unmistakable in pixels.

const u16 = (v) => [(v >> 8) & 255, v & 255];
const i16 = (v) => u16(v < 0 ? v + 65536 : v);
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function utf16(s) {
  return [...s].flatMap((c) => u16(c.charCodeAt(0)));
}

/** The font file, as bytes. */
export function boxFont(family = 'Captode Box') {
  const tables = {};
  tables.head = [
    ...u32(0x00010000), ...u32(0x00010000), ...u32(0), ...u32(0x5f0f3cf5), ...u16(0x000b), ...u16(1000),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), // created, modified
    ...i16(0), ...i16(0), ...i16(750), ...i16(700), // bounds
    ...u16(0), ...u16(8), ...i16(2), ...i16(0), ...i16(0), // macStyle, lowest size, direction, short loca, glyph format
  ];
  tables.hhea = [
    ...u32(0x00010000), ...i16(800), ...i16(-200), ...i16(0), ...u16(800), ...i16(0), ...i16(0), ...i16(750),
    ...i16(1), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...u16(2),
  ];
  tables.maxp = [...u32(0x00010000), ...u16(2), ...u16(4), ...u16(1), 0, 0, 0, 0, ...u16(2), ...Array(16).fill(0)];
  tables.hmtx = [...u16(500), ...i16(0), ...u16(800), ...i16(50)];
  // Glyph 0 is empty; glyph 1 the box, (50, 0) to (750, 700), clockwise.
  const box = [
    ...i16(1), ...i16(50), ...i16(0), ...i16(750), ...i16(700), ...u16(3), ...u16(0),
    1, 1, 1, 1, // on the curve, two-byte coordinates
    ...i16(50), ...i16(0), ...i16(700), ...i16(0),
    ...i16(0), ...i16(700), ...i16(0), ...i16(-700),
  ];
  tables.glyf = box;
  tables.loca = [...u16(0), ...u16(0), ...u16(box.length / 2)];
  // Characters 0x20 to 0x7E are all glyph 1, through a glyph table (a plain offset
  // would give each the next glyph).
  const chars = 0x7e - 0x20 + 1;
  tables.cmap = [
    ...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12),
    ...u16(4), ...u16(32 + chars * 2), ...u16(0), ...u16(4), ...u16(4), ...u16(1), ...u16(0),
    ...u16(0x7e), ...u16(0xffff), ...u16(0), ...u16(0x20), ...u16(0xffff), ...i16(0), ...i16(1), ...u16(4), ...u16(0),
    ...Array(chars).fill(0).flatMap(() => u16(1)),
  ];
  tables['OS/2'] = [
    ...u16(3), ...i16(800), ...u16(400), ...u16(5), ...u16(0),
    ...Array(10).fill(0).flatMap(() => i16(0)), ...i16(0), ...Array(10).fill(0), ...Array(16).fill(0), ...[67, 65, 80, 84],
    ...u16(0x40), ...u16(0x20), ...u16(0x7e), ...i16(800), ...i16(-200), ...i16(0), ...u16(800), ...u16(200),
    ...u32(1), ...u32(0), ...i16(500), ...i16(700), ...u16(0), ...u16(0x20), ...u16(1),
  ];
  const names = [[1, family], [2, 'Regular'], [4, family], [6, family.replace(/\s/g, '')]];
  let strings = [];
  const records = names.flatMap(([id, text]) => {
    const bytes = utf16(text);
    const r = [...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(bytes.length), ...u16(strings.length)];
    strings = strings.concat(bytes);
    return r;
  });
  tables.name = [...u16(0), ...u16(names.length), ...u16(6 + 12 * names.length), ...records, ...strings];
  tables.post = [...u32(0x00030000), ...u32(0), ...i16(-100), ...i16(50), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)];

  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = [...u32(0x00010000), ...u16(n), ...u16(pow * 16), ...u16(Math.log2(pow)), ...u16(n * 16 - pow * 16)];
  let offset = 12 + n * 16;
  const dir = [];
  const body = [];
  for (const tag of tags) {
    const data = tables[tag];
    const padded = [...data, ...Array((4 - (data.length % 4)) % 4).fill(0)];
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3])) >>> 0;
    dir.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(sum), ...u32(offset), ...u32(data.length));
    body.push(...padded);
    offset += padded.length;
  }
  return Uint8Array.from([...header, ...dir, ...body]);
}
