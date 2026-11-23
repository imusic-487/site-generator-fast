// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Byte-for-byte identical output to makefun-site's build(), rewritten for speed:
//  - slugify results cached per run, with a fast ASCII path (ASCII is NFKD-stable)
//  - HTML escaping via a fast-path regex test + chunked replacement (never per char)
//  - Markdown lexed and rendered in one fused pass, inline rendering chunked
//  - front matter scanned by indexOf, body taken as a slice (no split/join round-trip)
//  - templates parsed once per run, rendered into a chunk array (no string += per node)
// No state is kept between run() calls: every cache is created fresh inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const HAS_SPECIAL = /[&<>"']/;

function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function slugifySlow(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    // ASCII is invariant under NFKD and holds no combining marks: same result, no normalize.
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// text has "\n" line ends already. Returns { data, body } or { error }.
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let ln = 2;
  let closeEnd = -1;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl);
    if (line === '---') { closeEnd = nl; break; }
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${ln} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = nl + 1;
    ln++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < text.length ? text.slice(closeEnd + 1) : '' };
}

// ---------------------------------------------------------------- markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function mdHeadingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function mdTrimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(n - 1);
  if (c0 !== 32 && c0 !== 9 && c1 !== 32 && c1 !== 9) return line;
  let a = 0;
  let b = n;
  while (a < n && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function mdEndsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line); // ` fence
  if (c === 35) return mdHeadingOf(line) !== null; // #
  if (c === 45 || c === 42) return MD_HR.test(line); // - or *
  return false;
}

// The first index from `from` where `s` holds `what` outside a backslash escape,
// or -1. A backslash run of odd length immediately before the match escapes its
// first character (the scan consumes `\`+escapable pairs left to right, so a
// maximal run's parity decides); an even run is consumed as escaped backslashes.
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s[p] === '\\'; p--) b++;
    if (b % 2 === 0) return k;
    j = k + 1; // the match's first char was escaped; its second may start a new one
  }
}

// The first single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s[p] === '\\'; p--) b++;
    if (b % 2 === 1) { j = k + 1; continue; } // an escaped star
    if (s[k + 1] === '*') { j = k + 2; continue; } // part of a ** run: skip both
    return k;
  }
}

// Inline rendering, scanned by a native regex for the next markup/escape char
// instead of a per-character JS loop. Plain runs are sliced once and escaped
// only when they hold an HTML special (tracked while scanning). The shared
// regex's lastIndex is restored after every recursive call, before scanning on.
// Semantics ported exactly from the reference.
const INLINE_RE = /[\\`*\[&<>"']/g;

function mdInline(s, env, st) {
  const out = [];
  let chunk = 0; // start of the current plain run
  let runHtml = false; // the plain run holds an HTML special (& < > " ')
  INLINE_RE.lastIndex = 0;
  const flush = (to) => {
    if (to > chunk) out.push(runHtml ? escapeHtml(s.slice(chunk, to)) : s.slice(chunk, to));
    runHtml = false;
  };
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") { runHtml = true; continue; }
    if (c === '\\') {
      if (j + 1 < s.length && MD_ESCAPABLE.has(s[j + 1])) {
        flush(j);
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        chunk = j + 2;
        INLINE_RE.lastIndex = j + 2;
      }
      continue; // a backslash before a non-escapable char is plain; scan on
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        flush(j);
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        chunk = k + 1;
        INLINE_RE.lastIndex = k + 1;
      }
      continue; // no closer (or empty): the backtick is plain, scan on
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          flush(j);
          out.push('<strong>', mdInline(s.slice(j + 2, k), env, st), '</strong>');
          chunk = k + 2;
          INLINE_RE.lastIndex = k + 2;
        } else INLINE_RE.lastIndex = j + 2; // no closer: both stars are plain
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        flush(j);
        out.push('<em>', mdInline(s.slice(j + 1, k), env, st), '</em>');
        chunk = k + 1;
        INLINE_RE.lastIndex = k + 1;
      }
      continue; // no closer: the star is plain, scan on
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = p === -1 ? '' : s.slice(k + 2, p);
    if (target !== '' && !/\s/.test(target)) {
      flush(j);
      out.push('<a href="', escapeHtml(env.link(target)), '">', mdInline(s.slice(j + 1, k), env, st), '</a>');
      chunk = p + 1;
      INLINE_RE.lastIndex = p + 1;
    }
    // else: the '[' is plain, scan on
  }
  flush(s.length);
  return out.join('');
}

function renderMarkdown(src, env, st) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // Indented lines are text; only an all-blank line is skipped here.
      if (MD_BLANK.test(line)) { i++; continue; }
    } else if (c0 === 96) { // ` fence (or a paragraph starting with a backtick)
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let code = '';
        for (let k = 0; k < body.length; k++) code += `${escapeHtml(body[k])}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) { // # heading (or a paragraph starting with #)
      const heading = mdHeadingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(st.slug(heading.text), ids);
        const html = mdInline(heading.text, env, st);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // - or *: hr, then a bullet list
      if (MD_HR.test(line)) { blocks.push('<hr>'); i++; continue; }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const m = MD_BULLET.exec(lines[i]);
          if (m !== null) { items.push([mdTrimLine(m[1])]); i++; }
          else if (MD_CONTINUED.test(lines[i])) { items[items.length - 1].push(mdTrimLine(lines[i])); i++; }
          else break;
        }
        let html = '<ul>\n';
        for (let k = 0; k < items.length; k++) html += `<li>${mdInline(items[k].join('\n'), env, st)}</li>\n`;
        blocks.push(`${html}</ul>`);
        continue;
      }
    } else if (c0 === 62) { // > blockquote
      const body = [];
      while (i < n && lines[i].startsWith('>')) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(mdTrimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${mdInline(inner.join('\n'), env, st)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: ordered list (or a paragraph)
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < n) {
          const m = MD_ORDERED.exec(lines[i]);
          if (m !== null) { items.push([mdTrimLine(m[2])]); i++; }
          else if (MD_CONTINUED.test(lines[i])) { items[items.length - 1].push(mdTrimLine(lines[i])); i++; }
          else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (let k = 0; k < items.length; k++) html += `<li>${mdInline(items[k].join('\n'), env, st)}</li>\n`;
        blocks.push(`${html}</ol>`);
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break.
    const body = [mdTrimLine(line)];
    i++;
    while (i < n && !mdEndsParagraph(lines[i])) body.push(mdTrimLine(lines[i++]));
    const html = mdInline(body.join('\n'), env, st);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = tplLookup(scope, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(tplTextOf(v)));
        break;
      }
      case 'raw': {
        const v = tplLookup(scope, n.path);
        out.push(typeof v === 'string' ? v : tplTextOf(v));
        break;
      }
      case 'if': {
        const v = tplTruthy(tplLookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = tplLookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const L = xs.length;
        for (let k = 0; k < L; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === L - 1, length: L };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- compiled templates (fast path)
//
// A template's nodes, compiled once per run into a fresh tree where every
// path's first name is resolved statically to a frame slot: the root vars
// (slot 0) or one of the enclosing for-loops' vars objects (slot k+1, innermost
// for last), with includes inlined. This is exact only for acyclic include
// trees whose longest chain is at most 6 hops (so no include ever reaches the
// depth-8 cutoff the reference enforces); compileAll returns null otherwise
// and the run falls back to the scope-chain interpreter above. A missing
// include renders nothing, as in the reference, so it is simply dropped.

function resolveSlot(fors, name) {
  for (let k = fors.length - 1; k >= 0; k--) if (fors[k] === name) return k + 1;
  if (name === 'loop') return fors.length > 0 ? fors.length : 0;
  return 0;
}

function compileNodes(nodes, parsed, fors, visiting, hops) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'text') { out.push(n); continue; }
    if (n.kind === 'var' || n.kind === 'raw') { out.push({ kind: n.kind, path: n.path, slot: resolveSlot(fors, n.path[0]) }); continue; }
    if (n.kind === 'if') {
      const then = compileNodes(n.then, parsed, fors, visiting, hops);
      if (then === null) return null;
      let els = null;
      if (n.else !== null) { els = compileNodes(n.else, parsed, fors, visiting, hops); if (els === null) return null; }
      out.push({ kind: 'if', not: n.not, path: n.path, slot: resolveSlot(fors, n.path[0]), then, else: els });
      continue;
    }
    if (n.kind === 'for') {
      const slot = resolveSlot(fors, n.path[0]);
      fors.push(n.name);
      const body = compileNodes(n.body, parsed, fors, visiting, hops);
      fors.pop();
      if (body === null) return null;
      out.push({ kind: 'for', name: n.name, path: n.path, slot, body });
      continue;
    }
    // include: inline the target's compiled nodes in the caller's scope.
    if (hops > 6 || visiting.has(n.name)) return null;
    const target = parsed.get(n.name);
    if (target === undefined) continue; // a missing include renders nothing
    visiting.add(n.name);
    const inlined = compileNodes(target, parsed, fors, visiting, hops + 1);
    visiting.delete(n.name);
    if (inlined === null) return null;
    for (const m of inlined) out.push(m);
  }
  return out;
}

function compileAll(parsed) {
  const compiled = new Map();
  for (const name of parsed.keys()) {
    const nodes = compileNodes(parsed.get(name), parsed, [], new Set([name]), 0);
    if (nodes === null) return null;
    compiled.set(name, nodes);
  }
  return compiled;
}

function lookupSlot(frames, node) {
  const f = frames[node.slot];
  let v = Object.hasOwn(f, node.path[0]) ? f[node.path[0]] : undefined;
  for (let k = 1; k < node.path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, node.path[k])) return undefined;
    v = v[node.path[k]];
  }
  return v;
}

function renderFast(nodes, frames, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookupSlot(frames, n);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(tplTextOf(v)));
        break;
      }
      case 'raw': {
        const v = lookupSlot(frames, n);
        out.push(typeof v === 'string' ? v : tplTextOf(v));
        break;
      }
      case 'if': {
        const v = tplTruthy(lookupSlot(frames, n));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderFast(branch, frames, out);
        break;
      }
      case 'for': {
        const xs = lookupSlot(frames, n);
        if (!Array.isArray(xs)) break;
        const L = xs.length;
        for (let k = 0; k < L; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === L - 1, length: L };
          frames.push(vars);
          renderFast(n.body, frames, out);
          frames.pop();
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const WS_RUN = /\s+/g;

// Runs of non-whitespace, counted by scanning whitespace runs natively
// (no match array is built, unlike match(/\S+/g)).
function wordsOf(text) {
  let n = 0;
  let last = 0;
  WS_RUN.lastIndex = 0;
  let m;
  while ((m = WS_RUN.exec(text)) !== null) {
    if (m.index > last) n++;
    last = m.index + m[0].length;
  }
  if (last < text.length) n++;
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const st = { slug: (s) => {
    let v = slugCache.get(s);
    if (v === undefined) { v = slugifySlow(s); slugCache.set(s, v); }
    return v;
  } };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources, sorted by path in code-unit order
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter + refusals, in the reference's check order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let k = 0; k < RESERVED.length; k++) {
      const d = RESERVED[k];
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? st.slug(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown + link resolution
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, st);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = st.slug(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = st.slug(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = st.slug(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // One card per kept source, computed once and reused by pageOf and the lists.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  // 7. layouts
  const output = {};
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const compiled = compileAll(templates);
  const render = (name, vars) => {
    const rootVars = { site, tags: allTags, recent, ...vars };
    if (compiled !== null) {
      const nodes = compiled.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderFast(nodes, [rootVars], out);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: rootVars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
