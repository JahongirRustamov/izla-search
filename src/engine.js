/*
 * Axborot qidirish (Information Retrieval) dvigateli.
 * UI'dan mustaqil: faqat sof funksiyalar. window.IR orqali ishlatiladi.
 *
 *   Indekslash:  tokenlash -> standartlash -> stop so'zlar -> stemming -> teskari indeks
 *   Qidirish:    so'rovni tahlil qilish -> Bulev ifoda (AND/OR/NOT) -> ro'yxatlar kesishmasi -> TF-IDF saralash
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1-2. Tokenlash va standartlash
  // ---------------------------------------------------------------------------

  // Turli apostrof belgilarini (ʻ ʼ ‘ ’ ` ´) bitta ' ga keltiramiz. Uzunlik o'zgarmaydi,
  // shuning uchun tokenlarning matndagi o'rni (offset) saqlanib qoladi.
  const APOSTROPHES = /[ʻʼ‘’`´]/g;
  const normalizeApostrophes = (s) => s.replace(APOSTROPHES, "'");

  // So'z = harflar; so'z ICHIDAGI apostrof so'zning bir qismi (o'qish, ma'no).
  // Raqamlar va tinish belgilari avtomatik tashlab yuboriladi.
  const WORD_SOURCE = "\\p{L}+(?:'\\p{L}+)*";

  // ---------------------------------------------------------------------------
  // 4. Stemming (qoidaga asoslangan, soddalashtirilgan o'zbek stemmeri)
  // ---------------------------------------------------------------------------

  const MIN_STEM = 3;
  const VOWELS = 'aeiou';

  // cond: 'vow' - o'zak unli bilan tugasa, 'cons' - undosh bilan tugasa, aks holda - har doim.
  const SUFFIX_LIST = [
    ['larning', 'ko\'plik + qaratqich'], ['lardan', 'ko\'plik + chiqish'], ['larga', 'ko\'plik + jo\'nalish'],
    ['larda', 'ko\'plik + o\'rin'], ['larni', 'ko\'plik + tushum'], ['lari', 'ko\'plik + egalik'],
    ['lar', 'ko\'plik'], ['imiz', 'egalik (bizning)'], ['ingiz', 'egalik (sizning)'],
    ['ining', 'qaratqich'], ['idan', 'chiqish'], ['iga', 'jo\'nalish'], ['ida', 'o\'rin'], ['ini', 'tushum'],
    ['ning', 'qaratqich'], ['dagi', 'o\'rin-belgi'], ['dan', 'chiqish kelishigi'], ['ni', 'tushum kelishigi'],
    ['ga', 'jo\'nalish kelishigi'], ['da', 'o\'rin kelishigi'], ['ing', 'egalik (sening)'], ['im', 'egalik (mening)'],
    ['lik', 'ot yasovchi'], ['lash', 'fe\'l yasovchi'], ['ish', 'harakat nomi'], ['moq', 'harakat nomi'],
    ['si', 'egalik (3-shaxs)', 'vow'], ['i', 'egalik (3-shaxs)', 'cons'],
  ];

  const RULES = SUFFIX_LIST
    .map(([suffix, meaning, cond]) => ({ suffix, meaning, cond: cond || 'any' }))
    .sort((a, b) => b.suffix.length - a.suffix.length); // eng uzun qo'shimcha birinchi

  // Qo'shimcha kesilmasligi kerak bo'lgan so'zlar (atoqli otlar, istisnolar, chet so'zlar).
  const PROTECTED = new Set([
    'karim', 'salim', 'rahim', 'hakim', 'teskari', 'tizim', 'muhim', 'ta\'lim',
    'stemming', 'postings', 'indexing', 'dictionary', 'information', 'retrieval',
  ]);

  function stem(word) {
    const steps = [];
    if (PROTECTED.has(word)) return { stem: word, steps, protected: true };

    let w = word;
    for (let pass = 0; pass < 4; pass++) { // ko'p qatlamli qo'shimchalar: kitob-lar-imiz-da
      let hit = null;
      for (const rule of RULES) {
        if (!w.endsWith(rule.suffix)) continue;
        const base = w.slice(0, -rule.suffix.length);
        if (base.length < MIN_STEM) continue; // o'zak juda qisqa bo'lib qolmasin
        const vowelEnd = VOWELS.includes(base[base.length - 1]);
        if (rule.cond === 'vow' && !vowelEnd) continue;
        if (rule.cond === 'cons' && (vowelEnd || w.length < 5)) continue;
        hit = { rule, base };
        break;
      }
      if (!hit) break;
      steps.push({ suffix: hit.rule.suffix, meaning: hit.rule.meaning, from: w, to: hit.base });
      w = hit.base;
      if (PROTECTED.has(w)) break;
    }
    return { stem: w, steps, protected: false };
  }

  /**
   * Matnni to'liq tahlil qiladi. Har bir token uchun barcha bosqich natijasi saqlanadi:
   * { raw, start, end, lower, stop, term, steps }
   * term === null  =>  stop so'z, indeksga kirmaydi.
   */
  function analyze(text, stopSet) {
    const src = normalizeApostrophes(text);
    const re = new RegExp(WORD_SOURCE, 'gu');
    const tokens = [];
    let m;
    while ((m = re.exec(src))) {
      const raw = m[0];
      const lower = raw.toLowerCase();
      const stop = stopSet.has(lower);
      let term = null;
      let steps = [];
      let isProtected = false;
      if (!stop) {
        const r = stem(lower);
        term = r.stem;
        steps = r.steps;
        isProtected = r.protected;
      }
      tokens.push({ raw, start: m.index, end: m.index + raw.length, lower, stop, term, steps, protected: isProtected });
    }
    return tokens;
  }

  /** Tokenlashda tashlab yuborilgan belgilar (tinish belgilari, raqamlar). */
  function droppedSymbols(text) {
    return normalizeApostrophes(text).match(/[^\p{L}'\s]+|(?<![\p{L}])'+|'+(?![\p{L}])/gu) || [];
  }

  // ---------------------------------------------------------------------------
  // 5. Teskari indeks
  // ---------------------------------------------------------------------------

  /**
   * docs: [{id, name, title, text}]
   * Natija: dict = Map(term -> { term, df, cf, postings:[{doc, tf}], tfByDoc:Map })
   * postings hujjat raqami bo'yicha o'sish tartibida — kesishma algoritmi shunga tayanadi.
   */
  function buildIndex(docs, stopSet) {
    const dict = new Map();
    const indexedDocs = docs.map((d) => {
      const tokens = analyze(d.text, stopSet);
      const counts = new Map();
      for (const t of tokens) {
        if (t.term !== null) counts.set(t.term, (counts.get(t.term) || 0) + 1);
      }
      counts.forEach((tf, term) => {
        let e = dict.get(term);
        if (!e) {
          e = { term, df: 0, cf: 0, postings: [], tfByDoc: new Map() };
          dict.set(term, e);
        }
        e.df += 1;
        e.cf += tf;
        e.postings.push({ doc: d.id, tf });
        e.tfByDoc.set(d.id, tf);
      });
      return { ...d, tokens, termCount: counts.size };
    });
    return { dict, docs: indexedDocs, N: indexedDocs.length, stop: stopSet, allIds: indexedDocs.map((d) => d.id) };
  }

  // ---------------------------------------------------------------------------
  // 6. Ro'yxatlarni birlashtirish algoritmlari (har qadami yoziladi — vizualizatsiya uchun)
  // ---------------------------------------------------------------------------

  /** AND: ikki ko'rsatkichli kesishma, O(x + y). */
  function intersect(p1, p2) {
    const steps = [];
    const result = [];
    let i = 0, j = 0;
    while (i < p1.length && j < p2.length) {
      const a = p1[i], b = p2[j];
      if (a === b) {
        result.push(a);
        i++; j++;
        steps.push({ a, b, action: 'match', ni: i, nj: j, resLen: result.length });
      } else if (a < b) {
        i++;
        steps.push({ a, b, action: 'adv1', ni: i, nj: j, resLen: result.length });
      } else {
        j++;
        steps.push({ a, b, action: 'adv2', ni: i, nj: j, resLen: result.length });
      }
    }
    return { result, steps };
  }

  /** OR: ikki ko'rsatkichli birlashma, O(x + y). */
  function union(p1, p2) {
    const steps = [];
    const result = [];
    let i = 0, j = 0;
    while (i < p1.length && j < p2.length) {
      const a = p1[i], b = p2[j];
      if (a === b) {
        result.push(a); i++; j++;
        steps.push({ a, b, action: 'both', ni: i, nj: j, resLen: result.length });
      } else if (a < b) {
        result.push(a); i++;
        steps.push({ a, b, action: 'take1', ni: i, nj: j, resLen: result.length });
      } else {
        result.push(b); j++;
        steps.push({ a, b, action: 'take2', ni: i, nj: j, resLen: result.length });
      }
    }
    while (i < p1.length) {
      const a = p1[i]; result.push(a); i++;
      steps.push({ a, action: 'tail1', ni: i, nj: j, resLen: result.length });
    }
    while (j < p2.length) {
      const b = p2[j]; result.push(b); j++;
      steps.push({ b, action: 'tail2', ni: i, nj: j, resLen: result.length });
    }
    return { result, steps };
  }

  // ---------------------------------------------------------------------------
  // 7. So'rovni tahlil qilish (parser): AND, OR, NOT, qavslar, -so'z
  //    Ustuvorlik: NOT > AND > OR. Operatorsiz yonma-yon so'zlar `implicit` operator bilan bog'lanadi.
  // ---------------------------------------------------------------------------

  function lex(query, stopSet, ignored) {
    const src = normalizeApostrophes(query);
    const out = [];
    const parts = src.match(/\(|\)|[^\s()]+/g) || [];
    for (let part of parts) {
      if (part === '(' || part === ')') { out.push({ t: part }); continue; }
      if (part === 'AND' || part === 'OR' || part === 'NOT') { out.push({ t: part }); continue; }
      if (part.length > 1 && part[0] === '-') { out.push({ t: 'NOT' }); part = part.slice(1); }
      for (const tok of analyze(part, stopSet)) {
        if (tok.stop) { ignored.push(tok.raw); continue; }
        out.push({ t: 'TERM', raw: tok.raw, lower: tok.lower, term: tok.term, steps: tok.steps });
      }
    }
    return out;
  }

  function parse(lexemes, implicit) {
    let p = 0;
    const warnings = [];
    const peek = () => lexemes[p];
    const startsOperand = (x) => x && (x.t === 'TERM' || x.t === 'NOT' || x.t === '(');
    const combine = (type, left, right) => (!left ? right : !right ? left : { type, left, right });

    function parseOr() {
      let left = parseAnd();
      while (peek() && (peek().t === 'OR' || (implicit === 'OR' && startsOperand(peek())))) {
        if (peek().t === 'OR') p++;
        left = combine('OR', left, parseAnd());
      }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (peek() && (peek().t === 'AND' || (implicit === 'AND' && startsOperand(peek())))) {
        if (peek().t === 'AND') p++;
        left = combine('AND', left, parseNot());
      }
      return left;
    }
    function parseNot() {
      const x = peek();
      if (x && x.t === 'NOT') {
        p++;
        const child = parseNot();
        return child ? { type: 'NOT', child } : null;
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const x = peek();
      if (!x) { warnings.push("So'rov kutilmaganda tugadi (operator yonida so'z yo'q)."); return null; }
      if (x.t === '(') {
        p++;
        const e = parseOr();
        if (peek() && peek().t === ')') p++;
        else warnings.push("Qavs yopilmagan.");
        return e;
      }
      if (x.t === 'TERM') { p++; return { type: 'TERM', raw: x.raw, term: x.term, steps: x.steps }; }
      // kutilmagan operator yoki ')' — o'tkazib yuboramiz
      p++;
      warnings.push(`Kutilmagan "${x.t}" belgisi e'tiborsiz qoldirildi.`);
      return x.t === ')' ? null : parsePrimary();
    }

    let ast = parseOr();
    while (p < lexemes.length) { // ortib qolgan ")" kabilar
      warnings.push(`Ortiqcha "${lexemes[p].t}" e'tiborsiz qoldirildi.`);
      p++;
      ast = combine(implicit, ast, parseOr());
    }
    return { ast, warnings };
  }

  // ---------------------------------------------------------------------------
  // 8. Bajarish va saralash
  // ---------------------------------------------------------------------------

  function evaluate(node, index, ops) {
    switch (node.type) {
      case 'TERM': {
        const entry = index.dict.get(node.term);
        const list = entry ? entry.postings.map((p) => p.doc) : [];
        ops.push({ kind: 'TERM', label: node.term, word: node.raw, inDict: !!entry, result: list, inputs: [] });
        return { list, label: node.term };
      }
      case 'NOT': {
        const c = evaluate(node.child, index, ops);
        const set = new Set(c.list);
        const result = index.allIds.filter((id) => !set.has(id));
        const label = `NOT ${c.label}`;
        ops.push({ kind: 'NOT', label, inputs: [c], result });
        return { list: result, label: `(${label})` };
      }
      default: { // AND | OR
        const l = evaluate(node.left, index, ops);
        const r = evaluate(node.right, index, ops);
        const { result, steps } = node.type === 'AND' ? intersect(l.list, r.list) : union(l.list, r.list);
        const label = `${l.label} ${node.type} ${r.label}`;
        ops.push({ kind: node.type, label, inputs: [l, r], result, steps });
        return { list: result, label: `(${label})` };
      }
    }
  }

  /** NOT ostidagi so'zlar ball hisoblashga kirmaydi. */
  function positiveTerms(node, negated = false, acc = new Set()) {
    if (!node) return acc;
    if (node.type === 'TERM') { if (!negated) acc.add(node.term); }
    else if (node.type === 'NOT') positiveTerms(node.child, !negated, acc);
    else { positiveTerms(node.left, negated, acc); positiveTerms(node.right, negated, acc); }
    return acc;
  }

  /** TF-IDF: sum( (1 + log10 tf) * log10(N / df) ) */
  function rank(index, ids, terms) {
    const rows = ids.map((id) => {
      let score = 0;
      const hits = [];
      for (const term of terms) {
        const e = index.dict.get(term);
        const tf = e ? e.tfByDoc.get(id) || 0 : 0;
        if (!tf) continue;
        const idf = Math.log10(index.N / e.df);
        score += (1 + Math.log10(tf)) * idf;
        hits.push({ term, tf, idf });
      }
      return { id, score, hits };
    });
    return rows.sort((x, y) => y.score - x.score || x.id - y.id);
  }

  function search(index, query, implicit = 'AND') {
    const ignored = [];
    const lexemes = lex(query, index.stop, ignored);
    const { ast, warnings } = parse(lexemes, implicit);
    const ops = [];
    let ids = [];
    let terms = new Set();
    if (ast) {
      ids = evaluate(ast, index, ops).list;
      terms = positiveTerms(ast);
    }
    const ranked = rank(index, ids, terms);
    return { query, ast, ops, ids, ranked, terms, ignored, warnings, empty: !ast };
  }

  // ---------------------------------------------------------------------------
  // Matn bo'laklari (belgilash uchun)
  // ---------------------------------------------------------------------------

  /** [{text, hit}] — termSet'dagi o'zakli tokenlarni belgilaydi. */
  function segments(doc, termSet, from = 0, to = doc.text.length) {
    const out = [];
    let pos = from;
    for (const t of doc.tokens) {
      if (t.end <= from || t.start >= to) continue;
      if (t.start > pos) out.push({ text: doc.text.slice(pos, t.start), hit: false });
      out.push({ text: doc.text.slice(t.start, t.end), hit: t.term !== null && termSet.has(t.term) });
      pos = t.end;
    }
    if (pos < to) out.push({ text: doc.text.slice(pos, to), hit: false });
    return out;
  }

  /** Birinchi mos kelgan joy atrofidagi parcha. */
  function snippet(doc, termSet, before = 80, after = 150) {
    const first = doc.tokens.find((t) => t.term !== null && termSet.has(t.term));
    if (!first) return { segs: segments(doc, termSet, 0, Math.min(doc.text.length, before + after)), head: false, tail: doc.text.length > before + after };
    let from = Math.max(0, first.start - before);
    let to = Math.min(doc.text.length, first.end + after);
    if (from > 0) { const sp = doc.text.indexOf(' ', from); if (sp !== -1 && sp < first.start) from = sp + 1; }
    return { segs: segments(doc, termSet, from, to), head: from > 0, tail: to < doc.text.length };
  }

  // ---------------------------------------------------------------------------
  // 9. Reytingli qidiruv: TF-IDF vektorlar + kosinus o'xshashlik
  //    (Google kabi qidiruv tizimlarining asosiy g'oyasi: teskari indeks + og'irlik)
  //
  //   idf(t)      = log10(1 + N / df)
  //   w(t, d)     = (1 + log10 tf) * idf(t)          — hujjat vektori
  //   w(t, q)     = (1 + log10 qtf) * idf(t)         — so'rov vektori
  //   cos(q, d)   = sum_t w(t,q)*w(t,d) / (|q| * |d|)
  //
  //   Hisoblash "termin bo'yicha" (term-at-a-time) bajariladi: faqat so'rovdagi
  //   terminlarning postings ro'yxatlari ko'riladi, qolgan hujjatlarga tegilmaydi.
  // ---------------------------------------------------------------------------

  const idfOf = (index, df) => Math.log10(1 + index.N / df);
  const tfw = (tf) => 1 + Math.log10(tf);

  /** Indeks qurilgach, har bir posting'ga og'irlik va har bir hujjatga vektor uzunligini qo'shadi. */
  function weigh(index) {
    const norm2 = new Map(index.allIds.map((id) => [id, 0]));
    index.dict.forEach((e) => {
      e.idf = idfOf(index, e.df);
      e.postings.forEach((p) => {
        p.w = tfw(p.tf) * e.idf;
        norm2.set(p.doc, norm2.get(p.doc) + p.w * p.w);
      });
    });
    index.norm = new Map([...norm2].map(([id, v]) => [id, Math.sqrt(v)]));
    return index;
  }

  function rankedSearch(index, query) {
    const t0 = performance.now();
    const tokens = analyze(query, index.stop);
    const ignored = tokens.filter((t) => t.stop).map((t) => t.raw);

    // so'rov terminlari va ularning chastotasi
    const qtf = new Map();
    tokens.forEach((t) => { if (t.term !== null) qtf.set(t.term, (qtf.get(t.term) || 0) + 1); });

    const terms = [];       // so'rov vektori
    const unknown = [];     // lug'atda yo'q terminlar
    let qNorm2 = 0;
    qtf.forEach((n, term) => {
      const e = index.dict.get(term);
      if (!e) { unknown.push(term); return; }
      const wq = tfw(n) * e.idf;
      qNorm2 += wq * wq;
      terms.push({ term, qtf: n, df: e.df, idf: e.idf, wq, postings: e.postings });
    });
    const qNorm = Math.sqrt(qNorm2);

    // termin bo'yicha yig'ish: acc[doc] += w(t,q) * w(t,d)
    const acc = new Map();
    for (const t of terms) {
      for (const p of t.postings) {
        let a = acc.get(p.doc);
        if (!a) { a = { id: p.doc, dot: 0, parts: [] }; acc.set(p.doc, a); }
        const part = t.wq * p.w;
        a.dot += part;
        a.parts.push({ term: t.term, tf: p.tf, idf: t.idf, wd: p.w, wq: t.wq, part });
      }
    }
    const results = [...acc.values()]
      .map((a) => ({ ...a, score: qNorm ? a.dot / (qNorm * index.norm.get(a.id)) : 0 }))
      .sort((x, y) => y.score - x.score || x.id - y.id);

    return {
      tokens, ignored, terms, unknown, qNorm, results,
      termSet: new Set(terms.map((t) => t.term)),
      ms: performance.now() - t0,
    };
  }

  global.IR = {
    weigh, rankedSearch,
    RULES, PROTECTED, analyze, stem, droppedSymbols, buildIndex,
    intersect, union, search, segments, snippet, normalizeApostrophes,
  };
})(window);
