// solve.js — a fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns exactly the output tree the reference build returns, byte for byte.
// Written fresh in-session from the kit's rules and the reference's stated behavior.
// Optimizations: char-based front-matter + Markdown scanning (no per-line regexes, no token
// objects), bulk inline escaping (one replace per plain run instead of one per character),
// template precompilation to JS render functions (no per-node dispatch, no scope-chain walk),
// slugify/reading-minutes reuse. No caching across cases: every case is answered alone.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. Pure-ASCII input skips the normalize/replace pass
 * (NFKD is the identity on ASCII and \p{M} matches no ASCII character).
 */
function slugify(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
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
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isLowerKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Scans line by line without splitting the whole body: the body is one
 * slice, and only the (few) front-matter lines are examined one by one.
 */
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line; lineNo counts 0-based lines (line 0 is the opening '---').
  let pos = firstEnd + 1;
  let lineNo = 1;
  let closeLineNo = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? text.length : eol;
    if (text.slice(pos, end) === '---') {
      closeLineNo = lineNo;
      closeEnd = end;
      break;
    }
    if (eol === -1) break;
    pos = eol + 1;
    lineNo++;
  }
  if (closeLineNo === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Examine each front-matter line (lines 1 .. closeLineNo-1).
  pos = firstEnd + 1;
  for (let ln = 1; ln < closeLineNo; ln++) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (line === '' || /^[ \t]*$/.test(line) || line[0] === '#') continue;
    // LINE: /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length && isLowerKeyChar(line[k])) k++;
    if (k === 0 || line[k] !== ':') return { error: `line ${ln + 1} is not "key: value"` };
    const key = line.slice(0, k);
    const rest = line.slice(k + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest[0] !== ' ') return { error: `line ${ln + 1} is not "key: value"` };
    else raw = rest.slice(1).replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isSpaceTab(c) {
  return c === ' ' || c === '\t';
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line[a])) a++;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  return line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** The fence language of a fence-open line, or null when the line is not one. */
function fenceOpenLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let k = 3;
  while (k < line.length && isLangChar(line[k])) k++;
  for (let j = k; j < line.length; j++) if (!isSpaceTab(line[j])) return null;
  return line.slice(3, k);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line[j])) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || !isSpaceTab(line[n])) return null;
  let a = n;
  while (a < line.length && isSpaceTab(line[a])) a++;
  let b = line.length;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const p = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : -1;
  if (p === -1) return false;
  for (let j = p; j < line.length; j++) if (!isSpaceTab(line[j])) return false;
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line[s] === ' ') s++;
  if (s < 2 || s >= line.length) return false;
  const c = line[s];
  return c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\v' && c !== '\f';
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpenLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped in bulk with
 * one replace per run instead of one regex call per character.
 */
function inline(s, env) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Find the next inline special: \ ` * [
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j > i) {
      out.push(escapeHtml(s.slice(i, j)));
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j2 = s.indexOf('`', i + 1);
      if (j2 > i + 1) {
        out.push(`<code>${escapeHtml(s.slice(i + 1, j2))}</code>`);
        i = j2 + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j2 = findUnescaped(s, '**', i + 2);
        if (j2 > i + 2) {
          out.push(`<strong>${inline(s.slice(i + 2, j2), env)}</strong>`);
          i = j2 + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j2 = findSingleStar(s, i + 1);
      if (j2 > i + 1) {
        out.push(`<em>${inline(s.slice(i + 1, j2), env)}</em>`);
        i = j2 + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // c === '['
    const k2 = findUnescaped(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push(`<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k2), env)}</a>`);
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or ""). Single pass over the source; blocks render straight into the
 * output array, no token objects.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = src.slice(pos, eol);
    const nextPos = eol === n ? n : eol + 1;
    if (isBlankLine(line)) {
      pos = nextPos;
      continue;
    }
    const lang = fenceOpenLang(line);
    if (lang !== null) {
      // Body region: from after the open fence line to the start of the close fence line (or EOF).
      const bodyStart = nextPos;
      let p = bodyStart;
      let bodyEnd = n;
      let foundClose = false;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        if (isFenceClose(src.slice(p, e2))) {
          bodyEnd = p;
          foundClose = true;
          break;
        }
        p = e2 + 1;
      }
      const region = src.slice(bodyStart, bodyEnd);
      let esc = escapeHtml(region);
      if (region !== '' && !region.endsWith('\n')) esc += '\n';
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${esc}</code></pre>`);
      if (!foundClose) {
        pos = n;
      } else {
        const ce = src.indexOf('\n', bodyEnd);
        pos = ce === -1 ? n : ce + 1;
      }
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      pos = nextPos;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      pos = nextPos;
      continue;
    }
    if (line[0] === '>') {
      const qlines = [];
      let p = pos;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(p, e2);
        if (l2[0] !== '>') break;
        const t = trimLine(l2.slice(1).startsWith(' ') ? l2.slice(2) : l2.slice(1));
        if (t !== '') qlines.push(t);
        p = e2 === n ? n : e2 + 1;
      }
      blocks.push(qlines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(qlines.join('\n'), env)}</p>\n</blockquote>`);
      pos = p;
      continue;
    }
    // List?
    let isOrdered = false;
    let start = 1;
    let firstItem = null;
    if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') {
      firstItem = line.slice(2);
    } else {
      // ordered: 1-9 digits, '. ', rest
      let d = 0;
      while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
        isOrdered = true;
        start = Number(line.slice(0, d));
        firstItem = line.slice(d + 2);
      }
    }
    if (firstItem !== null) {
      const items = [[trimLine(firstItem)]];
      let p = nextPos;
      while (p < n) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(p, e2);
        const np = e2 === n ? n : e2 + 1;
        let m = null;
        if (!isOrdered) {
          if ((l2[0] === '-' || l2[0] === '*') && l2[1] === ' ') m = l2.slice(2);
        } else {
          let d = 0;
          while (d < l2.length && l2[d] >= '0' && l2[d] <= '9') d++;
          if (d >= 1 && d <= 9 && l2[d] === '.' && l2[d + 1] === ' ') m = l2.slice(d + 2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          p = np;
        } else if (isContinued(l2)) {
          items[items.length - 1].push(trimLine(l2));
          p = np;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      pos = p;
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const plines = [trimLine(line)];
    let p = nextPos;
    while (p < n) {
      let e2 = src.indexOf('\n', p);
      if (e2 === -1) e2 = n;
      const l2 = src.slice(p, e2);
      if (endsParagraph(l2)) break;
      plines.push(trimLine(l2));
      p = e2 === n ? n : e2 + 1;
    }
    const html = inline(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
    pos = p;
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
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

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The next path segment of `v`, or undefined (same rule as the reference's lookup: own property of an object). */
function seg(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/**
 * The first path segment's value: `loop` is the innermost loop's loop object; otherwise the
 * innermost loop frame binding `name`, else the root vars' own property. V is a flat array of
 * [name, element, loop] triples, innermost last.
 */
function dyn(V, R, name) {
  if (name === 'loop') return V.length === 0 ? undefined : V[V.length - 1];
  for (let i = V.length - 3; i >= 0; i -= 3) if (V[i] === name) return V[i + 1];
  return Object.hasOwn(R, name) ? R[name] : undefined;
}

/**
 * Compile a parsed template's node tree into a render function (R, V, depth, out, C):
 * R is the root vars object, V the flat [name, element, loop] scope vector, depth the include
 * depth, out the output chunk array, C the shared helpers { T, H, textOf, truthy, seg, dyn }.
 * Loop variables bound by this template's own for-loops resolve to fixed V slots at compile time;
 * anything else goes through dyn (which also sees enclosing templates' loop frames, as includes
 * render in the caller's scope).
 */
function compileTemplate(nodes) {
  const parts = [];
  const frames = []; // lexical for-loop var names, innermost last
  let uid = 0;
  function pathExpr(path) {
    const first = path[0];
    let base;
    if (first === 'loop') {
      base = 'V[V.length-1]';
    } else {
      let d = -1;
      for (let k = frames.length - 1; k >= 0; k--) {
        if (frames[k] === first) {
          d = frames.length - 1 - k;
          break;
        }
      }
      if (d >= 0) base = `V[V.length-${2 + 3 * d}]`;
      else base = `C.dyn(V,R,${JSON.stringify(first)})`;
    }
    let expr = base;
    for (let k = 1; k < path.length; k++) expr = `C.seg(${expr},${JSON.stringify(path[k])})`;
    return expr;
  }
  function gen(list) {
    for (const n of list) {
      if (n.kind === 'text') parts.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') parts.push(`out.push(C.H(C.textOf(${pathExpr(n.path)})));`);
      else if (n.kind === 'raw') parts.push(`out.push(C.textOf(${pathExpr(n.path)}));`);
      else if (n.kind === 'if') {
        parts.push(`if(C.truthy(${pathExpr(n.path)})!==${n.not}){`);
        gen(n.then);
        if (n.else !== null) {
          parts.push('}else{');
          gen(n.else);
        }
        parts.push('}');
      } else if (n.kind === 'for') {
        const u = uid++;
        parts.push(`{const __a${u}=${pathExpr(n.path)};if(Array.isArray(__a${u})){const __n${u}=__a${u}.length;for(let __k${u}=0;__k${u}<__n${u};__k${u}++){V.push(${JSON.stringify(n.name)},__a${u}[__k${u}],{index:__k${u}+1,first:__k${u}===0,last:__k${u}===__n${u}-1,length:__n${u}});`);
        frames.push(n.name);
        gen(n.body);
        frames.pop();
        parts.push('V.length-=3;}}}');
      } else if (n.kind === 'include') {
        const u = uid++;
        parts.push(`{const __i${u}=C.T.get(${JSON.stringify(n.name)});if(__i${u}&&depth<${INCLUDE_DEPTH}){__i${u}(R,V,depth+1,out,C);}}`);
      }
    }
  }
  gen(nodes);
  return new Function('R', 'V', 'depth', 'out', 'C', parts.join(''));
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** slugify with a per-case cache (titles and tag names repeat across sources). */
function slugCached(b, text) {
  const c = b.slugCache;
  let s = c.get(text);
  if (s === undefined) {
    s = slugify(text);
    c.set(text, s);
  }
  return s;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugCached(b, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugCached(b, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugCached(b, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugCached(b, name)) ?? { name, slug: slugCached(b, name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. */
function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. Posts reuse their card from the cards map (same fields). */
function pageOf(b, s) {
  const card = s.post ? b.cards.get(s) : cardOf(b, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b, C) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ site, tags: allTags, recent, ...vars }, [], 0, out, C);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportFn(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const C = { T: templates, H: escapeHtml, textOf, truthy, seg, dyn };
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b, C);
  reportFn(b);
  return b.output;
}
