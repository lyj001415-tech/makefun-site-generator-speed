// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Reimplements build() byte-for-byte; structured for speed:
//  - Markdown rendered in one pass, no token arrays, plain-text runs escaped in bulk.
//  - Front matter parsed by hand, no per-line regexes.
//  - slugify has an ASCII fast path (NFKD is the identity on ASCII).
//  - Templates render from the parsed node tree with a scope stack and an output array.
// Dependency-free ES module; run(input) returns the output tree. No I/O, no clock, no network.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  // String.replace returns the input unchanged when nothing matches: one scan.
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const SLUG_MAX = 64;

function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
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

export function slugify(text) {
  // NFKD is the identity on ASCII, and combining marks are non-ASCII, so an
  // all-ASCII string can take the char-code loop directly.
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return slugifySlow(text);
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  if (out.endsWith('-')) out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

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
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
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

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // '#'
    // key: a-z/_ run, then ':', then ' ' + value (or end of line).
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // trailing spaces/tabs dropped
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

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

/** `s` rendered inline; `env.link(target)` resolves a link target. */
const INLINE_SPECIAL = /[\\`*[]/g;
export function inline(s, env) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Batch plain text up to the next inline-significant character (C++ scan).
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) {
      out.push(escapeHtml(s.slice(i, j)));
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      const n2 = s[i + 1];
      out.push(n2 === '>' ? '&gt;' : n2);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>', inline(s.slice(i + 2, k), env), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out.push('<em>', inline(s.slice(i + 1, k), env), '</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A lone backslash or any other single character (reached only for '\\'
    // not followed by an escapable, since the batch loop stops at the rest).
    out.push(escapeHtml(c));
    i++;
  }
  return out.join('');
}

function trimLine(line) {
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isFenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 '#', at least one space/tab, then text (trailing spaces/tabs dropped).
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35 && d < 6) d++;
  if (d === 0 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(d));
  if (text === '') return null;
  return { depth: d, text };
}

function isHr(line) {
  if (line !== '---' && line !== '***') {
    if (!line.startsWith('---') && !line.startsWith('***')) return false;
    const head = line.slice(0, 3);
    if (head !== '---' && head !== '***') return false;
    for (let i = 3; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return true;
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return isFenceOpen(line) !== null; // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return isHr(line); // '-' or '*'
  return false;
}

/**
 * The body's lines rendered: { html, toc, excerpt }. Single pass; blocks are
 * rendered straight into the output array. `lines` is the source's line array
 * (from parseFrontMatter), `from` the first body line.
 */
export function renderMarkdown(lines, from, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    const lang = c0 === 96 ? isFenceOpen(line) : null; // '`'
    if (lang !== null) {
      const body = [];
      i++;
      while (i < total && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (let k = 0; k < body.length; k++) code += `${escapeHtml(body[k])}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null; // '#'
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      // '-' or '*'
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      // '>'
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    // List: '- ' / '* ' bullet, or digits + '. ' ordered.
    let bullet = false;
    let ordered = false;
    let start = 1;
    let itemText = null;
    if (line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) {
      bullet = true;
      itemText = line.slice(2);
    } else {
      // ordered: 1-9 digits then '. '
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57 && d < 9) d++;
      if (d > 0 && d < line.length && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, d));
        itemText = line.slice(d + 2);
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < total) {
        const l = lines[i];
        let m = null;
        if (bullet) {
          if (l.length >= 2 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
        } else {
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57 && d < 9) d++;
          if (d > 0 && d < l.length && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) m = l.slice(d + 2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (/^ {2,}\S/.test(l)) {
          // CONTINUED: two or more spaces then a non-space.
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${html}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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

export function parseTemplate(name, src) {
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

function lookup(frames, path) {
  for (let s = frames.length - 1; s >= 0; s--) {
    const vars = frames[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Runtime helpers a compiled template calls. */
const RT = { look: lookup, text: textOf, esc: escapeHtml, truthy };

/**
 * A parsed template compiled to a function (F: scope frames, T: compiled
 * templates, D: include depth, o: output array, R: helpers). The node tree is
 * walked once, at compile time; rendering is straight-line code with the same
 * lookup, truthiness and include-depth rules as the reference renderer.
 */
function compileTemplate(nodes) {
  const paths = [];
  const pathIndex = new Map();
  const pid = (path) => {
    const key = JSON.stringify(path);
    let i = pathIndex.get(key);
    if (i === undefined) {
      i = paths.length;
      paths.push(path);
      pathIndex.set(key, i);
    }
    return i;
  };
  const parts = [];
  const gen = (ns) => {
    for (let ni = 0; ni < ns.length; ni++) {
      const n = ns[ni];
      switch (n.kind) {
        case 'text':
          parts.push(`o.push(${JSON.stringify(n.text)});`);
          break;
        case 'var':
          parts.push(`o.push(R.esc(R.text(R.look(F,P${pid(n.path)}))));`);
          break;
        case 'raw':
          parts.push(`o.push(R.text(R.look(F,P${pid(n.path)})));`);
          break;
        case 'if': {
          parts.push(`if(R.truthy(R.look(F,P${pid(n.path)}))!==${n.not}){`);
          gen(n.then);
          if (n.else !== null) {
            parts.push('}else{');
            gen(n.else);
          }
          parts.push('}');
          break;
        }
        case 'for': {
          const p = pid(n.path);
          parts.push(`{const xs=R.look(F,P${p});if(Array.isArray(xs)){for(let k=0;k<xs.length;k++){const v={};v[${JSON.stringify(n.name)}]=xs[k];v.loop={index:k+1,first:k===0,last:k===xs.length-1,length:xs.length};F.push(v);`);
          gen(n.body);
          parts.push('F.pop();}}}');
          break;
        }
        case 'include':
          parts.push(`{const t=T.get(${JSON.stringify(n.name)});if(t!==undefined&&D<8)t(F,T,D+1,o,R);}`);
          break;
      }
    }
  };
  gen(nodes);
  const decls = paths.map((p, i) => `const P${i}=${JSON.stringify(p)};`).join('');
  return new Function('F', 'T', 'D', 'o', 'R', decls + parts.join(''));
}

// ---------------------------------------------------------------- build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Words in the body's lines: runs of non-whitespace, exactly as /\S+/g counts. */
function wordsOfLines(lines, from) {
  let n = 0;
  for (let li = from; li < lines.length; li++) {
    const text = lines[li];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // JS \s (no unicode flag): \t\n\v\f\r space, U+00A0, U+1680, U+2000-U+200A,
      // U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
      const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (!ws) {
        if (!inWord) {
          n++;
          inWord = true;
        }
      } else inWord = false;
    }
  }
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

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyFrom) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, card) {
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

export function build(input) {
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let ti = 0; ti < tNames.length; ti++) {
    const name = tNames[ti];
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, sorted by path; .md sources vs statics.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter + refusal checks, in order.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticPaths.add(statics[fi].path);
  const broken = new Set();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
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
    const md = renderMarkdown(s.lines, s.bodyFrom, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = [];
  for (let si = 0; si < kept.length; si++) if (kept[si].post) posts.push(kept[si]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags. Tag names repeat across posts, so their slugs are memoised per case.
  const bySlug = new Map();
  const slugCache = new Map();
  const slugCached = (name) => {
    let slug = slugCache.get(name);
    if (slug === undefined) {
      slug = slugify(name);
      slugCache.set(name, slug);
    }
    return slug;
  };
  const ownTagsOf = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugCached(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    for (const name of ownTagsOf(p)) {
      const slug = slugCached(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    s.tagRefs = ownTagsOf(s).map((name) => {
      const slug = slugCached(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const output = {};
  const cards = new Map();
  for (let pi = 0; pi < posts.length; pi++) cards.set(posts[pi], cardOf(posts[pi]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    const full = { site, tags: allTags, recent, ...vars };
    fn([full], templates, 0, out, RT);
    return out.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    // A post's card is already built (and its words counted once); reuse it.
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : cardOf(s)) });
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
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let si = 0; si < kept.length; si++) if (!kept[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

export function run(input) {
  return build(input);
}
