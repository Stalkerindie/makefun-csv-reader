// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// readCsv({text, header}) -> {columns, rows, errors}.
//
// Same state machine as the reference, but slice-based instead of
// character-at-a-time: unquoted fields are taken with one native regex scan
// for the next comma / LF / CR and one String.slice; quoted fields are taken
// with indexOf('"') scans, one slice per segment, with "" collapsed to one
// quote. The slow paths (a lone CR outside quotes, a CR/LF inside quotes,
// an unterminated quote, junk after a closing quote) run only when the
// input actually contains them, which the generator does rarely.
//
// Error semantics, copied exactly from the reference:
//  - U+FEFF at the very start is dropped.
//  - A record ends at LF or CRLF; a line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next non-doubled quote; ""
//    inside it is one quote; each CRLF or lone CR inside it is read as LF.
//    What follows the closing quote, up to the next comma or line break, is
//    appended as it stands (quote_junk, when the field ends, if anything was
//    appended). A quote that never closes is a literal character and the
//    text after it is read again as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is a literal character.
//  - columns is the first record when header is true, else null; rows are
//    the records after it (every record when header is false), each padded
//    with "" (short_row, with fields: its field count) or cut (long_row,
//    with extra: the cut fields) to the first record's width.
//  - Each error is {code, line, row}, in the order met; line is the 1-based
//    line its record starts on (counting every LF, CRLF and lone CR inside
//    quotes), row its record's index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// One native scan for the next unquoted delimiter (comma, LF or CR),
// instead of three separate indexOf scans per field. Set lastIndex before
// every exec; run() is synchronous, so no interleaving can disturb it.
const DELIM = /[,\r\n]/g;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Set fresh for every record, before its fields.
  let recordLine = 1;
  let recordRow = null;

  // Result of the field just read: its value, how it ended, and (for the
  // junk path) how many characters the unquoted tail appended.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  // Reads unquoted characters onto `init` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr) and the field
  // goes on. Sets fVal / fEnd / fAdded.
  function readUnquoted(init) {
    let val = init;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = start;
      const dm = DELIM.exec(text);
      let m = -1;
      let kind = 0; // 0 comma, 1 LF, 2 CR
      if (dm !== null) {
        m = dm.index;
        const dc = dm[0].charCodeAt(0);
        kind = dc === 44 ? 0 : dc === 10 ? 1 : 2;
      }
      if (m === -1) {
        // End of text.
        val += text.slice(start);
        pos = n;
        fVal = val;
        fAdded = val.length - init.length;
        fEnd = END;
        return;
      }
      if (kind === 0) {
        val += text.slice(start, m);
        pos = m + 1;
        fVal = val;
        fAdded = val.length - init.length;
        fEnd = COMMA;
        return;
      }
      if (kind === 1) {
        val += text.slice(start, m);
        pos = m + 1;
        line += 1;
        fVal = val;
        fAdded = val.length - init.length;
        fEnd = LINE_BREAK;
        return;
      }
      // CR: CRLF ends the record, a lone CR is dropped (stray_cr).
      if (m + 1 < n && text.charCodeAt(m + 1) === 10) {
        val += text.slice(start, m);
        pos = m + 2;
        line += 1;
        fVal = val;
        fAdded = val.length - init.length;
        fEnd = LINE_BREAK;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      val += text.slice(start, m);
      start = m + 1;
    }
  }

  // Appends text[start..end) onto qVal, turning each CRLF or lone CR into
  // one LF and counting each line break. Only called for quoted segments
  // that actually contain a CR or LF; the caller checks first.
  let qVal = '';
  function pushQuotedSlow(start, end) {
    let s = start;
    while (s < end) {
      const iL = text.indexOf('\n', s);
      const iR = text.indexOf('\r', s);
      let m = -1;
      let isCR = false;
      if (iL !== -1 && iL < end) { m = iL; isCR = false; }
      if (iR !== -1 && iR < end && (m === -1 || iR < m)) { m = iR; isCR = true; }
      if (m === -1) {
        qVal += text.slice(s, end);
        return;
      }
      qVal += text.slice(s, m);
      qVal += '\n';
      line += 1;
      s = m + 1;
      if (isCR && s < end && text.charCodeAt(s) === 10) s += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal / fEnd.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    qVal = '';
    let seg = pos + 1;
    for (;;) {
      const q = text.indexOf('"', seg);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote; the segment before it joins the value.
        const iL = text.indexOf('\n', seg);
        const iR = text.indexOf('\r', seg);
        if ((iL !== -1 && iL < q) || (iR !== -1 && iR < q)) pushQuotedSlow(seg, q);
        else qVal += text.slice(seg, q);
        qVal += '"';
        seg = q + 2;
        continue;
      }
      // Closing quote: the last segment joins the value.
      const iL = text.indexOf('\n', seg);
      const iR = text.indexOf('\r', seg);
      if ((iL !== -1 && iL < q) || (iR !== -1 && iR < q)) pushQuotedSlow(seg, q);
      else qVal += text.slice(seg, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fVal = qVal;
      fEnd = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fVal = qVal;
      fEnd = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fVal = qVal;
      fEnd = LINE_BREAK;
      return;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fVal = qVal;
      fEnd = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(qVal);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      if (lastQuoted) readQuoted();
      else readUnquoted('');
      fields.push(fVal);
      ended = fEnd;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
