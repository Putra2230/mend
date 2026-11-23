// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 3: a file as lines with its own line break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}
function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}
function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** Section 5: line equality at a tier. */
function eqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where o occurs in lines at tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eqAt(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, or 0..2) at which o occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const at = occurrences(lines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** As findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const at = occurrences(lines, o, t).filter((p) => p >= from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (eqAt(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One line of an old or a new side: its text, and whether it is a context line. */
interface PL {
  t: string;
  c: boolean;
}

/**
 * The lines that replace the matched lines at pos. A context line of n is written as the
 * file's own matched line; at tier 2 every other line of n is re-indented from the leading
 * spaces and tabs of o's first line to those of the file's first matched line.
 */
function replacementLines(doc: Doc, o: PL[], n: PL[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const oCtx: number[] = [];
  for (let i = 0; i < o.length; i++) if (o[i]!.c) oCtx.push(i);
  const f = tier === 2 && o.length > 0 ? leadWs(doc.lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!.t) : '';
  let seen = 0;
  for (const line of n) {
    if (line.c) {
      out.push(doc.lines[pos + oCtx[seen]!]!);
      seen += 1;
    } else if (tier === 2 && !onlyWs(line.t) && line.t.startsWith(p)) {
      out.push(f + line.t.slice(p.length));
    } else {
      out.push(line.t);
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\\' marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  havePair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  plusNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffA: string;
  diffB: string;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** A path from a `--- ` or `+++ ` line: after the four characters, to the first tab, trimmed. */
function headerPath(rest: string): string | null {
  let p = rest.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse one hunk body starting after the header at `start`; returns the hunk and the next line. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[start]!);
  if (m === null) throw new Exit2(`error: parse ${start + 1}`);
  const a = parseInt(m[1]!, 10);
  const body: BodyLine[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (isDiffGit(l)) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j++;
      continue;
    }
    const k = l[0]!;
    if (k === ' ' || k === '-' || k === '+' || k === '\\') {
      body.push({ kind: k, text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { hunk: { a, body }, next: j };
}

/** The old and new sides of a hunk or chunk body. */
function bodySides(body: BodyLine[]): { o: PL[]; n: PL[] } {
  const o: PL[] = [];
  const n: PL[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push({ t: b.text, c: true });
      n.push({ t: b.text, c: true });
    } else if (b.kind === '-') o.push({ t: b.text, c: false });
    else if (b.kind === '+') n.push({ t: b.text, c: false });
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bodyNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === '\\';
}

/** Section 6: read the patch's sections. */
function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { havePair: false, pairOld: null, pairNew: null, plusNew: null, renameFrom: null, renameTo: null, diffA: m[1]!, diffB: m[2]!, creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.havePair) {
        cur.pairOld = headerPath(l.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.havePair = true;
        i += 2;
        continue;
      }
      cur = { havePair: true, pairOld: headerPath(l.slice(4)), pairNew: headerPath(lines[i + 1]!.slice(4)), plusNew: null, renameFrom: null, renameTo: null, diffA: '', diffB: '', creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        if (!cur.havePair) cur.plusNew = headerPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.creation = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletion = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const r = parseHunkBody(lines, i);
        cur.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const r = parseHunkBody(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  return sections;
}

/** The old and new path a section names: the ---/+++ pair, else rename, else diff --git. */
function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  const oldP = s.havePair ? s.pairOld : s.renameFrom ?? (s.diffA === '' ? null : s.diffA);
  const newP = s.havePair ? s.pairNew : s.plusNew ?? s.renameTo ?? (s.diffB === '' ? null : s.diffB);
  return { oldP, newP };
}

/** Apply a section's hunks in order to a document. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodySides(h.body);
    const noEol = bodyNoEol(h.body);
    if (o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > cur.lines.length) at = cur.lines.length;
      const rep = n.map((l) => l.t);
      const lines = [...cur.lines.slice(0, at), ...rep, ...cur.lines.slice(at)];
      const fin = at === cur.lines.length ? !noEol : cur.final;
      cur = { br: cur.br, lines, final: fin };
      d += n.length;
    } else {
      const found = findTier(cur.lines, o.map((x) => x.t), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = replacementLines(cur, o, n, best, found.tier);
      const lines = [...cur.lines.slice(0, best), ...rep, ...cur.lines.slice(best + o.length)];
      const fin = best + o.length === cur.lines.length ? !noEol : cur.final;
      cur = { br: cur.br, lines, final: fin };
      d += n.length - o.length;
    }
  }
  return cur;
}

/** One unified section as an edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = sectionPaths(s);
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (s.creation || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        let last = -1;
        for (let k = 0; k < h.body.length; k++) if (h.body[k]!.kind === '+') last = k;
        if (last >= 0) noEol = h.body[last + 1]?.kind === '\\';
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (s.deletion || newP === null) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(parseDoc(cur), s.hunks, strict, oldP);
      tree.now.set(newP, renderDoc(doc));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const doc = applyHunks(parseDoc(cur), s.hunks, strict, oldP);
    tree.now.set(oldP, renderDoc(doc));
  };
}

/** Section 7: one SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const o: PL[] = oldLines.map((t) => ({ t, c: false }));
    const n: PL[] = newLines.map((t) => ({ t, c: false }));
    const at = found.at[0]!;
    const rep = replacementLines(doc, o, n, at, found.tier);
    const lines = [...doc.lines.slice(0, at), ...rep, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderDoc({ br: doc.br, lines, final: doc.final }));
  };
}

/** Section 7: read the patch's SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, old and new sides, and whether it ends the file. */
interface VChunk {
  anchor: string | null;
  o: PL[];
  n: PL[];
  eof: boolean;
}

/** Parse an Update File section's raw lines into its move target and chunks. */
function parseV4aUpdate(raw: { text: string; line: number }[], headerLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: BodyLine[]; eof: boolean } | null = null;
  const close = (): void => {
    if (cur === null) return;
    const { o, n } = bodySides(cur.body);
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      close();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.line}`);
      cur.eof = true;
      close();
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.line}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (l === '' && chunks.length > 0) continue;
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.line}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.line}`);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { moveTo, chunks };
}

/** Section 8: read the patch's V4A sections. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const raw: { text: string; line: number }[] = [];
    while (i < last) {
      const s = lines[i]!;
      if (isSectionStart(s) || s.trim() === '*** End Patch') break;
      raw.push({ text: s, line: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, text);
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const { moveTo, chunks } = parseV4aUpdate(raw, headerLine);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const cur = tree.get(path);
        if (cur === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let doc = parseDoc(cur);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
            if (at === null) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          if (ch.o.length === 0) {
            const at = ch.eof ? doc.lines.length : cursor;
            const rep = ch.n.map((x) => x.t);
            doc = { br: doc.br, lines: [...doc.lines.slice(0, at), ...rep, ...doc.lines.slice(at)], final: doc.final };
            cursor = at + rep.length;
          } else {
            const found = findTierFrom(doc.lines, ch.o.map((x) => x.t), cursor, strict);
            if (found === null) throw new Fail('no-match', path);
            let pos: number | null = null;
            if (ch.eof) {
              for (const p of found.at) {
                if (p + ch.o.length === doc.lines.length) {
                  pos = p;
                  break;
                }
              }
              if (pos === null) throw new Fail('no-match', path);
            } else {
              pos = found.at[0]!;
            }
            const rep = replacementLines(doc, ch.o, ch.n, pos, found.tier);
            doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + ch.o.length)], final: doc.final };
            cursor = pos + rep.length;
          }
        }
        const text = renderDoc(doc);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(path, null);
          tree.moves.push({ old: path, new: moveTo });
        } else {
          tree.now.set(path, text);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedSections(lines).map((s) => unifiedEdit(s, strict))
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(`D:${m.old}`);
      covered.add(`A:${m.new}`);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    if (covered.has(`${tag}:${p}`)) continue;
    rows.push({ key: p, line: `${tag} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
