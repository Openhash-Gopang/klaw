/*!
 * klaw-attach.js — 사건 개요 입력란의 "파일 첨부" 공용 모듈 (2026-11-10 신설)
 *
 * 파일을 서버로 올리지 않고 브라우저 안에서 글자만 뽑아 사건 개요 입력란에 추가한다.
 * 확장자가 달라도 파일의 첫 바이트(매직 넘버)로 형식을 다시 확인하므로, 이름이 잘못 붙은 파일도 읽는다.
 *
 * 지원 형식
 *   텍스트류   txt md markdown csv tsv log json jsonl xml yaml yml ini toml tex rst srt vtt smi 등 (UTF-8·UTF-16·CP949 자동 판별)
 *   웹·메일    html htm xhtml mhtml eml
 *   서식 문서  rtf docx docm dotx dotm doc odt ott fodt hwpx hwp hml epub
 *   표         xlsx xlsm xlsb xls ods csv tsv
 *   발표       pptx pptm ppsx ppt odp
 *   PDF        글자가 있는 PDF는 그대로, 스캔본은 OCR(한국어+영어)
 *   이미지     jpg png gif bmp webp tif — OCR(한국어+영어)
 *   묶음       zip (안의 문서를 각각 읽음)
 *
 * 외부 라이브러리는 필요한 형식을 읽을 때에만 CDN에서 불러온다.
 *
 * 공개 API
 *   KLawAttach.readFile(file, {onProgress}) → Promise<{text, kind, notes}>
 *   KLawAttach.handleInput(inputEl, {textarea, list, render, status, maxChars})   // <input type=file> onchange 용
 *   KLawAttach.removeBlock(list, idx, textarea)
 *   KLawAttach.HINT   // 안내 문구
 */
(function (root) {
  'use strict';

  var MAX_BYTES = 30 * 1024 * 1024;
  var MAX_CHARS = 50000;
  var OCR_MAX_PAGES = 15;
  var ZIP_MAX_FILES = 30;
  var ZIP_MAX_DEPTH = 2;

  var CDN = {
    jszip:     'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    mammoth:   'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
    xlsx:      'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    pdfjs:     'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    pako:      'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js'
  };
  var GLOBALS = { jszip: 'JSZip', mammoth: 'mammoth', xlsx: 'XLSX', pdfjs: 'pdfjsLib', tesseract: 'Tesseract', pako: 'pako' };

  var HINT = 'txt · md · docx · hwp · hwpx · pdf · xlsx · pptx · rtf · html · zip 등 대부분의 문서와 이미지(글자 인식)를 읽어 위 입력란에 추가합니다. 파일 자체는 올라가지 않으며, 추가된 내용은 직접 고칠 수 있습니다. 개인정보는 가린 뒤 첨부하세요.';

  var api = { libs: {}, HINT: HINT, MAX_BYTES: MAX_BYTES, MAX_CHARS: MAX_CHARS };

  // ── 라이브러리 로더 (테스트에서는 api.libs로 주입) ─────────────────────
  var scriptCache = {};
  function loadScript(url) {
    if (!scriptCache[url]) {
      scriptCache[url] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = url; s.onload = resolve;
        s.onerror = function () { delete scriptCache[url]; reject(new Error('필요한 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인하세요.')); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[url];
  }
  async function lib(name) {
    if (api.libs[name]) return api.libs[name];
    var g = root[GLOBALS[name]];
    if (!g) { await loadScript(CDN[name]); g = root[GLOBALS[name]]; }
    if (!g) throw new Error('라이브러리(' + name + ')를 사용할 수 없습니다.');
    if (name === 'pdfjs' && g.GlobalWorkerOptions && !g.GlobalWorkerOptions.workerSrc) g.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    api.libs[name] = g;
    return g;
  }

  // ── 바이트·문자열 도구 ────────────────────────────────────────────
  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && x.buffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    return new Uint8Array(x);
  }
  function dec(u8, label) { try { return new TextDecoder(label).decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); } }
  function decodeText(buf) {
    var u8 = toU8(buf);
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return dec(u8.subarray(3), 'utf-8');
    if (u8[0] === 0xFF && u8[1] === 0xFE) return dec(u8.subarray(2), 'utf-16le');
    if (u8[0] === 0xFE && u8[1] === 0xFF) return dec(u8.subarray(2), 'utf-16be');
    // BOM 없는 UTF-16: 한쪽 바이트가 대부분 0
    var n = Math.min(u8.length, 4000), even0 = 0, odd0 = 0;
    for (var i = 0; i < n; i++) if (u8[i] === 0) { if (i % 2) odd0++; else even0++; }
    if (n > 8 && odd0 > n * 0.3 && even0 < n * 0.02) return dec(u8, 'utf-16le');
    if (n > 8 && even0 > n * 0.3 && odd0 < n * 0.02) return dec(u8, 'utf-16be');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* 다음 후보 */ }
    return dec(u8, 'euc-kr');   // 한국어 윈도우 메모장 등 CP949
  }
  function looksLikeText(u8) {
    var n = Math.min(u8.length, 8192), bad = 0;
    if (!n) return false;
    for (var i = 0; i < n; i++) {
      var b = u8[i];
      if (b === 0) return false;
      if (b < 9 || (b > 13 && b < 32 && b !== 27)) bad++;
    }
    return bad / n < 0.02;
  }
  function decodeEntities(s) {
    var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—' };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') {
        var code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (x) { return ''; }
      }
      var v = map[e.toLowerCase()]; return v === undefined ? m : v;
    });
  }
  function xmlToText(xml, blockTags) {
    var s = xml;
    if (blockTags) s = s.replace(blockTags, '\n');
    s = s.replace(/<[^>]*>/g, '');
    return decodeEntities(s);
  }
  function htmlToText(html) {
    var s = String(html);
    s = s.replace(/<!--[\s\S]*?-->/g, '')
         .replace(/<(script|style|noscript|head|template)\b[\s\S]*?<\/\1>/gi, '')
         .replace(/<br\s*\/?>/gi, '\n')
         .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote|pre|header|footer|dt|dd)>/gi, '\n')
         .replace(/<\/(td|th)>/gi, '\t')
         .replace(/<[^>]*>/g, '');
    return decodeEntities(s);
  }
  function clean(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/g, '')
      .replace(/[ \t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function extOf(name) { var m = /\.([^.\/\\]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  // ── 형식 판별 ────────────────────────────────────────────────────
  var TEXT_EXT = 'txt md markdown mdown mkd text csv tsv log json jsonl ndjson yaml yml ini toml cfg conf properties tex rst adoc org srt vtt sub sbv sql js ts py java c cpp h css'.split(' ');
  var HTML_EXT = 'html htm xhtml shtml mht mhtml smi'.split(' ');
  var IMG_EXT = 'jpg jpeg jpe png gif bmp webp tif tiff'.split(' ');
  var AV_EXT = 'mp3 wav m4a aac ogg flac wma mp4 mov avi mkv webm wmv'.split(' ');
  var ZIPPY = { docx: 1, docm: 1, dotx: 1, dotm: 1, xlsx: 1, xlsm: 1, pptx: 1, pptm: 1, ppsx: 1, potx: 1, odt: 1, ott: 1, odp: 1, ods: 1, hwpx: 1, epub: 1, zip: 1 };

  function sniff(u8) {
    if (u8.length >= 4) {
      if (u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 3 || u8[2] === 5)) return 'zip';
      if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
      if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'ole';
      if (u8[0] === 0x7B && u8[1] === 0x5C && u8[2] === 0x72 && u8[3] === 0x74) return 'rtf';
      if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image';
      if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image';
      if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image';
      if (u8[0] === 0x42 && u8[1] === 0x4D) return 'image-maybe';
      if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2A) || (u8[0] === 0x4D && u8[1] === 0x4D && u8[2] === 0 && u8[3] === 0x2A)) return 'image';
      if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8.length > 12 && u8[8] === 0x57 && u8[9] === 0x45) return 'image';
      if (u8[0] === 0x48 && u8[1] === 0x57 && u8[2] === 0x50 && u8[3] === 0x20) return 'hwp3';   // "HWP Document File" (구 한글 3.0)
    }
    return '';
  }

  // ── 개별 형식 추출기 ───────────────────────────────────────────
  async function fromZipBytes(u8) { var JSZip = await lib('jszip'); return JSZip.loadAsync(u8); }
  function zipNames(zip) { return Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir; }); }
  function numKey(n) { var m = /(\d+)(?=\D*$)/.exec(n); return m ? parseInt(m[1], 10) : 0; }

  async function docxText(u8) {
    try {
      var mammoth = await lib('mammoth');
      var r = await mammoth.extractRawText({ arrayBuffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
      if (r && r.value && r.value.trim()) return r.value;
    } catch (e) { /* 아래 대체 경로 */ }
    var zip = await fromZipBytes(u8), out = [];
    var main = zip.file('word/document.xml');
    if (!main) throw new Error('Word 문서 구조를 찾지 못했습니다.');
    out.push(xmlToText(await main.async('string'), /<\/w:p>/g));
    return out.join('\n');
  }
  async function pptxText(u8) {
    var zip = await fromZipBytes(u8), names = zipNames(zip);
    var slides = names.filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); }).sort(function (a, b) { return numKey(a) - numKey(b); });
    var notes = {}; names.forEach(function (n) { if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)) notes[numKey(n)] = n; });
    var out = [];
    for (var i = 0; i < slides.length; i++) {
      var x = await zip.file(slides[i]).async('string');
      out.push('[슬라이드 ' + (i + 1) + ']\n' + xmlToText(x.replace(/<a:br\s*\/>/g, '\n'), /<\/a:p>/g));
      var nn = notes[numKey(slides[i])];
      if (nn) { var t = xmlToText(await zip.file(nn).async('string'), /<\/a:p>/g).trim(); if (t) out.push('(발표자 노트) ' + t); }
    }
    return out.join('\n\n');
  }
  async function odfText(u8) {
    var zip = await fromZipBytes(u8), f = zip.file('content.xml');
    if (!f) throw new Error('OpenDocument 구조를 찾지 못했습니다.');
    var x = await f.async('string');
    x = x.replace(/<text:tab\s*\/>/g, '\t').replace(/<text:line-break\s*\/>/g, '\n').replace(/<text:s(\s+text:c="(\d+)")?\s*\/>/g, function (m, a, c) { return ' '.repeat(c ? +c : 1); });
    x = x.replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n');
    return xmlToText(x, /<\/(?:text:p|text:h|draw:page)>/g);
  }
  async function hwpxText(u8) {
    var zip = await fromZipBytes(u8), names = zipNames(zip);
    var secs = names.filter(function (n) { return /^Contents\/section\d+\.xml$/i.test(n); }).sort(function (a, b) { return numKey(a) - numKey(b); });
    var out = [];
    for (var i = 0; i < secs.length; i++) {
      var xml = await zip.file(secs[i]).async('string');
      var re = /<(\/?)(?:\w+:)?(p|t|tab|lineBreak|tc)\b([^>]*?)(\/?)>/g, m, inT = false, buf = '', last = 0;
      while ((m = re.exec(xml))) {
        var close = m[1] === '/', tag = m[2], selfClose = m[4] === '/';
        if (inT) { buf += xml.slice(last, m.index).replace(/<[^>]*>/g, ''); }
        if (tag === 't') {
          if (!close && !selfClose) { inT = true; last = re.lastIndex; continue; }
          if (close) { inT = false; out.push(decodeEntities(buf)); buf = ''; }
        } else if (inT) {
          if (tag === 'tab' && !close) buf += '\t';
          else if (tag === 'lineBreak' && !close) buf += '\n';
        } else if (tag === 'tab' && !close) out.push('\t');
        else if (tag === 'lineBreak' && !close) out.push('\n');
        else if (tag === 'p' && close) out.push('\n');
        else if (tag === 'tc' && close) out.push('\t');
        last = re.lastIndex;
      }
    }
    var text = out.join('');
    if (!text.trim()) { var pv = zip.file('Preview/PrvText.txt'); if (pv) text = decodeText(await pv.async('uint8array')); }
    return text;
  }
  function hmlText(xml) {
    return decodeEntities(xml.replace(/<\/P>/g, '\n').replace(/<(?!\/?CHAR\b)[^>]*>/g, '').replace(/<\/?CHAR[^>]*>/g, ''));
  }
  async function epubText(u8) {
    var zip = await fromZipBytes(u8), names = zipNames(zip), order = [];
    try {
      var cont = await zip.file('META-INF/container.xml').async('string');
      var opfPath = /full-path="([^"]+)"/.exec(cont)[1];
      var opf = await zip.file(opfPath).async('string');
      var base = opfPath.indexOf('/') >= 0 ? opfPath.replace(/[^\/]*$/, '') : '';
      var man = {}; opf.replace(/<item\b[^>]*>/g, function (t) {
        var id = /\bid="([^"]*)"/.exec(t), hr = /\bhref="([^"]*)"/.exec(t); if (id && hr) man[id[1]] = hr[1];
      });
      opf.replace(/<itemref\b[^>]*>/g, function (t) { var r = /idref="([^"]*)"/.exec(t); if (r && man[r[1]]) order.push(decodeURIComponent(base + man[r[1]])); });
    } catch (e) { order = []; }
    if (!order.length) order = names.filter(function (n) { return /\.(x?html?)$/i.test(n); }).sort();
    var out = [];
    for (var i = 0; i < order.length; i++) { var f = zip.file(order[i]); if (f) out.push(htmlToText(await f.async('string'))); }
    return out.join('\n\n');
  }
  async function xlsxText(u8) {
    var XLSX = await lib('xlsx');
    var wb = XLSX.read(u8, { type: 'array' }), out = [];
    wb.SheetNames.forEach(function (name) {
      var csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: '\t', blankrows: false });
      if (csv.trim()) out.push('[시트: ' + name + ']\n' + csv);
    });
    return out.join('\n\n');
  }

  function rtfToText(src) {
    var cp = 'windows-1252', m = /\\ansicpg(\d+)/.exec(src.slice(0, 2000));
    if (m) cp = m[1] === '949' ? 'euc-kr' : (m[1] === '932' ? 'shift_jis' : (m[1] === '936' ? 'gb18030' : 'windows-' + m[1]));
    var DEST = /^(fonttbl|colortbl|stylesheet|info|pict|header|footer|headerl|headerr|headerf|footerl|footerr|footerf|object|fldinst|datastore|themedata|colorschememapping|latentstyles|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|filetbl|revtbl|private|userprops|blipuid|shppict|nonshppict|bkmkstart|bkmkend|pgdsctbl|template|panose|fname|falt)$/;
    var out = [], bytes = [], stack = [], skip = false, uc = 1, ucSkip = 0, i = 0, n = src.length;
    function flushBytes() { if (bytes.length) { out.push(dec(new Uint8Array(bytes), cp)); bytes = []; } }
    function emit(s) { if (skip) return; flushBytes(); out.push(s); }
    while (i < n) {
      var c = src[i];
      if (c === '{') { stack.push({ skip: skip, uc: uc }); i++; continue; }
      if (c === '}') { flushBytes(); var st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } i++; continue; }
      if (c === '\\') {
        var d = src[i + 1];
        if (d === '\\' || d === '{' || d === '}') { emit(d); i += 2; continue; }
        if (d === '~') { emit(' '); i += 2; continue; }
        if (d === '-' || d === '_') { emit(d === '_' ? '-' : ''); i += 2; continue; }
        if (d === '*') { skip = true; i += 2; continue; }
        if (d === "'") {
          var hex = src.substr(i + 2, 2);
          if (ucSkip > 0) { ucSkip--; } else if (!skip) bytes.push(parseInt(hex, 16));
          i += 4; continue;
        }
        var w = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
        if (w) {
          var word = w[1], par = w[2] === undefined ? null : parseInt(w[2], 10);
          i += w[0].length;
          if (DEST.test(word)) { skip = true; continue; }
          if (word === 'par' || word === 'line' || word === 'row' || word === 'sect' || word === 'page') emit('\n');
          else if (word === 'tab' || word === 'cell') emit('\t');
          else if (word === 'uc') uc = par === null ? 1 : par;
          else if (word === 'u' && par !== null) { var code = par < 0 ? par + 65536 : par; emit(String.fromCharCode(code)); ucSkip = uc; }
          else if (word === 'emdash') emit('—'); else if (word === 'endash') emit('–');
          else if (word === 'lquote') emit('‘'); else if (word === 'rquote') emit('’');
          else if (word === 'ldblquote') emit('“'); else if (word === 'rdblquote') emit('”');
          else if (word === 'bullet') emit('•');
          continue;
        }
        i += 2; continue;
      }
      if (c === '\n' || c === '\r') { i++; continue; }
      if (ucSkip > 0) { ucSkip--; i++; continue; }
      emit(c); i++;
    }
    flushBytes();
    return out.join('');
  }

  // ── OLE(복합 문서) 기반: doc · ppt · hwp ────────────────────────
  async function openCfb(u8) {
    var XLSX = await lib('xlsx');
    try { return XLSX.CFB.read(u8, { type: 'array' }); }
    catch (e) { throw new Error('파일이 손상되었거나 읽을 수 없는 형식입니다. PDF·DOCX 등으로 다시 저장해 첨부하세요.'); }
  }
  function cfbStream(cfb, tail, exact) {
    var low = tail.toLowerCase();
    for (var i = 0; i < cfb.FullPaths.length; i++) {
      var p = cfb.FullPaths[i].toLowerCase();
      var base = p.replace(/^root entry\//, '/');
      if (exact ? (base === '/' + low || p === low) : p.endsWith('/' + low)) {
        var c = cfb.FileIndex[i].content; return c ? toU8(c) : null;
      }
    }
    return null;
  }
  function wordBinaryText(cfb) {
    var wd = cfbStream(cfb, 'WordDocument', true);
    if (!wd) throw new Error('Word 97-2003 문서 구조를 찾지 못했습니다.');
    var dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (u16(dv, 0) !== 0xA5EC) throw new Error('지원하지 않는 Word 버전입니다. docx 또는 pdf로 저장해 첨부하세요.');
    var flags = u16(dv, 0x0A);
    if (flags & 0x0100) throw new Error('암호가 걸린 문서입니다. 암호를 해제한 파일을 첨부하세요.');
    var ccpText = dv.getInt32(0x4C, true), fcClx = u32(dv, 0x1A2), lcbClx = u32(dv, 0x1A6);
    var tbl = cfbStream(cfb, (flags & 0x0200) ? '1Table' : '0Table', true);
    if (!tbl || !lcbClx) throw new Error('Word 문서의 본문 정보를 찾지 못했습니다.');
    var td = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength), pos = fcClx, end = fcClx + lcbClx;
    while (pos < end && tbl[pos] === 1) pos += 3 + u16(td, pos + 1);
    if (tbl[pos] !== 2) throw new Error('Word 문서의 본문 정보를 해석하지 못했습니다.');
    var lcb = u32(td, pos + 1), plc = pos + 5, nPieces = Math.floor((lcb - 4) / 12);
    var out = [], total = 0;
    for (var i = 0; i < nPieces && total < ccpText; i++) {
      var cpS = u32(td, plc + i * 4), cpE = u32(td, plc + (i + 1) * 4);
      var fcRaw = u32(td, plc + (nPieces + 1) * 4 + i * 8 + 2);
      var compressed = (fcRaw & 0x40000000) !== 0, fc = fcRaw & 0x3FFFFFFF;
      var cnt = Math.min(cpE - cpS, ccpText - total);
      if (compressed) { var off = Math.floor(fc / 2); out.push(dec(wd.subarray(off, off + cnt), 'windows-1252')); }
      else out.push(dec(wd.subarray(fc, fc + cnt * 2), 'utf-16le'));
      total += cnt;
    }
    var s = out.join('');
    s = s.replace(/\x13[^\x14\x15]*\x14/g, '').replace(/\x13[^\x15]*\x15/g, '').replace(/\x15/g, '');
    s = s.replace(/\x07\x07/g, '\n').replace(/\x07/g, '\t').replace(/[\r\x0B\x0C]/g, '\n').replace(/[\x01\x08]/g, '');
    return s;
  }
  function pptBinaryText(cfb) {
    var st = cfbStream(cfb, 'PowerPoint Document', true);
    if (!st) throw new Error('PowerPoint 97-2003 문서 구조를 찾지 못했습니다.');
    var dv = new DataView(st.buffer, st.byteOffset, st.byteLength), out = [];
    (function walk(start, end) {
      var p = start;
      while (p + 8 <= end) {
        var verInst = u16(dv, p), type = u16(dv, p + 2), len = u32(dv, p + 4), body = p + 8;
        if (len > end - body) break;
        if ((verInst & 0x0F) === 0x0F) { if (type !== 0x03F8) walk(body, body + len); }   // 슬라이드 마스터·유인물 마스터의 안내 문구는 제외
        else if (type === 0x0FA0) out.push(dec(st.subarray(body, body + len), 'utf-16le'));
        else if (type === 0x0FA8) out.push(dec(st.subarray(body, body + len), 'windows-1252'));
        p = body + len;
      }
    })(0, st.length);
    return out.join('\n').replace(/\r/g, '\n').replace(/\x0B/g, '\n').replace(/^[ \t]*[*•·\-]+[ \t]*$/gm, '');
  }
  async function inflateRaw(u8) {
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate-raw');
      var w = ds.writable.getWriter(); w.write(u8); w.close();
      var buf = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(buf);
    }
    var pako = await lib('pako');
    return pako.inflateRaw(u8);
  }
  async function hwpBinaryText(cfb) {
    var fh = cfbStream(cfb, 'FileHeader', true);
    if (!fh || String.fromCharCode.apply(null, Array.prototype.slice.call(fh, 0, 17)).indexOf('HWP Document File') !== 0) throw new Error('한글(HWP) 문서 구조를 찾지 못했습니다.');
    var flags = new DataView(fh.buffer, fh.byteOffset, fh.byteLength).getUint32(36, true);
    var compressed = !!(flags & 1);
    if (flags & 2) throw new Error('암호가 걸린 한글 문서입니다. 암호를 해제하거나 PDF·DOCX로 저장해 첨부하세요.');
    if (flags & 4) throw new Error('배포용 문서(복사·편집 제한)는 읽을 수 없습니다. 한글에서 PDF·DOCX로 저장해 첨부하세요.');
    var secs = [];
    cfb.FullPaths.forEach(function (p, i) { var m = /\/BodyText\/Section(\d+)$/i.exec(p); if (m) secs.push({ n: +m[1], c: cfb.FileIndex[i].content }); });
    secs.sort(function (a, b) { return a.n - b.n; });
    if (!secs.length) throw new Error('한글 문서의 본문을 찾지 못했습니다.');
    var out = [];
    for (var s = 0; s < secs.length; s++) {
      var data = toU8(secs[s].c);
      if (compressed) data = await inflateRaw(data);
      var dv = new DataView(data.buffer, data.byteOffset, data.byteLength), p = 0;
      while (p + 4 <= data.length) {
        var h = u32(dv, p), tag = h & 0x3FF, size = (h >>> 20) & 0xFFF; p += 4;
        if (size === 0xFFF) { size = u32(dv, p); p += 4; }
        if (tag === 0x43 && p + size <= data.length) {          // HWPTAG_PARA_TEXT
          var q = p, e = p + size, line = '';
          while (q + 2 <= e) {
            var ch = u16(dv, q); q += 2;
            if (ch >= 32) { line += String.fromCharCode(ch); continue; }
            if (ch === 10 || ch === 13) { line += '\n'; continue; }
            if (ch === 0) continue;
            if (ch === 24) { line += '-'; continue; }
            if (ch === 30 || ch === 31) { line += ' '; continue; }
            if (ch === 9) line += '\t';
            if (ch !== 0 && ch !== 10 && ch !== 13 && ch !== 24 && ch !== 30 && ch !== 31) q += 14;   // 확장·인라인 컨트롤은 14바이트 더 차지
          }
          out.push(line.replace(/\n?$/, '\n'));
        }
        p += size;
      }
    }
    return out.join('');
  }
  async function oleText(u8, ext) {
    var cfb = await openCfb(u8);
    if (cfbStream(cfb, 'EncryptedPackage', true)) throw new Error('암호가 걸린 Office 문서입니다. 암호를 해제한 파일을 첨부하세요.');
    if (cfbStream(cfb, 'WordDocument', true)) return wordBinaryText(cfb);
    if (cfbStream(cfb, 'PowerPoint Document', true)) return pptBinaryText(cfb);
    if (cfbStream(cfb, 'FileHeader', true) && cfbStream(cfb, 'DocInfo', true)) return hwpBinaryText(cfb);
    if (cfbStream(cfb, 'Workbook', true) || cfbStream(cfb, 'Book', true)) return xlsxText(u8);
    if (cfbStream(cfb, '__properties_version1.0', true) || cfbStream(cfb, '__substg1.0_1000001F', true)) {
      var b = cfbStream(cfb, '__substg1.0_1000001F', true);
      if (b) return dec(b, 'utf-16le');
    }
    throw new Error('이 형식(' + (ext || 'OLE') + ')은 읽을 수 없습니다. docx · pdf · hwpx 등으로 저장해 첨부하세요.');
  }

  // ── PDF · 이미지(OCR) ──────────────────────────────────────────
  async function ocrSource(src, onProgress) {
    var T = await lib('tesseract');
    var worker = await T.createWorker(['kor', 'eng'], 1, { logger: function (m) { if (onProgress && m && m.status === 'recognizing text') onProgress('글자 인식 ' + Math.round((m.progress || 0) * 100) + '%'); } });
    try { var r = await worker.recognize(src); return r && r.data ? r.data.text : ''; }
    finally { try { await worker.terminate(); } catch (e) { /* 무시 */ } }
  }
  async function pdfText(u8, onProgress, opts) {
    var pdfjs = await lib('pdfjs');
    var doc;
    try { doc = await pdfjs.getDocument({ data: u8.slice(0), useSystemFonts: true }).promise; }
    catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('암호가 걸린 PDF입니다. 암호를 해제한 파일을 첨부하세요.');
      throw new Error('PDF를 열지 못했습니다(' + (e && e.message ? e.message : '손상된 파일') + ').');
    }
    var out = [], chars = 0;
    for (var n = 1; n <= doc.numPages; n++) {
      if (onProgress) onProgress('PDF ' + n + '/' + doc.numPages + '쪽 읽는 중');
      var page = await doc.getPage(n), tc = await page.getTextContent(), s = '';
      tc.items.forEach(function (it) { s += (it.str || '') + (it.hasEOL ? '\n' : ''); });
      out.push(s); chars += s.replace(/\s/g, '').length;
      if (chars > MAX_CHARS * 3) break;
    }
    if (chars >= Math.min(doc.numPages, 3) * 20) return out.join('\n\n');
    // 글자가 거의 없는 스캔본 → OCR
    if (typeof document === 'undefined' || !document.createElement) throw new Error('스캔한 PDF(글자 없음)입니다. 브라우저에서 첨부하면 글자 인식을 시도합니다.');
    var pages = Math.min(doc.numPages, OCR_MAX_PAGES), texts = [];
    if (opts && opts.notes) opts.notes.push('스캔본으로 보여 글자 인식(OCR)을 사용했습니다' + (doc.numPages > pages ? ' — 앞 ' + pages + '쪽만' : ''));
    for (var k = 1; k <= pages; k++) {
      if (onProgress) onProgress('스캔 PDF ' + k + '/' + pages + '쪽 글자 인식 중');
      var pg = await doc.getPage(k), vp = pg.getViewport({ scale: 2 }), cv = document.createElement('canvas');
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      texts.push(await ocrSource(cv, null));
    }
    return texts.join('\n\n');
  }
  async function imageText(file, onProgress, opts) {
    if (opts && opts.notes) opts.notes.push('이미지에서 글자 인식(OCR)을 사용했습니다 — 인식 오류가 있을 수 있으니 확인하세요');
    return ocrSource(file, onProgress);
  }

  // ── 이메일(eml) ────────────────────────────────────────────────
  function decodeMime(body, enc, charset) {
    enc = (enc || '').toLowerCase();
    var bytes;
    if (enc === 'base64') { var b = atob(body.replace(/\s+/g, '')); bytes = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i); }
    else if (enc === 'quoted-printable') {
      var q = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
      bytes = new Uint8Array(q.length); for (var j = 0; j < q.length; j++) bytes[j] = q.charCodeAt(j) & 255;
    } else { bytes = new Uint8Array(body.length); for (var k = 0; k < body.length; k++) bytes[k] = body.charCodeAt(k) & 255; }
    var cs = (charset || 'utf-8').toLowerCase().replace(/^ks_c_5601-1987$/, 'euc-kr');
    return dec(bytes, cs);
  }
  function decodeHeaderWords(s) {
    return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, function (m, cs, e, t) {
      try { return decodeMime(e.toLowerCase() === 'b' ? t : t.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '=$1'), e.toLowerCase() === 'b' ? 'base64' : 'quoted-printable', cs); } catch (x) { return m; }
    });
  }
  function parseMime(raw) {
    var idx = raw.search(/\r?\n\r?\n/);
    var head = idx < 0 ? raw : raw.slice(0, idx), body = idx < 0 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '');
    var h = {}; head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(function (l) { var m = /^([^:]+):\s*(.*)$/.exec(l); if (m) h[m[1].toLowerCase()] = m[2]; });
    return { h: h, body: body };
  }
  function emlText(raw) {
    var root0 = parseMime(raw), out = [];
    ['from', 'to', 'date', 'subject'].forEach(function (k) { if (root0.h[k]) out.push({ from: '보낸 사람', to: '받는 사람', date: '날짜', subject: '제목' }[k] + ': ' + decodeHeaderWords(root0.h[k])); });
    out.push('');
    (function walk(p) {
      var ct = (p.h['content-type'] || 'text/plain'), cs = (/charset="?([^";\s]+)/i.exec(ct) || [])[1];
      var bm = /boundary="?([^";]+)"?/i.exec(ct);
      if (/multipart\//i.test(ct) && bm) {
        p.body.split('--' + bm[1]).slice(1).forEach(function (seg) { if (/^--/.test(seg)) return; walk(parseMime(seg.replace(/^\r?\n/, ''))); });
      } else if (/text\/plain/i.test(ct) || !/\//.test(ct)) {
        out.push(decodeMime(p.body, p.h['content-transfer-encoding'], cs));
      } else if (/text\/html/i.test(ct) && !out.some(function (x) { return x && x.length > 50; })) {
        out.push(htmlToText(decodeMime(p.body, p.h['content-transfer-encoding'], cs)));
      }
    })(root0);
    return out.join('\n');
  }

  // ── ZIP 묶음 ──────────────────────────────────────────────────
  async function zipBundleText(u8, depth, onProgress, notes) {
    var zip = await fromZipBytes(u8), names = zipNames(zip).filter(function (n) { return !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(n); });
    var out = [], used = 0;
    for (var i = 0; i < names.length && used < ZIP_MAX_FILES; i++) {
      var nm = names[i];
      try {
        var bytes = await zip.file(nm).async('uint8array');
        if (bytes.length > MAX_BYTES) { notes.push(nm + ': 너무 커서 건너뜀'); continue; }
        var r = await extractBytes(bytes, nm.split('/').pop(), { onProgress: onProgress, depth: depth + 1, notes: notes });
        if (clean(r.text)) { out.push('[압축 파일 안: ' + nm + ']\n' + clean(r.text)); used++; }
      } catch (e) { notes.push(nm + ': ' + (e && e.message ? e.message : '읽지 못함')); }
    }
    if (names.length > ZIP_MAX_FILES) notes.push('압축 파일 안의 파일이 많아 앞 ' + ZIP_MAX_FILES + '개만 읽었습니다');
    return out.join('\n\n');
  }

  // ── 진입점 ────────────────────────────────────────────────────
  async function extractBytes(u8, name, o) {
    o = o || {};
    var depth = o.depth || 0, notes = o.notes || [], progress = o.onProgress || null;
    var ext = extOf(name), magic = sniff(u8), kind = '', text = '';

    if (AV_EXT.indexOf(ext) >= 0) throw new Error('음성·영상 파일은 글자로 옮길 수 없습니다. 입력란의 마이크 버튼(음성 입력)을 사용하거나 내용을 글로 적어 주세요.');
    if (ext === 'gdoc' || ext === 'gsheet' || ext === 'gslides') throw new Error('구글 문서 바로가기 파일입니다. 구글 문서에서 DOCX 또는 PDF로 내려받아 첨부하세요.');
    if (ext === 'pages' || ext === 'numbers' || ext === 'key') throw new Error('Apple iWork 파일은 읽을 수 없습니다. PDF 또는 DOCX로 내보내 첨부하세요.');
    if (magic === 'hwp3') throw new Error('구 한글(3.0) 문서는 읽을 수 없습니다. 최신 한글에서 열어 PDF·DOCX로 저장해 첨부하세요.');
    if (ext === 'heic' || ext === 'heif') throw new Error('HEIC 사진은 읽을 수 없습니다. JPG 또는 PNG로 바꿔 첨부하세요.');

    // 1) 매직 넘버가 있으면 그에 따른다 (확장자가 틀려도 읽기 위함)
    if (magic === 'pdf') kind = 'pdf';
    else if (magic === 'rtf') kind = 'rtf';
    else if (magic === 'image' || (magic === 'image-maybe' && ext === 'bmp')) kind = 'image';
    else if (magic === 'ole') kind = 'ole';
    else if (magic === 'zip') {
      var zip = await fromZipBytes(u8), names = zipNames(zip), lower = names.map(function (n) { return n.toLowerCase(); });
      var mime = zip.file('mimetype') ? (await zip.file('mimetype').async('string')).trim() : '';
      if (lower.indexOf('word/document.xml') >= 0) kind = 'docx';
      else if (lower.some(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })) kind = 'pptx';
      else if (lower.indexOf('xl/workbook.xml') >= 0 || lower.indexOf('xl/workbook.bin') >= 0) kind = 'xlsx';
      else if (/opendocument\.spreadsheet/.test(mime)) kind = 'xlsx';
      else if (/opendocument/.test(mime)) kind = 'odf';
      else if (/epub/.test(mime) || lower.indexOf('meta-inf/container.xml') >= 0 && lower.some(function (n) { return /\.opf$/.test(n); })) kind = 'epub';
      else if (lower.some(function (n) { return /^contents\/section\d+\.xml$/.test(n); })) kind = 'hwpx';
      else kind = 'zip';
    }
    // 2) 확장자로 판단
    if (!kind) {
      if (TEXT_EXT.indexOf(ext) >= 0 || ext === 'smi') kind = (HTML_EXT.indexOf(ext) >= 0) ? 'html' : 'text';
      else if (HTML_EXT.indexOf(ext) >= 0) kind = 'html';
      else if (ext === 'eml') kind = 'eml';
      else if (ext === 'hml') kind = 'hml';
      else if (ext === 'fodt' || ext === 'fods' || ext === 'fodp') kind = 'fodf';
      else if (IMG_EXT.indexOf(ext) >= 0) kind = 'image';
      else if (looksLikeText(u8)) kind = 'text';
      else if (ZIPPY[ext] || ext === 'doc' || ext === 'ppt' || ext === 'hwp' || ext === 'xls') throw new Error('파일이 손상되었거나 ' + ext + ' 형식이 아닙니다. 다른 형식(PDF·DOCX 등)으로 저장해 다시 첨부하세요.');
      else throw new Error('읽을 수 없는 형식(' + (ext || '확장자 없음') + ')입니다. 문서는 PDF·DOCX·HWP·HWPX·TXT 등으로, 사진은 JPG·PNG로 저장해 첨부하세요.');
    }
    // 텍스트로 보이는 파일이 RTF/HTML/XML 내용이면 보정
    if (kind === 'text') {
      var head = decodeText(u8.subarray(0, 600)).trimStart();
      if (/^\{\\rtf/.test(head)) kind = 'rtf';
      else if (/^<(!doctype html|html)\b/i.test(head)) kind = 'html';
      else if (ext === 'xml' || /^<\?xml/i.test(head)) kind = /<(?:HWPML|HWPML)\b/.test(head) ? 'hml' : 'xml';
      else if (/^(from|received|return-path|mime-version|message-id):/i.test(head)) kind = 'eml';
    }

    switch (kind) {
      case 'text':  text = decodeText(u8); break;
      case 'html':  text = htmlToText(decodeText(u8)); break;
      case 'xml':   text = xmlToText(decodeText(u8), /<\/(?:p|div|para|li|row|item)>/gi); break;
      case 'hml':   text = hmlText(decodeText(u8)); break;
      case 'fodf':  text = xmlToText(decodeText(u8).replace(/<text:tab\s*\/>/g, '\t'), /<\/(?:text:p|text:h)>/g); break;
      case 'eml':   text = emlText(decodeText(u8)); break;
      case 'rtf':   text = rtfToText(decodeText(u8)); break;
      case 'docx':  text = await docxText(u8); break;
      case 'pptx':  text = await pptxText(u8); break;
      case 'xlsx':  text = await xlsxText(u8); break;
      case 'odf':   text = await odfText(u8); break;
      case 'hwpx':  text = await hwpxText(u8); break;
      case 'epub':  text = await epubText(u8); break;
      case 'ole':   text = await oleText(u8, ext); break;
      case 'pdf':   text = await pdfText(u8, progress, { notes: notes }); break;
      case 'image': text = await imageText(new Blob([u8]), progress, { notes: notes }); break;
      case 'zip':
        if (depth >= ZIP_MAX_DEPTH) throw new Error('압축 파일이 여러 겹이라 읽지 않았습니다.');
        text = await zipBundleText(u8, depth, progress, notes); break;
      default: throw new Error('읽을 수 없는 형식입니다.');
    }
    return { text: text, kind: kind, notes: notes };
  }

  async function readFile(file, opts) {
    opts = opts || {};
    var u8 = new Uint8Array(await file.arrayBuffer());
    if (!u8.length) throw new Error('빈 파일입니다.');
    var r;
    try { r = await extractBytes(u8, file.name || '', { onProgress: opts.onProgress, notes: [] }); }
    catch (e) {
      var m = e && e.message ? e.message : String(e);
      throw /[\uAC00-\uD7A3]/.test(m) ? e : new Error('파일을 읽는 중 오류가 발생했습니다(' + m + '). 다른 형식(PDF·DOCX 등)으로 저장해 다시 첨부해 보세요.');
    }
    r.text = clean(r.text);
    if (!r.text) {
      var hint = (r.kind === 'image' || r.kind === 'pdf') ? '글자를 찾지 못했습니다. 사진이 흐리거나 글자가 없는 파일일 수 있습니다. 내용을 직접 붙여넣어 주세요.'
               : (r.kind === 'xlsx' || r.kind === 'pptx' || r.kind === 'docx' || r.kind === 'hwpx' || r.kind === 'ole') ? '문서 안에서 글자를 찾지 못했습니다. 표나 그림만 있는 문서일 수 있습니다.'
               : '글자를 읽지 못했습니다.';
      throw new Error(hint);
    }
    return r;
  }

  // ── 입력란 연결 ───────────────────────────────────────────────
  async function handleInput(input, o) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (!files.length) return;
    var ta = o.textarea, list = o.list, maxChars = o.maxChars || MAX_CHARS;
    var status = o.status || function () {}, ok = [], bad = [];
    if (api._busy) { status('이전 첨부 파일을 읽는 중입니다. 잠시 후 다시 시도하세요.', 'err'); return; }
    api._busy = true;
    try {
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
          if (file.size > MAX_BYTES) throw new Error('파일이 너무 큽니다(' + Math.round(MAX_BYTES / 1048576) + 'MB 이하).');
          status(file.name + ' 읽는 중…', '');
          var r = await readFile(file, { onProgress: function (m) { status(file.name + ': ' + m, ''); } });
          var text = r.text, note = '';
          if (text.length > maxChars) { text = text.slice(0, maxChars); note = ' (앞부분 ' + maxChars.toLocaleString('ko-KR') + '자만 넣었습니다)'; }
          var block = '[첨부 파일: ' + file.name + ']\n' + text;
          ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' + block : block;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          list.push({ name: file.name, block: block });
          ok.push(file.name + ' 추가됨' + note + (r.notes && r.notes.length ? ' [' + r.notes.join('; ') + ']' : ''));
        } catch (e) {
          bad.push(file.name + ': ' + (e && e.message ? e.message : '읽지 못했습니다.'));
        }
      }
    } finally { api._busy = false; }
    if (o.render) o.render();
    if (bad.length) status((ok.length ? ok.join(' · ') + ' / ' : '') + bad.join(' / '), 'err');
    else status(ok.join(' · ') + '. 입력란에서 내용을 확인하세요.', 'ok');
  }
  function removeBlock(list, idx, ta) {
    var f = list[idx];
    if (f && f.block && ta && ta.value.indexOf(f.block) >= 0) ta.value = ta.value.replace(f.block, '').replace(/\n{3,}/g, '\n\n').trim();
    list.splice(idx, 1);
  }

  api.readFile = readFile;
  api.extractBytes = extractBytes;
  api.handleInput = handleInput;
  api.removeBlock = removeBlock;
  api._internals = { decodeText: decodeText, rtfToText: rtfToText, htmlToText: htmlToText, clean: clean, emlText: emlText, hwpBinaryText: hwpBinaryText, wordBinaryText: wordBinaryText, pptBinaryText: pptBinaryText, hwpxText: hwpxText };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KLawAttach = api;
})(typeof window !== 'undefined' ? window : globalThis);
