/**
 * 요금표 출처 감시.
 *
 * 요금표(tariffs.json)의 각 지역에는 요금을 확인한 공식 자료의 주소(source)가 있다.
 * 이 스크립트는 그 주소를 다시 읽어 "요금이 바뀌었을 수 있다"는 신호를 찾는다.
 *
 *  1. 지난번에 그 페이지에 있던 요금 숫자(기본요금 등)가 사라졌다  → 요금이 바뀌었을 가능성이 높다
 *  2. 출처가 PDF 같은 문서인데 내용이 달라졌다
 *  3. 요금표에 적어 둔 재확인 날짜(review.on)가 됐다 (한시 할증의 종료일 등)
 *  4. 마지막 확인일(verified)에서 180일이 지났다
 *  5. 예정 변경(upcoming)의 시행일이 다가왔거나 지났다 (알림만, 앱은 그날 자동으로 바뀐다)
 *
 * 숫자를 고쳐 주지는 않는다. "여기를 다시 조사하라"는 목록을 만들 뿐이다.
 * 조사는 docs/verification 의 지시서대로 하고, 고친 뒤 npm run tariffs:publish 로 올린다.
 *
 * 실행 (프로젝트에서):   npm run tariffs:watch
 * 실행 (GitHub Actions): node watch/watch-sources.js tariffs.json watch/state.json watch/report.md
 *   → 요금표 저장소에서 매주 자동으로 돌고, 새 신호가 있으면 이슈를 만들어 메일로 알린다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tariffFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'data', 'tariffs.json'));
const stateFile = path.resolve(process.argv[3] || path.join(__dirname, '..', 'docs', 'watch', 'state.json'));
const reportFile = path.resolve(process.argv[4] || path.join(__dirname, '..', 'docs', 'watch', 'report.md'));

const STALE_DAYS = 180; // 확인일이 이만큼 지나면 다시 조사
/** 매주 돌아가며 다시 확인할 지역 수. 약 500곳이면 1년에 한 번씩 모든 지역을 다시 본다 */
const ROTATE_PER_WEEK = 10;
/**
 * 물가가 빨리 올라(대략 연 20% 이상) 택시 요금이 1년에 여러 번 바뀌는 나라. 매달 첫 점검에서 모두 다시 확인한다.
 * 해마다 IMF 물가 전망을 보고 고친다.
 */
const HIGH_INFLATION = new Set(['AR', 'VE', 'TR', 'IR', 'NG', 'EG', 'ZW', 'SD', 'SS', 'LB', 'SY', 'YE', 'ET', 'MW', 'AO', 'HT', 'MM', 'BI', 'CU', 'SL', 'GH', 'PK']);
const UPCOMING_NOTICE_DAYS = 14; // 예정 변경을 이만큼 앞두고 알림
const TIMEOUT_MS = 30000;
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const today = new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

const data = JSON.parse(fs.readFileSync(tariffFile, 'utf8'));
let state = { lastRun: null, sources: {}, alerted: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
} catch {
  // 처음 실행
}

/** 요금표에서 "출처 페이지에 적혀 있을 법한" 숫자들 */
function fareNumbers(t) {
  const out = new Set();
  const add = (n) => {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out.add(n);
  };
  add(t.baseFare);
  add(t.minFare);
  add(t.timeFare);
  for (const d of t.distanceTiers || []) {
    add(d.fare);
    add(d.unitM);
    add(Math.round((d.fare / d.unitM) * 1000 * 100) / 100); // km당 요금
  }
  add(t.timeUnitSec);
  if (t.timeUnitSec > 0) add(Math.round((t.timeFare / t.timeUnitSec) * 3600 * 100) / 100); // 시간당 요금
  for (const s of t.surcharges || []) {
    add(s.baseFare);
    add(s.flat);
  }
  for (const e of t.extras || []) add(e.amount);
  return [...out];
}

/** 숫자 하나가 글에 나타날 수 있는 표기들. 너무 짧아 어디에나 있는 표기(예: "3")는 뺀다 */
function spellings(n, decimals) {
  const forms = new Set();
  const fixed = n.toFixed(decimals);
  const [i, f] = fixed.split('.');
  const groups = (sep) => i.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  for (const int of new Set([i, groups(','), groups('.'), groups(' '), groups(' '), groups("'")])) {
    if (f === undefined) forms.add(int);
    else {
      forms.add(`${int}.${f}`);
      forms.add(`${int},${f}`);
    }
  }
  if (Number.isInteger(n)) forms.add(String(n));
  else forms.add(String(n)).add(String(n).replace('.', ','));
  return [...forms].filter((s) => s.replace(/\D/g, '').length >= 3 || /[.,]\d\d$/.test(s));
}

/** 글 안에 그 숫자가 "독립된 숫자"로 있는지 (4800 이 14800 의 일부로 잡히지 않게) */
function hasNumber(text, forms) {
  return forms.some((s) => {
    let from = 0;
    for (;;) {
      const at = text.indexOf(s, from);
      if (at < 0) return false;
      const before = text[at - 1] || ' ';
      const after = text[at + s.length] || ' ';
      if (!/\d/.test(before) && !/\d/.test(after)) return true;
      from = at + 1;
    }
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, ' ');
}

async function fetchSource(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en,*;q=0.5' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    const isText = /html|text|json|xml/.test(type) || (!type && buf.slice(0, 200).toString('utf8').includes('<'));
    return isText ? { ok: true, kind: 'text', text: htmlToText(buf.toString('utf8')) } : { ok: true, kind: 'file', hash: sha(buf), bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '응답 없음(시간 초과)' : String(e.cause?.code || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── 뉴스 감시 ─────────────────────────

/** 나라별 뉴스 검색 언어와 "택시 요금 변경" 검색어, 제목에서 확인할 낱말 */
const NEWS_LANG = {
  KR: ['ko', 'KR', '택시 요금 인상', /택시/, /요금|기본요금|할증/],
  JP: ['ja', 'JP', 'タクシー 運賃 改定', /タクシー/, /運賃|料金|値上げ/],
  CN: ['zh-CN', 'CN', '出租车 运价 调整', /出租车|的士/, /运价|价格|起步价|调价|涨价/],
  TW: ['zh-TW', 'TW', '計程車 費率 調漲', /計程車|小黃/, /費率|運價|漲|起跳/],
  HK: ['zh-HK', 'HK', '的士 加價', /的士/, /加價|收費|車資/],
  DE: ['de', 'DE', 'Taxitarif Erhöhung', /taxi/i, /tarif|preis|teurer|erhöh/i],
  AT: ['de', 'AT', 'Taxitarif Erhöhung', /taxi/i, /tarif|preis|teurer|erhöh/i],
  CH: ['de', 'CH', 'Taxitarif', /taxi/i, /tarif|preis|teurer|erhöh/i],
  FR: ['fr', 'FR', 'tarif taxi hausse', /taxi/i, /tarif|prix|hausse|augment/i],
  BE: ['fr', 'BE', 'tarif taxi', /taxi/i, /tarif|prix|hausse|augment/i],
  IT: ['it', 'IT', 'tariffe taxi aumento', /taxi/i, /tariff|prezz|aument|rincar/i],
  ES: ['es', 'ES', 'tarifa taxi subida', /taxi/i, /tarifa|precio|subida|sube|aument/i],
  MX: ['es-419', 'MX', 'tarifa taxi aumento', /taxi/i, /tarifa|precio|aument|sube/i],
  AR: ['es-419', 'AR', 'tarifa taxi aumento', /taxi/i, /tarifa|bajada de bandera|aument|ficha/i],
  CL: ['es-419', 'CL', 'tarifa taxi alza', /taxi/i, /tarifa|bajada de bandera|alza|aument/i],
  BR: ['pt-BR', 'BR', 'tarifa táxi reajuste', /t[áa]xi/i, /tarifa|bandeira|reajuste|aument/i],
  PT: ['pt-PT', 'PT', 'tarifa táxi aumento', /t[áa]xi/i, /tarifa|preço|aument/i],
  NL: ['nl', 'NL', 'taxitarief verhoging', /taxi/i, /tarie|prijs|duurder|verhog/i],
  PL: ['pl', 'PL', 'ceny taxi podwyżka', /taks|taxi/i, /cen|stawk|podwyż|opłat/i],
  CZ: ['cs', 'CZ', 'ceny taxi zdražení', /taxi/i, /cen|tarif|zdraž/i],
  HU: ['hu', 'HU', 'taxi tarifa emelés', /taxi/i, /tarifa|ár|emel|drágul/i],
  TR: ['tr', 'TR', 'taksi ücreti zam', /taksi/i, /ücret|zam|tarife|indi-bindi|açılış/i],
  RU: ['ru', 'RU', 'тариф такси повышение', /такси/i, /тариф|цен|подорож|повыш/i],
  SE: ['sv', 'SE', 'taxi taxa höjning', /taxi/i, /taxa|pris|höj|dyrare/i],
  NO: ['no', 'NO', 'taxi takst økning', /taxi|drosje/i, /takst|pris|øk|dyrere/i],
  DK: ['da', 'DK', 'taxa takst stigning', /taxa|taxi/i, /takst|pris|stig|dyrere/i],
  FI: ['fi', 'FI', 'taksi hinta korotus', /taksi/i, /hinta|hinna|koro|kallis/i],
  GR: ['el', 'GR', 'ταξί τιμολόγιο αύξηση', /ταξί/i, /τιμ|αύξησ|κόμιστρ/i],
  IL: ['he', 'IL', 'מונית תעריף', /מונית|מוניות/, /תעריף|מחיר|התייקר|עלי/],
  TH: ['th', 'TH', 'ค่าแท็กซี่ ขึ้นราคา', /แท็กซี่/, /ค่า|ราคา|ขึ้น/],
  VN: ['vi', 'VN', 'giá cước taxi tăng', /taxi/i, /giá|cước|tăng/i],
  ID: ['id', 'ID', 'tarif taksi naik', /taksi|taxi/i, /tarif|harga|naik/i],
  AE: ['en', 'AE', 'taxi fare', /taxi/i, /fare|tariff|price|rate/i],
  SA: ['ar', 'SA', 'تسعيرة سيارات الأجرة', /أجرة|تاكسي/, /تسعير|أسعار|رفع|زياد/],
  QA: ['en', 'QA', 'Karwa taxi fare', /taxi|karwa/i, /fare|tariff|price|rate/i],
  EG: ['ar', 'EG', 'تعريفة التاكسي', /تاكسي|أجرة/, /تعريف|أسعار|زياد|رفع/],
};
const NEWS_DEFAULT = ['en', 'US', 'taxi fare increase', /taxi|cab/i, /fare|rate|tariff|price|meter/i];
const NEWS_DAYS = 10; // 최근 이만큼 안의 기사만
const NEWS_CONCURRENCY = 3;

/** 검색에 쓸 도시 이름: 한국은 한글, 한자를 쓰는 나라는 구역 이름 중 한자, 그 밖에는 영문 */
function newsPlace(t) {
  const strip = (s) => s.replace(/\s*\([^)]*\)/g, '').replace(/\s*외\s*\d+곳$/, '').split(/[·,]/)[0].trim();
  if (t.country === 'KR') return strip(t.region);
  if (t.match && t.match.country) {
    // 전국 요금: 여러 나라가 함께 쓰는 언어(영어·아랍어·포르투갈어 등)의 뉴스는 다른 나라 기사가 섞이므로
    // 나라 이름이 제목에 있어야 한다. 그 나라만 쓰는 언어(네덜란드어·그리스어 등)는 언어가 이미 범위를 좁힌다
    const lang = (NEWS_LANG[t.country] || NEWS_DEFAULT)[0].split('-')[0];
    const SHORT = { SA: 'السعودية', QA: 'Qatar' };
    if (!['en', 'ar', 'pt', 'es', 'fr', 'de', 'zh'].includes(lang)) return '';
    return SHORT[t.country] || new Intl.DisplayNames([lang], { type: 'region' }).of(t.country);
  }
  const names = [...((t.match && t.match.cities) || []), ...((t.match && t.match.regions) || [])];
  if (['JP', 'CN', 'TW', 'HK'].includes(t.country)) {
    const cjk = names.find((n) => /[぀-ヿ一-鿿]/.test(n));
    if (cjk) return cjk.replace(/(都|府|県|市|区|省)$/, '');
  }
  return t.regionEn.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()).split(/[(/]/)[0].trim();
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => {
      const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
    };
    items.push({ title: get('title'), link: get('link'), date: get('pubDate') });
  }
  return items;
}

async function watchNews(tariffs) {
  // 같은 검색어는 한 번만 (전국 요금 나라, 같은 이름의 구역)
  const queries = new Map();
  for (const t of tariffs) {
    const [hl, gl, words, taxiRe, fareRe] = NEWS_LANG[t.country] || [...NEWS_DEFAULT.slice(0, 1), t.country, ...NEWS_DEFAULT.slice(2)];
    const place = newsPlace(t);
    const q = place ? `"${place}" ${words}` : words;
    const key = `${gl}|${q}`;
    if (!queries.has(key)) queries.set(key, { ids: [], names: [], hl, gl, q, taxiRe, fareRe, place });
    queries.get(key).ids.push(t.id);
    queries.get(key).names.push(`${t.region} (${t.id})`);
  }
  const since = Date.now() - NEWS_DAYS * 86400000;
  const items = [];
  let failed = 0;
  const list = [...queries.values()];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const job = list[next++];
      const lang = job.hl.split('-')[0];
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(job.q + ' when:' + NEWS_DAYS + 'd')}&hl=${job.hl}&gl=${job.gl}&ceid=${job.gl}:${lang}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) {
          failed++;
          continue;
        }
        for (const it of parseRss(await res.text())) {
          const when = Date.parse(it.date);
          if (!Number.isFinite(when) || when < since) continue;
          // Google 뉴스 제목 끝의 " - 언론사" 를 뗀다 ("부산일보", "경기뉴스원" 이 도시 이름으로 잡히지 않게)
          it.title = it.title.replace(/\s+-\s+[^-]+$/, '').trim();
          // 제목에 택시와 요금 낱말이 모두 있고, 도시 이름이 있으면 그것도 있어야 한다
          if (!job.taxiRe.test(it.title) || !job.fareRe.test(it.title)) continue;
          if (job.place && !it.title.toLowerCase().includes(job.place.toLowerCase())) continue;
          items.push({ id: job.ids[0], name: job.names.join(', '), title: it.title, link: it.link, date: new Date(when).toISOString().slice(0, 10), key: it.link || it.title });
        }
      } catch {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 700)); // 너무 빠르게 묻지 않는다
    }
  }
  await Promise.all(Array.from({ length: NEWS_CONCURRENCY }, worker));
  console.log(`뉴스 검색 ${list.length}건, 관련 기사 ${items.length}건, 실패 ${failed}건`);
  return { items, failed };
}

async function main() {
  const tariffs = data.tariffs;
  const urls = [...new Set(tariffs.map((t) => t.source).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))];
  const fetched = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        fetched[url] = await fetchSource(url);
      }
    }),
  );

  /** [종류, 요금표 id, 설명, 한 번만 알리기 위한 열쇠] */
  const findings = [];
  const notes = [];
  const sources = {};

  for (const t of tariffs) {
    const name = `${t.region} (${t.id})`;

    // 1·2. 출처 페이지
    if (t.source && fetched[t.source]) {
      const r = fetched[t.source];
      const prev = state.sources[t.id];
      const samePage = prev && prev.url === t.source && prev.version === data.version;
      if (!r.ok) {
        const fails = (prev && prev.url === t.source ? prev.fails || 0 : 0) + 1;
        sources[t.id] = { ...(prev && prev.url === t.source ? prev : {}), url: t.source, version: data.version, fails, error: r.error };
        if (fails === 4) findings.push(['출처에 접속할 수 없음', t.id, `${name}: 4주 연속 실패 (${r.error}). 주소가 바뀌었는지 확인하세요.\n  ${t.source}`, `fail:${t.id}:${t.source}`]);
      } else if (r.kind === 'file') {
        if (prev && prev.url === t.source && prev.hash && prev.hash !== r.hash) {
          findings.push(['출처 문서가 바뀜', t.id, `${name}: 출처 문서의 내용이 지난번과 다릅니다.\n  ${t.source}`, `hash:${t.id}:${r.hash}`]);
        }
        sources[t.id] = { url: t.source, version: data.version, kind: 'file', hash: r.hash, fails: 0 };
      } else {
        const present = fareNumbers(t).filter((n) => hasNumber(r.text, spellings(n, t.decimals)));
        // 요금표가 바뀌었거나(새 버전) 처음 보는 페이지면 지금 보이는 숫자를 기준으로 삼는다
        const baseline = samePage && prev.numbers ? prev.numbers : present;
        const gone = baseline.filter((n) => !present.includes(n));
        if (gone.length) {
          findings.push([
            '출처에서 요금 숫자가 사라짐',
            t.id,
            `${name}: 지난번에 출처 페이지에 있던 숫자 ${gone.join(', ')} 이(가) 보이지 않습니다. 요금이 바뀌었을 수 있습니다.\n  ${t.source}`,
            `gone:${t.id}:${gone.join('/')}`,
          ]);
        }
        if (!baseline.length) notes.push(`${name}: 출처 페이지에서 요금 숫자를 하나도 찾지 못해 자동 감시가 되지 않습니다(화면을 스크립트로 그리는 페이지이거나 숫자 표기가 다름).`);
        sources[t.id] = { url: t.source, version: data.version, kind: 'text', numbers: baseline, fails: 0 };
      }
    } else if (!t.source) {
      notes.push(`${name}: 출처 주소가 없어 감시할 수 없습니다.`);
    }

    // 3. 재확인 날짜
    if (t.review && t.review.on <= today) {
      findings.push(['다시 확인할 날짜가 됨', t.id, `${name}: ${t.review.why} (예정일 ${t.review.on})`, `review:${t.id}:${t.review.on}`]);
    }

    // 4. 오래된 확인일
    if (!t.verified) {
      findings.push(['확인되지 않은 요금표', t.id, `${name}: 아직 공식 자료로 확인하지 못한 참고값입니다.`, `unverified:${t.id}`]);
    } else if (daysBetween(t.verified, today) >= STALE_DAYS) {
      findings.push(['확인한 지 오래됨', t.id, `${name}: 마지막 확인 ${t.verified} (${daysBetween(t.verified, today)}일 전).`, `stale:${t.id}:${t.verified}`]);
    }

    // 5. 예정 변경
    for (const c of t.upcoming || []) {
      const left = daysBetween(today, c.effective);
      if (left > 0 && left <= UPCOMING_NOTICE_DAYS) {
        findings.push(['예정된 요금 변경이 곧 시행됨', t.id, `${name}: ${c.effective} 부터 새 요금이 자동 적용됩니다(${left}일 남음). 고시가 바뀌지 않았는지 한 번 더 확인하세요.`, `soon:${t.id}:${c.effective}`]);
      } else if (left <= 0) {
        findings.push(['예정 변경이 시행됨 (정리 필요)', t.id, `${name}: ${c.effective} 예정 변경이 시행됐습니다. 요금표 본문에 합치고 upcoming 에서 지우세요.`, `done:${t.id}:${c.effective}`]);
      }
    }
  }

  // 6. 뉴스: 출처 페이지가 바뀌기 전에 "요금 인상" 발표를 잡는다 (Google 뉴스 RSS, 무료·키 없음)
  const news = await watchNews(tariffs);
  for (const n of news.items) findings.push(['뉴스: 요금 변경 보도', n.id, `${n.name}: ${n.title} (${n.date})\n  ${n.link}`, `news:${n.key}`]);
  if (news.failed) notes.push(`뉴스 검색 ${news.failed}건을 읽지 못했습니다 (일시적인 접속 제한일 수 있음).`);

  // 7. 물가가 빨리 오르는 나라: 요금이 1년에 여러 번 바뀌므로 매달 첫 점검에서 모두 다시 확인한다
  const month = today.slice(0, 7);
  if (Number(today.slice(8, 10)) <= 7) {
    for (const t of tariffs) {
      if (!HIGH_INFLATION.has(t.country)) continue;
      findings.push(['물가가 빠른 나라 (매달 확인)', t.id, `${t.region} (${t.id}): 마지막 확인 ${t.verified || '없음'}. 이번 달 요금 인상 고시·보도가 있는지 확인하세요.`, `inflation:${t.id}:${month}`]);
    }
  }

  // 8. 돌아가며 다시 확인: 뉴스가 잘 안 나오는 작은 나라도 놓치지 않도록, 매주 가장 오래전에 확인한 곳을 골라
  //    다시 조사한다. 한 번 고른 곳은 확인일이 바뀌지 않아도 그날을 기준으로 다시 줄을 선다 (같은 곳만 계속 나오지 않게)
  const flagged = new Set(findings.map((f) => f[1]));
  const rotated = { ...(state.rotated || {}) };
  const lastLook = (t) => [t.verified || '0000-00-00', rotated[t.id] || '0000-00-00'].sort().pop();
  const due = tariffs
    .filter((t) => !flagged.has(t.id))
    .sort((a, b) => lastLook(a).localeCompare(lastLook(b)) || (b.population || 0) - (a.population || 0))
    .slice(0, ROTATE_PER_WEEK);
  for (const t of due) {
    rotated[t.id] = today;
    findings.push(['돌아가며 다시 확인 (매주)', t.id, `${t.region} (${t.id}): 마지막 확인 ${t.verified || '없음'}. 지금도 같은 요금인지 공식 자료로 확인하세요.\n  ${t.source || '출처 없음'}`, `rotate:${t.id}:${today}`]);
  }

  // 이미 알린 것은 다시 알리지 않는다
  const fresh = findings.filter((f) => !state.alerted[f[3]]);
  const alerted = {};
  for (const f of findings) alerted[f[3]] = state.alerted[f[3]] || today;

  const groups = {};
  for (const f of fresh) (groups[f[0]] = groups[f[0]] || []).push(f[2]);
  const lines = [`# 요금표 점검 보고 (${today})`, '', `요금표 v${data.version} (${data.updated}), 지역 ${tariffs.length}개, 출처 ${urls.length}곳을 확인했습니다.`, ''];
  if (!fresh.length) lines.push('새로 확인할 것이 없습니다.', '');
  for (const [kind, items] of Object.entries(groups)) {
    lines.push(`## ${kind} (${items.length}건)`, '');
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  }
  const failing = Object.entries(sources).filter(([, s]) => s.fails > 0);
  if (failing.length) {
    lines.push(`## 이번에 읽지 못한 출처 (${failing.length}곳)`, '', '자동 접속을 막는 사이트가 많습니다. 4주 연속 실패하면 위 목록에 올라옵니다.', '');
    for (const [id, s] of failing) lines.push(`- ${id}: ${s.error} (${s.fails}회째)`);
    lines.push('');
  }
  if (notes.length) {
    lines.push(`## 자동 감시가 안 되는 지역 (${notes.length}곳)`, '', '이 지역들은 확인일이 오래되면 알리는 방식으로만 관리됩니다.', '');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('---', '고치는 방법: 해당 지역을 다시 조사해 `src/data/tariffs.json` 을 고치고 `version` 을 올린 뒤 `npm run tariffs:publish`.');

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ lastRun: today, sources, alerted, rotated }, null, 1) + '\n');
  fs.writeFileSync(reportFile, lines.join('\n') + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert=${fresh.length ? 'true' : 'false'}\n`);

  const watchable = Object.values(sources).filter((s) => !s.fails && (s.kind === 'file' || (s.numbers && s.numbers.length))).length;
  console.log(`출처 ${urls.length}곳 확인: 자동 감시 가능 ${watchable}개 지역, 읽지 못함 ${failing.length}개 지역, 새 신호 ${fresh.length}건`);
  console.log(`보고서: ${reportFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
