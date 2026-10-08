const { useState, useMemo, useEffect } = React;

/* ============================================================================
 * Ma'lumotlarni yuklash (data/ papkasidagi .txt fayllar)
 * ========================================================================== */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} yuklanmadi (${res.status})`);
  return res.text();
}

async function loadData() {
  const manifest = JSON.parse(await fetchText('data/docs.json'));
  const stopText = await fetchText('data/stopwords.txt');
  const stop = new Set(
    stopText.split(/\r?\n/).map((l) => IR.normalizeApostrophes(l.trim().toLowerCase())).filter((l) => l && !l.startsWith('#'))
  );
  const docs = await Promise.all(manifest.files.map(async (file, i) => {
    const raw = (await fetchText('data/docs/' + file)).replace(/^﻿/, '');
    const [title, ...rest] = raw.split(/\r?\n/);
    return { id: i + 1, file, title: title.trim(), text: rest.join(' ').trim() };
  }));
  return { docs, stop };
}

const f3 = (x) => x.toFixed(3);

/* ============================================================================
 * Algoritm "kadrlari". Har bir kadr — bitta qadam. Animatsiya shu kadrlarni
 * birma-bir ijro etadi, ekran esa faqat "hozirgi kadr"ga qarab chiziladi.
 *
 *  1 tokenlash   2 kichik harf   3 stop so'z   4 o'zak      (har token uchun bitta kadr)
 *  5 postings    (har termin uchun bitta kadr)
 *  6 hisoblash   acc[doc] += w(t,q)·w(t,d)   (har posting uchun bitta kadr)
 *  7 kosinus     acc / (|q|·|d|)
 *  8 saralash
 * ========================================================================== */
const PHASES = [
  { n: 1, short: 'Tokenlash' }, { n: 2, short: 'Kichik harf' }, { n: 3, short: 'Stop so\'z' }, { n: 4, short: 'O\'zak' },
  { n: 5, short: 'Postings' }, { n: 6, short: 'Hisoblash' }, { n: 7, short: 'Kosinus' }, { n: 8, short: 'Saralash' },
];
const PHASE_DELAY = { 1: 220, 2: 220, 3: 260, 4: 380, 5: 700, 6: 480, 7: 1100, 8: 1000 };

function buildTrace(out) {
  const T = out.tokens.length;
  const lookups = [...out.terms.map((t) => ({ ...t, unknown: false })), ...out.unknown.map((u) => ({ term: u, unknown: true, postings: [] }))];
  const ops = [];
  out.terms.forEach((t, ti) => t.postings.forEach((p) => ops.push({ ti, term: t.term, doc: p.doc, tf: p.tf, wq: t.wq, wd: p.w, part: t.wq * p.w })));
  const base5 = 4 * T;
  const base6 = base5 + lookups.length;
  const i7 = base6 + ops.length;
  return { T, lookups, ops, base5, base6, i7, i8: i7 + 1, length: i7 + 2 };
}

function phaseAt(trace, f) {
  if (f < 0) return 0;
  if (f < trace.base5) return Math.floor(f / trace.T) + 1;
  if (f < trace.base6) return 5;
  if (f < trace.i7) return 6;
  return f === trace.i7 ? 7 : 8;
}

/* ============================================================================
 * Chap tomon: natijalar (ballar animatsiya bilan yig'iladi)
 * ========================================================================== */
function DocModal({ doc, termSet, onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const segs = useMemo(() => IR.segments(doc, termSet), [doc, termSet]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={doc.title}>
        <div className="modal-head">
          <span className="tag">H{doc.id}</span>
          <h2>{doc.title}</h2>
          <button onClick={onClose} aria-label="Yopish">✕</button>
        </div>
        <p className="full">
          {segs.map((x, i) => (x.hit ? <mark key={i}>{x.text}</mark> : <span key={i}>{x.text}</span>))}
        </p>
        <div className="modal-foot">data/docs/{doc.file} · qidiruv so'zlari belgilangan · yopish: Esc</div>
      </div>
    </div>
  );
}

function ResultsLive({ index, out, trace, f, onOpen }) {
  const nDone = Math.max(0, Math.min(trace.ops.length, f - trace.base6 + 1));
  const phase = phaseAt(trace, f);
  const current = phase === 6 ? trace.ops[nDone - 1] : null;

  const rows = useMemo(() => {
    const dot = new Map(); // ko'rinish tartibi saqlanadi (Map)
    for (let k = 0; k < nDone; k++) dot.set(trace.ops[k].doc, (dot.get(trace.ops[k].doc) || 0) + trace.ops[k].part);
    let list = [...dot].map(([id, d]) => ({ id, dot: d, cos: d / (out.qNorm * index.norm.get(id)) }));
    if (phase === 7) list.sort((a, b) => a.id - b.id);
    if (phase >= 8) list.sort((a, b) => b.cos - a.cos || a.id - b.id);
    return list;
  }, [nDone, phase, out, trace, index]);

  const showCos = phase >= 7;
  const maxVal = Math.max(1e-9, ...out.results.map((r) => (showCos ? r.score : r.dot)));

  if (phase < 6) {
    return <div className="waiting">Natijalar hisoblash bosqichida paydo bo'ladi{phase ? '…' : '. ▶ tugmasini bosing.'}</div>;
  }
  return (
    <div>
      {rows.map((r, rank) => {
        const doc = index.docs[r.id - 1];
        const val = showCos ? r.cos : r.dot;
        const active = current && current.doc === r.id;
        return (
          <article key={r.id} className={'hit clickable' + (active ? ' active' : '')} tabIndex={0}
            onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.id); }}
            title="To'liq matnni o'qish uchun bosing">
            <div className="hit-top">
              {phase >= 8 && <span className="pos">{rank + 1}</span>}
              <h3>{doc.title}</h3>
              <span className="tag">H{r.id}</span>
            </div>
            <div className="meter">
              <div className="bar" style={{ width: Math.max(3, (val / maxVal) * 100) + '%' }} />
              <span className="val">{showCos ? 'cos = ' : 'Σ = '}{f3(val)}</span>
            </div>
            {phase >= 8 && <><Snippet doc={doc} termSet={out.termSet} /><span className="more">To'liq o'qish →</span></>}
            {active && <div className="pulse">+ {f3(current.part)} ({current.term})</div>}
          </article>
        );
      })}
    </div>
  );
}

function Snippet({ doc, termSet }) {
  const s = useMemo(() => IR.snippet(doc, termSet), [doc, termSet]);
  return (
    <p className="snip">
      {s.head && '… '}
      {s.segs.map((x, i) => (x.hit ? <mark key={i}>{x.text}</mark> : <span key={i}>{x.text}</span>))}
      {s.tail && ' …'}
    </p>
  );
}

/* ============================================================================
 * O'ng tomon: algoritm jonli ishlayotgan panel
 * ========================================================================== */
function Stage({ n, title, state, children }) {
  return (
    <section className={'stage-box ' + state}>
      <div className="stage-title"><span className="dot">{n}</span>{title}</div>
      {children}
    </section>
  );
}

function Process({ index, out, trace, f }) {
  const phase = phaseAt(trace, f);
  const nDone = Math.max(0, Math.min(trace.ops.length, f - trace.base6 + 1));
  const cur = phase === 6 ? trace.ops[nDone - 1] : null;
  const st = (from, to) => (phase >= from && phase <= (to || from) ? 'on' : phase > (to || from) ? 'done' : 'off');
  // belgi ko'rinishi: p-ustun, i-qator
  const seen = (p, i) => f >= (p - 1) * trace.T + i;
  const nowCell = (p, i) => phase === p && f === (p - 1) * trace.T + i;

  return (
    <div className="process">
      <Stage n="1–4" title="So'rovni tahlil qilish" state={st(1, 4)}>
        <table className="tok">
          <thead><tr><th>Token</th><th>Kichik harf</th><th>Stop?</th><th>O'zak</th></tr></thead>
          <tbody>
            {out.tokens.map((t, i) => (
              <tr key={i}>
                <td className={seen(1, i) ? 'show' + (nowCell(1, i) ? ' now' : '') : ''}>{seen(1, i) ? t.raw : ''}</td>
                <td className={seen(2, i) ? 'show' + (nowCell(2, i) ? ' now' : '') : ''}>{seen(2, i) ? t.lower : ''}</td>
                <td className={seen(3, i) ? 'show' + (nowCell(3, i) ? ' now' : '') + (t.stop ? ' bad' : '') : ''}>{seen(3, i) ? (t.stop ? 'ha — o\'chiriladi' : 'yo\'q') : ''}</td>
                <td className={seen(4, i) ? 'show' + (nowCell(4, i) ? ' now' : '') : ''}>{seen(4, i) ? (t.stop ? '—' : <b>{t.term}</b>) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Stage>

      <Stage n="5" title="Teskari indeksdan postings olish" state={st(5)}>
        {phase < 5 && <p className="hint">Har bir termin uchun tayyor hujjatlar ro'yxati lug'atdan olinadi.</p>}
        {trace.lookups.map((t, k) => {
          if (f < trace.base5 + k) return null;
          const isNow = phase === 5 && f === trace.base5 + k;
          return (
            <div key={t.term} className={'lookup' + (isNow ? ' now' : '')}>
              <div className="lk-head"><b>{t.term}</b>{!t.unknown && <span className="meta">df = {t.df} · idf = {f3(t.idf)}</span>}</div>
              {t.unknown
                ? <span className="miss">lug'atda yo'q — hech qaysi hujjat</span>
                : <div className="chips">{t.postings.map((p) => (
                  <span key={p.doc} className={'pchip' + (cur && cur.term === t.term && cur.doc === p.doc ? ' hot' : '')}>H{p.doc}<small>×{p.tf}</small></span>
                ))}</div>}
            </div>
          );
        })}
      </Stage>

      <Stage n="6" title="TF-IDF ballarini yig'ish" state={st(6)}>
        <div className="formula">w = (1 + log₁₀ tf) · idf &nbsp;|&nbsp; Σ[H] += w(t,q) · w(t,H)</div>
        {phase < 6 && <p className="hint">Postings ro'yxatidagi har bir hujjatga ball qo'shiladi.</p>}
        <ol className="log">
          {trace.ops.slice(0, nDone).map((o, k) => {
            const run = trace.ops.slice(0, k + 1).filter((x) => x.doc === o.doc).reduce((s, x) => s + x.part, 0);
            return (
              <li key={k} className={k === nDone - 1 && phase === 6 ? 'now' : ''}>
                <b>H{o.doc}</b> · {o.term}: {f3(o.wq)} × {f3(o.wd)} = {f3(o.part)} <span className="arrow">→</span> Σ = <b>{f3(run)}</b>
              </li>
            );
          })}
        </ol>
      </Stage>

      <Stage n="7" title="Kosinus bilan normallashtirish" state={st(7)}>
        <div className="formula">cos = Σ / (|q| · |d|) &nbsp; <span className="muted">|q| = {f3(out.qNorm)}</span></div>
        {phase >= 7 ? (
          <table className="tok">
            <tbody>
              {out.results.map((r) => (
                <tr key={r.id} className="show"><td>H{r.id}</td><td>{f3(r.dot)} / ({f3(out.qNorm)} · {f3(index.norm.get(r.id))})</td><td><b>{f3(r.score)}</b></td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="hint">Uzun hujjatlar ustun bo'lib qolmasligi uchun hujjat vektori uzunligiga bo'linadi.</p>}
      </Stage>

      <Stage n="8" title="Saralash" state={st(8)}>
        <p className="hint">{phase >= 8 ? 'Hujjatlar cos bo\'yicha kamayish tartibida chiqarildi ✔' : 'Natijalar eng yuqori ballidan boshlab tartiblanadi.'}</p>
      </Stage>
    </div>
  );
}

/* ============================================================================
 * Ilova
 * ========================================================================== */
const EXAMPLES = ['ismim karim', "so'z o'zagi", 'teskari indeks', "aniqlik va to'liqlik", "stop so'zlar"];

function App() {
  const [state, setState] = useState({ status: 'loading' });
  const [input, setInput] = useState('ismim karim');
  const [query, setQuery] = useState('ismim karim');
  const [animate, setAnimate] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [f, setF] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState('proc'); // faqat telefonda ishlaydi: 'proc' | 'res'

  useEffect(() => {
    loadData()
      .then((d) => setState({ status: 'ready', index: IR.weigh(IR.buildIndex(d.docs, d.stop)) }))
      .catch((e) => setState({ status: 'error', error: String(e.message || e) }));
  }, []);
  const index = state.index;

  // yozish tugagach (350ms) qidiruv avtomatik boshlanadi — "jonli"
  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 350);
    return () => clearTimeout(t);
  }, [input]);

  const out = useMemo(() => (index && query.trim() ? IR.rankedSearch(index, query) : null), [index, query]);
  const trace = useMemo(() => (out ? buildTrace(out) : null), [out]);

  // yangi so'rov — animatsiyani boshidan
  useEffect(() => {
    if (!trace) return;
    setF(animate ? -1 : trace.length - 1);
    setPlaying(animate);
    setTab(animate ? 'proc' : 'res'); // telefonda: animatsiya bo'lsa jarayonni, bo'lmasa natijani ko'rsat
  }, [out]);

  // ijro
  useEffect(() => {
    if (!trace || !playing) return undefined;
    if (f >= trace.length - 1) { setPlaying(false); return undefined; }
    const nextPhase = phaseAt(trace, f + 1);
    const t = setTimeout(() => setF((x) => x + 1), PHASE_DELAY[nextPhase] / speed);
    return () => clearTimeout(t);
  }, [playing, f, trace, speed]);

  const phase = trace ? phaseAt(trace, f) : 0;
  const last = trace ? trace.length - 1 : 0;
  const submit = (e) => { e.preventDefault(); setQuery(input); setF(-1); setPlaying(true); if (out && query === input) { setF(-1); } };

  return (
    <div className="app">
      <header className="top">
        <div className="logo">Izla<span>.</span></div>
        <form className="qform" onSubmit={submit}>
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Qidirish so'zlarini yozing — jarayon jonli ko'rinadi…" autoFocus />
          <button type="submit">Izlash ↵</button>
        </form>
      </header>
      <div className="examples">
        <span>Sinab ko'ring:</span>
        {EXAMPLES.map((q) => <button key={q} onClick={() => { setInput(q); setQuery(q); }}>{q}</button>)}
      </div>

      {state.status === 'loading' && <div className="center-note">Indeks tuzilmoqda…</div>}
      {state.status === 'error' && (
        <div className="center-note err"><b>Yuklab bo'lmadi:</b> {state.error}<br />Papkadagi <b>start.bat</b> ni ishga tushirib, <b>http://localhost:5173</b> ni oching.</div>
      )}

      {index && (
        <div className="bench" data-tab={tab}>
          <main className="left">
            <div className="stats">{index.N} hujjat · {index.dict.size} termin (teskari indeks tayyor)</div>
            {!out && <div className="waiting">So'rov yozing — qidiruv algoritmi qadamma-qadam ishlaydi.</div>}
            {out && trace.length > 2 && <ResultsLive index={index} out={out} trace={trace} f={f} onOpen={setOpenId} />}
            {out && out.terms.length === 0 && (
              <div className="waiting">
                {out.unknown.length ? `"${out.unknown.join(', ')}" lug'atda yo'q — hech narsa topilmadi.` : "So'rovda indekslanadigan so'z yo'q (faqat stop so'zlar yoki raqamlar)."}
              </div>
            )}
          </main>

          <aside className="right">
            <div className="panel-head">
              <h2>Algoritm jonli</h2>
              <label className="check"><input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} /> animatsiya</label>
            </div>
            {out && trace ? (
              <>
                <div className="pills">
                  {PHASES.map((p) => <span key={p.n} className={'pill' + (phase === p.n ? ' on' : phase > p.n ? ' done' : '')}>{p.n}. {p.short}</span>)}
                </div>
                <div className="controls">
                  <button onClick={() => { setPlaying(false); setF(-1); }} title="Boshiga">⏮</button>
                  <button onClick={() => { setPlaying(false); setF(Math.max(-1, f - 1)); }} title="Orqaga">◀</button>
                  <button className="play" onClick={() => { if (f >= last) setF(-1); setPlaying(!playing); }}>{playing ? '❚❚' : '▶'}</button>
                  <button onClick={() => { setPlaying(false); setF(Math.min(last, f + 1)); }} title="Keyingi qadam">▶|</button>
                  <button onClick={() => { setPlaying(false); setF(last); }} title="Oxiriga">⏭</button>
                  <input type="range" min="-1" max={last} value={f} onChange={(e) => { setPlaying(false); setF(+e.target.value); }} />
                  <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                    <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option>
                  </select>
                </div>
                <Process index={index} out={out} trace={trace} f={f} />
              </>
            ) : <p className="hint">So'rov kiritilgach, bu yerda har bir qadam ko'rinadi.</p>}
          </aside>
        </div>
      )}
      {index && (
        <nav className="tabbar" aria-label="Bo'limlar">
          <button className={tab === 'res' ? 'on' : ''} onClick={() => setTab('res')}>
            Natijalar{out && phase >= 6 ? <b>{out.results.length}</b> : null}
          </button>
          <button className={tab === 'proc' ? 'on' : ''} onClick={() => setTab('proc')}>
            <span className={playing ? 'live' : ''}>●</span> Algoritm{phase ? <small>{PHASES[phase - 1].n}/8 {PHASES[phase - 1].short}</small> : null}
          </button>
        </nav>
      )}
      {index && openId && <DocModal doc={index.docs[openId - 1]} termSet={out ? out.termSet : new Set()} onClose={() => setOpenId(null)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
