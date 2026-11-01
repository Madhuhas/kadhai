import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { readDocument, isKnownBinary } from '../src/core/fileText.js';
import { createEngine } from '../src/core/engine.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { chatCompletion } from '../src/core/providers.js';
import { anthropicCompletion } from '../src/core/anthropic.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];
const SEEING_PROVIDER = [{ id: 'eyes', label: 'Eyes', baseUrl: 'x', keys: ['k'], models: ['see'], vision: true }];

// ------------------------------------------------------------ building test files

/**
 * A small PDF. Each object is a string (its body) or { dict, stream } (stream: Buffer or string,
 * `deflate: true` to compress it). Objects are numbered from 1 in the order given.
 */
function makePdf(objects, { trailer = '/Root 1 0 R' } = {}) {
  // Strings take the number of their place; a stream may name its own (`num`), for objects kept in an object stream.
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objects.forEach((obj, i) => {
    if (typeof obj === 'string') {
      chunks.push(Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1'));
      return;
    }
    let data = Buffer.isBuffer(obj.stream) ? obj.stream : Buffer.from(obj.stream, 'latin1');
    let dict = obj.dict;
    if (obj.deflate) {
      data = zlib.deflateSync(data);
      dict += ' /Filter /FlateDecode';
    }
    chunks.push(Buffer.from(`${obj.num ?? i + 1} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  chunks.push(Buffer.from(`trailer\n<< ${trailer} /Size ${objects.length + 1} >>\nstartxref\n0\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip file of { name: text }, deflated like Office saves them. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc32(data), 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const helvetica = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

function resumePdf() {
  const content = [
    'BT /F1 18 Tf 72 720 Td (Jane Doe) Tj ET',
    'BT /F1 11 Tf 72 700 Td (Software Engineer \\(Node\\) \\223caf\\351\\224) Tj',
    '0 -14 Td [(Built)-320(APIs)] TJ',
    // Words placed one by one at the same height: a gap between them is a space.
    '0 -14 Td (Skills:) Tj 60 0 Td (Express) Tj ET',
  ].join('\n');
  return makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    helvetica,
    { dict: '', stream: content },
  ]);
}

// ------------------------------------------------------------ PDF

test('pdf: text from a simple PDF, with its lines, escapes, accents and the gaps that are spaces', () => {
  const read = readDocument('resume.pdf', resumePdf());
  assert.equal(read.format, 'PDF');
  assert.equal(read.problem, undefined);
  assert.equal(read.pages, 1);
  const lines = read.text.split('\n');
  assert.equal(lines[0], 'Jane Doe');
  assert.equal(lines[1], 'Software Engineer (Node) \u201Ccaf\u00E9\u201D', 'octal escapes are WinAnsi: curly quotes and an accent');
  assert.equal(lines[2], 'Built APIs', 'a big gap inside TJ is a space');
  assert.equal(lines[3], 'Skills: Express', 'words placed apart on one line are spaced');
});

test('pdf: compressed pages are read in page-tree order, with resources inherited from the tree', () => {
  const page = (text) => ({ dict: '', stream: `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`, deflate: true });
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    // The second page's object comes first in the file: the tree's order wins.
    '<< /Type /Pages /Kids [4 0 R 3 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    page('First page'),
    page('Second page'),
    helvetica,
  ]);
  const read = readDocument('two.pdf', pdf);
  assert.equal(read.pages, 2);
  assert.match(read.text, /--- page 1 ---\nFirst page\n\n--- page 2 ---\nSecond page/);
});

test('pdf: a Type0 font with a ToUnicode map, kept in a compressed object stream (how Word and Canva save)', () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <004A> <0005> <00200041> endbfchar',
    '1 beginbfrange <0002> <0004> <0061> endbfrange',
    'endcmap end end',
  ].join('\n');
  // Objects 4 (the font) and 5 (its descendant) live inside object stream 8.
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Calibri /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>';
  const descendant = '<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [500 500 500 500 500]] >>';
  const packed = `4 0 5 ${font.length + 1}\n${font}\n${descendant}`;
  const first = packed.indexOf('<<');
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    { dict: '', stream: cmap, deflate: true, num: 6 },
    { dict: '', stream: 'BT /F1 12 Tf 72 700 Td <000100020003000400050002> Tj ET', deflate: true, num: 7 },
    { dict: `/Type /ObjStm /N 2 /First ${first}`, stream: packed, deflate: true, num: 8 },
  ]);
  const read = readDocument('word.pdf', pdf);
  assert.equal(read.problem, undefined, read.problem);
  assert.equal(read.text, 'Jabc Aa', 'bfchar, bfrange and a two-letter mapping, two bytes a code');
});

test('pdf: /Differences renames codes; ligatures come out as letters', () => {
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /Differences [65 /quoteright /bullet /fi /uni2192] >> >>',
    { dict: '', stream: 'BT /F1 12 Tf 72 700 Td (itAs B Cle D) Tj ET' },
  ]);
  assert.equal(readDocument('x.pdf', pdf).text, 'it\u2019s \u2022 file \u2192');
});

test('pdf: a protected PDF, and one with no pages, say why instead of returning nothing', () => {
  const locked = makePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 >>'], { trailer: '/Root 1 0 R /Encrypt 3 0 R' });
  assert.match(readDocument('locked.pdf', locked).problem, /protected \(encrypted\)/);
  const empty = makePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']);
  assert.match(readDocument('empty.pdf', empty).problem, /no pages were found/);
});

test('pdf: a scanned page hands on its picture - a JPEG as it is, raw grey samples as a PNG', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>',
    { dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', stream: jpeg },
    { dict: '', stream: 'q 600 0 0 800 0 0 cm /Im1 Do Q' },
    // Named by a colour profile, as Edge and scanner apps do, not as /DeviceGray.
    { dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace [/ICCBased 8 0 R] /BitsPerComponent 8', stream: Buffer.from([0, 255, 255, 0]), deflate: true },
    { dict: '/N 1', stream: 'profile' },
  ]);
  const read = readDocument('scan.pdf', pdf);
  assert.equal(read.text, '');
  assert.equal(read.problem, undefined, 'a scan is not a failure here: its pictures are handed on');
  assert.deepEqual(read.images.map((i) => [i.mime, i.page]), [['image/jpeg', 1], ['image/png', 2]]);
  assert.deepEqual([...read.images[0].data], [...jpeg], 'the JPEG is passed on byte for byte');
  assert.deepEqual([...read.images[1].data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// ------------------------------------------------------------ Office, OpenDocument, others

test('office: Word, Excel and PowerPoint files come out as text', () => {
  const docx = makeZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml':
      '<w:document><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Jane</w:t></w:r><w:r><w:t xml:space="preserve"> Doe</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Role</w:t><w:tab/><w:t>Engineer &amp; lead</w:t><w:br/><w:t>Next line</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<w:hdr><w:p><w:r><w:t>CV</w:t></w:r></w:p></w:hdr>',
  });
  const word = readDocument('cv.docx', docx);
  assert.equal(word.format, 'Word document');
  assert.equal(word.text, 'CV\nJane Doe\nRole\tEngineer & lead\nNext line', 'a tab-stop definition is not a tab');

  const xlsx = makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><r><t>Co</t></r><r><t>st</t></r></si><si><t>Rent</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><v>1200.5</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Note</t></is></c><c r="B3" s="1"/></row></sheetData></worksheet>',
  });
  const sheet = readDocument('budget.xlsx', xlsx);
  assert.equal(sheet.format, 'Excel workbook');
  assert.equal(sheet.text, '--- sheet: Budget ---\nItem\t\tCost\nRent\tTRUE\t1200.5\nNote', 'cells keep their columns; rich text is joined');

  const pptx = makeZip({
    'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Hello</a:t></a:r><a:r><a:t> deck</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>',
  });
  const deck = readDocument('talk.pptx', pptx);
  assert.equal(deck.pages, 2);
  assert.equal(deck.text, '--- slide 1 ---\nHello deck\nPoint\n\n--- slide 2 ---\nLast', 'slides in number order, not name order');
});

test('found in real files: table rows stay rows, TeX accents join their letter, an unmapped bullet keeps its line break', () => {
  // Pandoc's .docx and .pptx: one paragraph per cell, which came out one cell per line.
  const docx = makeZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>Skills</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>SQL</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5 &amp; more</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:trPr/><w:tc><w:p><w:r><w:t>Python</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
  assert.equal(readDocument('t.docx', docx).text, 'Skills\nSQL\t5 & more\nPython\t4');
  const pptx = makeZip({ 'ppt/slides/slide1.xml': '<p:sld><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Year</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Sales</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:sld>' });
  assert.equal(readDocument('t.pptx', pptx).text, '--- slide 1 ---\nYear\tSales');
  // Pandoc's .odt is indented: the indentation is not text.
  const odt = makeZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:text>\n  <text:p>One</text:p>\n  <table:table>\n    <table:table-row>\n      <table:table-cell><text:p>a</text:p></table:table-cell>\n      <table:table-cell/>\n      <table:table-cell><text:p>c</text:p></table:table-cell>\n    </table:table-row>\n  </table:table>\n</office:text>' });
  assert.equal(readDocument('t.odt', odt).text, 'One\na\t\tc');

  // pdfLaTeX with its standard fonts: an accent printed before its letter, and an itemize bullet whose glyph maps to nothing.
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /CMR10 /FirstChar 0 /Widths [500] /Encoding << /Differences [1 /acute] >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /CMSY10 /Encoding << /Differences [15 /a15] >> >>',
    { dict: '', stream: 'BT /F1 10 Tf 72 700 Td [(R)-10(\\001)-400(esum)-10(\\001)-400(e)] TJ ET\nBT /F2 10 Tf 80 680 Td (\\017) Tj /F1 10 Tf 10 0 Td (Analyst) Tj ET' },
  ]);
  assert.equal(readDocument('tex.pdf', pdf).text, 'R\u00E9sum\u00E9\nAnalyst');
});

test('other formats: OpenDocument and UTF-16 text are read; old Office files, zips and unknown bytes say why not', () => {
  const odt = makeZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:text><text:h>Title</text:h><text:p>One<text:s/>two</text:p></office:text>' });
  const read = readDocument('notes.odt', odt);
  assert.equal(read.format, 'OpenDocument text');
  assert.equal(read.text, 'Title\nOne two');

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('h\u00E9llo', 'utf16le')]);
  assert.equal(readDocument('notepad.txt', utf16).text, 'h\u00E9llo');

  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.match(readDocument('old.doc', ole).problem, /old Office format/);
  assert.match(readDocument('code.zip', makeZip({ 'a.js': 'x' })).problem, /zip archive/);
  assert.match(readDocument('blob.bin', Buffer.from([1, 0, 2, 0])).problem, /not a format that can be read here/);
});

test('workspace: a PDF counts as binary even when its first bytes are all plain ASCII', async (t) => {
  const dir = await tmpDir('ascii-pdf');
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion: async () => reply('{}'), mcp: false });
  t.after(() => engine.close());
  const pdf = makePdf(['<< /Type /Catalog >>']);
  await fs.writeFile(path.join(dir, 'plain.pdf'), Buffer.from(pdf.toString('latin1').replace(/[^\x20-\x7e\n]/g, 'x'), 'latin1'));
  assert.equal((await engine.workspace.readFile('plain.pdf')).binary, true);
  assert.ok(isKnownBinary(Buffer.from('%PDF-1.4')));
  assert.ok(!isKnownBinary(Buffer.from('# a note about %PDF-1.4')));
});

// ------------------------------------------------------------ in a run

test('attachments: a PDF is read for the Chef, named as read-only, and the user is told how it was read', async (t) => {
  const dir = await tmpDir('attach-pdf');
  let managerPrompt = '';
  const completion = async (_route, req, { role }) => {
    assert.ok(!req.images, 'no picture: no model is asked to look');
    if (role === 'manager') {
      managerPrompt = req.messages.at(-1).content;
      return reply(JSON.stringify({ objective: 'answer', reply: 'Jane is a software engineer.', subtasks: [] }));
    }
    return reply('{}');
  };
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  await engine.workspace.writeFile('attachments/resume.pdf', resumePdf(), { owner: 'user' });
  const result = await engine.orchestrator.start('who is this?', { attachments: ['attachments/resume.pdf'] }).done;
  assert.equal(result.ok, true, result.reply);
  assert.match(managerPrompt, /### attachments\/resume\.pdf \(PDF: what was read from it is below; the file itself cannot be edited\)/);
  assert.match(managerPrompt, /Jane Doe\nSoftware Engineer \(Node\)/);
  const told = engine.orchestrator.chat.find((m) => /attachments that are not plain text/.test(m.text));
  assert.match(told.text, /- \*\*attachments\/resume\.pdf\*\*: PDF, read$/);
});

test('attachments: an image is written down once by a model that can see, within the run\'s limit', async (t) => {
  const dir = await tmpDir('attach-image');
  const looks = [];
  let managerPrompt = '';
  const completion = async (route, req, { role }) => {
    if (req.images) {
      assert.equal(route.vision, true);
      looks.push(req.images[0]);
      return reply(`# Portfolio sketch ${looks.length}\nA header with a name and three project cards.`);
    }
    if (role === 'manager') {
      managerPrompt = req.messages.at(-1).content;
      return reply(JSON.stringify({ objective: 'answer', reply: 'Seen.', subtasks: [] }));
    }
    return reply('{}');
  };
  const engine = await createEngine({ workspaceDir: dir, providers: [...FAKE_PROVIDER, ...SEEING_PROVIDER], completion, mcp: false, limits: { execMode: 'off', imageReads: 1 } });
  t.after(() => engine.close());
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await engine.workspace.writeFile('attachments/sketch.png', png, { owner: 'user' });
  await engine.workspace.writeFile('attachments/second.png', Buffer.concat([png, Buffer.from([1])]), { owner: 'user' });

  await engine.orchestrator.start('build this', { attachments: ['attachments/sketch.png', 'attachments/second.png'] }).done;
  assert.equal(looks.length, 1, 'the flame allows one picture a run here');
  assert.equal(looks[0].mime, 'image/png');
  assert.equal(looks[0].data, png.toString('base64'));
  assert.match(managerPrompt, /### attachments\/sketch\.png \(image: [^\n]*\n```\n# Portfolio sketch 1/);
  assert.match(managerPrompt, /attachments\/second\.png[\s\S]*not read: one picture was not read: a run reads at most 1/);
  const told = engine.orchestrator.chat.filter((m) => /attachments that are not plain text/.test(m.text)).at(-1);
  assert.match(told.text, /sketch\.png\*\*: image, read, its picture written down by a model that can see \(one call\)/);

  // Attached again: the first is remembered, the second gets its turn.
  await engine.orchestrator.start('again', { attachments: ['attachments/sketch.png', 'attachments/second.png'] }).done;
  assert.equal(looks.length, 2, 'only the picture not read before is looked at');
  assert.match(managerPrompt, /# Portfolio sketch 1[\s\S]*# Portfolio sketch 2/);
});

test('attachments: with no model that can see, an image is named with what to do, and nothing is sent', async (t) => {
  const dir = await tmpDir('attach-blind');
  let managerPrompt = '';
  const completion = async (_route, req, { role }) => {
    assert.ok(!req.images, 'a model that cannot see is never sent a picture');
    if (role === 'manager') managerPrompt = req.messages.at(-1).content;
    return reply(JSON.stringify({ objective: 'answer', reply: 'ok', subtasks: [] }));
  };
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  await engine.workspace.writeFile('attachments/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), { owner: 'user' });
  await engine.orchestrator.start('what is in it?', { attachments: ['attachments/photo.jpg'] }).done;
  assert.match(managerPrompt, /photo\.jpg \(image[^\n]*\n```\n\(not read: No model that can look at images is set up\. A free Gemini key can/);
  assert.match(engine.orchestrator.chat.find((m) => /not plain text/.test(m.text)).text, /photo\.jpg\*\*: not read - No model that can look at images/);
});

test('a cook never overwrites a PDF it was shown as text', async (t) => {
  const dir = await tmpDir('keep-pdf');
  let cookRounds = 0;
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'portfolio', subtasks: [{ title: 'Portfolio', instructions: 'make a page from the resume', files: ['attachments/resume.pdf', 'index.html'], level: 'simple' }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookRounds += 1;
    if (cookRounds === 1) return reply('<<<FILE attachments/resume.pdf>>>\nJane Doe\n<<<END>>>\nSUMMARY: rewrote the resume');
    assert.match(req.messages.at(-1).content, /resume\.pdf is not a text file[\s\S]*NOT overwritten/);
    return reply('<<<FILE index.html>>>\n<h1>Jane Doe</h1>\n<<<END>>>\nSUMMARY: made the page');
  };
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const pdf = resumePdf();
  await engine.workspace.writeFile('attachments/resume.pdf', pdf, { owner: 'user' });
  const result = await engine.orchestrator.start('make a portfolio', { attachments: ['attachments/resume.pdf'] }).done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual(await fs.readFile(path.join(dir, 'attachments/resume.pdf')), pdf, 'the PDF is untouched');
  assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /Jane Doe/);
});

// ------------------------------------------------------------ routes and wire formats

test('dispatcher: a request with images goes only to a route that can see, and says so when none can', async () => {
  const used = [];
  const completion = async (route) => {
    used.push(route.id);
    return reply('ok');
  };
  const config = { limits: { maxOutputTokens: 100, requestTimeoutMs: 1000, maxRateWaitMs: 0 } };
  const both = new Dispatcher({ config: { ...config, providers: [...FAKE_PROVIDER, ...SEEING_PROVIDER] }, completion });
  await both.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await both.chat({ messages: [{ role: 'user', content: 'look' }], images: [{ mime: 'image/png', data: 'AA==' }] }, { prefer: 'fake/m' });
  assert.deepEqual(used, ['fake/m', 'eyes/see'], 'a preferred model that cannot see is passed over for a picture');
  assert.equal(both.status().routes.find((r) => r.id === 'eyes/see').vision, true);

  const blind = new Dispatcher({ config: { ...config, providers: FAKE_PROVIDER }, completion });
  await assert.rejects(blind.chat({ messages: [{ role: 'user', content: 'look' }], images: [{ mime: 'image/png', data: 'AA==' }] }), (err) => err.code === 'NO_VISION');
  const cli = Dispatcher.buildRoutes([{ id: 'claude-code', label: 'Claude Code', kind: 'cli', keys: [''], models: ['default'], vision: true }]);
  assert.equal(cli[0].vision, false, 'a CLI runs with its tools off: it is never sent a picture');
});

test('wire formats: images ride on the last user message, as image_url parts and as Claude image blocks', async (t) => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => (globalThis.fetch = realFetch));
  const req = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'what is this?' }], maxTokens: 100, images: [{ mime: 'image/jpeg', data: 'QUJD' }] };
  await chatCompletion({ id: 'g', label: 'G', baseUrl: 'https://example.invalid', key: 'k', model: 'm' }, req, { timeoutMs: 1000 }).catch(() => {});
  await anthropicCompletion({ id: 'a', label: 'A', baseUrl: 'https://example.invalid', key: 'k', model: 'claude' }, req, { timeoutMs: 1000 }).catch(() => {});
  assert.deepEqual(bodies[0].messages[1].content, [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]);
  assert.equal(bodies[0].messages[0].content, 'sys', 'the system prompt stays text');
  assert.deepEqual(bodies[1].messages.at(-1).content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }, { type: 'text', text: 'what is this?' }]);
  assert.equal(req.messages[1].content, 'what is this?', 'the request itself is not changed');
});
