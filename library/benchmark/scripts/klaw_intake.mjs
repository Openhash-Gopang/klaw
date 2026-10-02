// klaw_intake.mjs — 법제처 국가법령정보센터 API에서 새로 올라온 대법원 민사 '다' 판결을 모아 두었다가,
// 새 사건이 N건(기본 10건) 쌓일 때마다 다음 라운드(r11, r12, …)를 자동으로 만든다. (Node 18+, 외부 패키지 없음)
// 실행 위치: klaw-bench 폴더(prec_civil\, split\, dev100\ 가 있는 곳). 이 스크립트는 klaw 저장소의 scripts\ 에 둔다.
//
// 사용: node <저장소>\library\benchmark\scripts\klaw_intake.mjs <명령> [옵션]
//   poll      새 판결을 조회·수집(본문+2심·1심 연결+주문 라벨)하고, 10건이 쌓였으면 라운드를 만든다.   [기본]
//   status    수집 현황(대기열 건수, 만든 라운드, 마지막 조회일)만 보여 준다. 네트워크 사용 안 함.
//   selftest  네트워크 없이 파싱·라벨·라운드 구성 로직을 시험한다.
//   옵션: --size=10  라운드 크기 | --since=YYYYMMDD  처음 조회 시작일(기본: 기존 수집분의 최신 선고일) | --dry  파일을 쓰지 않음
//         --auto  라운드가 만들어지면 이어서 개요 작성(overview_writer, DeepSeek)과 저장소 게재 준비까지 실행
//         --repo="C:\...\klaw"  저장소 경로(--auto 때 필요) | --run-deepseek  --auto 후 DeepSeek 담당 5건의 가상 판결까지 실행
// 환경변수: LAW_OC(법제처 OC, 호출 PC의 공인 IP 등록 필요), --auto 때 DEEPSEEK_OVERVIEW_API_KEY, --run-deepseek 때 DEEPSEEK_API_KEY
//
// 상태·산출물(모두 klaw-bench\live\ 아래, 기존 prec_civil·labels·chain·split 파일은 건드리지 않는다):
//   live\state.json        마지막 조회일, 만든 라운드 번호
//   live\index_live.csv    수집한 새 사건(id, caseNo, date, 상태: queued|round-NN)
//   live\labels_live.csv   대법원 주문 라벨(유지/파기, 6유형)
//   live\chain_live.csv    2심·1심 연결 결과(overview_writer --chain 형식)
//   live\dev_live.csv      라운드에 편성된 사건(round,id,caseNo,date,label,binary,has1,has2)
//   live\assign_rNN.json   그 라운드의 담당 배정(DeepSeek 5 / Claude 5, 라운드 번호가 시드) — 저장소에는 올리지 않는다
// 본문은 prec_civil\<선고일>_<id>.json, prec_2nd\<id>.json, prec_1st\<id>.json 로 기존 규칙 그대로 저장한다.
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { classify, extractOrder } from './klaw_pipeline_shared.mjs';

const argv = process.argv.slice(2); const CMD = argv.find((a) => !a.startsWith('--')) || 'poll';
const args = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return [m[1], m[2] ?? true]; }));
const SIZE = Number(args.size || 10); const DRY = !!args.dry; const AUTO = !!args.auto;
const OC = (process.env.LAW_OC || '').trim(); const BASE = args.base || 'https://www.law.go.kr/DRF';
const LIVE = 'live'; const P = (f) => path.join(LIVE, f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); if (!DRY && fs.existsSync(LIVE)) fs.appendFileSync(P('log.txt'), line + '\n', 'utf8'); };

// ── CSV ──
function parseCsv(text) { if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c; }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const c2 = rows.filter((r) => !(r.length === 1 && r[0] === '')); const [h, ...b] = c2 || [[]]; return (h ? b : []).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']))); }
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const readCsv = (p) => (fs.existsSync(p) ? parseCsv(fs.readFileSync(p, 'utf8')) : []);
function writeCsv(p, cols, rows) { if (DRY) return; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n') + '\r\n', 'utf8'); }

// ── 법제처 XML (정규식 파서: 필드 구조가 단순해 외부 패키지 없이 처리) ──
const tagVal = (xml, name) => { const m = xml.match(new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${name}>`)); return m ? (m[1] ?? m[2] ?? '').trim() : ''; };
export function parseList(xml) {
  if (/<Response>/.test(xml)) return { error: tagVal(xml, 'msg') || tagVal(xml, 'result') || '오류 응답', items: [], total: 0 };
  const items = [...xml.matchAll(/<prec[ >][\s\S]*?<\/prec>/g)].map((m) => ({ id: tagVal(m[0], '판례일련번호'), caseNo: tagVal(m[0], '사건번호'), date: tagVal(m[0], '선고일자').replace(/\D/g, ''),
    kind: tagVal(m[0], '사건종류명'), court: tagVal(m[0], '법원명'), title: tagVal(m[0], '사건명') }));
  return { items, total: Number(tagVal(xml, 'totalCnt') || items.length), error: null };
}
export const isCivilJudgment = (it) => it.kind === '민사' && /^\d{4}다\d+/.test(it.caseNo);
export function parseBody(xml) { if (/<Response>/.test(xml)) return null; const content = tagVal(xml, '판례내용'); if (!content) return null;
  return { PrecService: { 판례일련번호: tagVal(xml, '판례일련번호'), 사건번호: tagVal(xml, '사건번호'), 선고일자: tagVal(xml, '선고일자'), 법원명: tagVal(xml, '법원명'), 판례내용: content } }; }
export function labelFromBody(content) { const text = String(content).replace(/<br\s*\/?>/gi, '\n'); const order = extractOrder(text); if (!order) return { order: '', label: '확인필요', binary: '확인필요' };
  const [label, binary] = classify(order); return { order, label, binary }; }
const norm = (c) => String(c || '').replace(/\s/g, '').replace(/고법/g, '고등법원').replace(/지법/g, '지방법원');
export function lowerRef(content, which) { // 'second': 대법원 본문의 【원심판결】, 'first': 2심 본문의 【제1심판결】
  const text = String(content).replace(/<br\s*\/?>/gi, '\n'); const re = which === 'second' ? /【원심판결】\s*([^【]*)/ : /【제\s*1\s*심[^】]*】\s*([^【]*)/;
  const seg = (text.match(re) || [])[1]; if (!seg) return null;
  const m = seg.trim().match(/^\s*(.+?)\s+\d{4}\.\s*\d+\.\s*\d+\.\s*선고\s+(\d{4}[가-힣]+\d+)/m); return m ? { court: m[1].trim(), caseNo: m[2] } : null; }

// ── 네트워크 ──
let http = async (url) => { for (let k = 0; k < 4; k++) { try { const r = await fetch(url); if (r.ok) return await r.text(); } catch { /* retry */ } await sleep(2000 * 2 ** k); } return null; };
const q1 = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const listUrl = (o) => `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=prec&type=XML&${q1(o)}`;
async function searchRange(from, to) { const out = []; let page = 1;
  for (;;) { const x = await http(listUrl({ datSrcNm: '대법원', prncYd: `${from}~${to}`, sort: 'ddes', display: 100, page })); if (x == null) throw new Error('API 호출 실패(네트워크)');
    const r = parseList(x); if (r.error) throw new Error('API 오류: ' + r.error); out.push(...r.items); if (r.items.length < 100) break; page++; await sleep(300); } return out; }
async function findLower(ref) { if (!ref) return { id: null, status: 'no-ref' }; const x = await http(listUrl({ nb: ref.caseNo })); await sleep(250); if (x == null) return { id: null, status: 'api-error' };
  const r = parseList(x); if (r.error || !r.items.length) return { id: null, status: 'not-in-db' }; const nc = norm(ref.court);
  for (const p of r.items) { const a = norm(p.court); if (a && nc && (a.startsWith(nc) || nc.startsWith(a))) return { id: p.id, status: 'ok' }; } return { id: null, status: 'court-mismatch' }; }
async function fetchBody(id) { const x = await http(`${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=prec&ID=${id}&type=XML`); await sleep(250); return x ? parseBody(x) : null; }
const saveJson = (p, o) => { if (DRY) return; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), 'utf8'); };

// ── 상태 ──
const loadState = () => (fs.existsSync(P('state.json')) ? JSON.parse(fs.readFileSync(P('state.json'), 'utf8')) : { last_date: null, last_round: 10 });
const saveState = (s) => { if (!DRY) { fs.mkdirSync(LIVE, { recursive: true }); fs.writeFileSync(P('state.json'), JSON.stringify(s, null, 2), 'utf8'); } };
function knownIds() { const ids = new Set(); let maxDate = '0';
  for (const f of ['prec_civil/index.csv', 'labels.csv', 'live/index_live.csv']) for (const r of readCsv(f)) { if (r.id) ids.add(String(r.id)); if (r.date && String(r.date).replace(/\D/g, '') > maxDate) maxDate = String(r.date).replace(/\D/g, ''); }
  return { ids, maxDate }; }

// ── 라운드 구성: 대기열의 가장 오래된 N건(선고일·id 순, 임의 선별 없음) → 5/5 배정(라운드 번호 시드) ──
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function assign(ids, round) { const rnd = mulberry32(round); const a = [...ids].sort(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const half = Math.floor(a.length / 2); return { deepseek: a.slice(0, half).sort(), claude: a.slice(half).sort() }; }
export function pickBatch(queue, size) { return [...queue].sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id)).slice(0, size); }

async function formRound(state, idx, labels, chains) {
  const queue = idx.filter((r) => r.status === 'queued'); if (queue.length < SIZE) return null;
  const batch = pickBatch(queue, SIZE); const rn = state.last_round + 1; const rd = `r${String(rn).padStart(2, '0')}`;
  const devRows = batch.map((r) => { const l = labels.find((x) => x.id === r.id) || {}; const c = chains.find((x) => x.id === r.id) || {};
    return { round: rn, id: r.id, caseNo: r.caseNo, date: r.date, label: l.label || '', binary: l.binary || '', has1: c.found1 === 'True' ? 'True' : 'False', has2: c.found2 === 'True' ? 'True' : 'False' }; });
  const prev = readCsv(P('dev_live.csv')); writeCsv(P('dev_live.csv'), ['round', 'id', 'caseNo', 'date', 'label', 'binary', 'has1', 'has2'], [...prev, ...devRows]);
  for (const r of devRows) { const d = path.join('dev100', rd, r.id); if (DRY) continue; fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join('prec_civil', `${r.date}_${r.id}.json`), path.join(d, 'supreme.json'));
    const c = chains.find((x) => x.id === r.id) || {};
    if (c.found2 === 'True' && fs.existsSync(path.join('prec_2nd', `${c.id2}.json`))) fs.copyFileSync(path.join('prec_2nd', `${c.id2}.json`), path.join(d, 'second.json'));
    if (c.found1 === 'True' && fs.existsSync(path.join('prec_1st', `${c.id1}.json`))) fs.copyFileSync(path.join('prec_1st', `${c.id1}.json`), path.join(d, 'first.json'));
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: r.id, caseNo: r.caseNo, date: r.date, label: r.label, binary: r.binary, round: rn, source: 'live-intake' }, null, 2), 'utf8'); }
  const asg = assign(batch.map((r) => r.id), rn); if (!DRY) fs.writeFileSync(P(`assign_${rd}.json`), JSON.stringify({ round: rn, seed: rn, ...asg, note: '저장소에 올리지 않는다(블라인드 유지)' }, null, 2), 'utf8');
  for (const r of idx) if (batch.some((b) => b.id === r.id)) r.status = `round-${String(rn).padStart(2, '0')}`;
  state.last_round = rn; return { rn, rd, batch, asg }; }

function runNode(script, a) { log(`실행: node ${script} ${a.join(' ')}`); const r = spawnSync('node', [script, ...a], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${script} 실패(코드 ${r.status})`); }

async function poll() {
  if (!OC) throw new Error('환경변수 LAW_OC가 비어 있습니다.');
  const state = loadState(); const { ids, maxDate } = knownIds();
  const sinceDate = args.since || state.last_date || maxDate; const d = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  const from = (() => { const x = d(sinceDate); x.setDate(x.getDate() - 30); return x.toISOString().slice(0, 10).replace(/-/g, ''); })(); // 늦게 올라오는 판결을 놓치지 않으려고 30일 겹쳐 조회
  const to = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  log(`조회 ${from}~${to} (이미 아는 사건 ${ids.size}건 제외)`);
  const found = (await searchRange(from, to)).filter(isCivilJudgment).filter((it) => !ids.has(it.id));
  log(`새 민사 다 판결 ${found.length}건`);
  const idx = readCsv(P('index_live.csv')); const labels = readCsv(P('labels_live.csv')); const chains = readCsv(P('chain_live.csv'));
  for (const it of found.sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))) {
    const body = await fetchBody(it.id); if (!body) { log(`본문 실패: ${it.id} (다음 조회 때 재시도)`); continue; }
    saveJson(path.join('prec_civil', `${it.date}_${it.id}.json`), body);
    const lb = labelFromBody(body.PrecService.판례내용); labels.push({ id: it.id, date: it.date, caseNo: it.caseNo, label: lb.label, binary: lb.binary, order: lb.order });
    const ch = { id: it.id, found2: 'False', id2: '', found1: 'False', id1: '', status2: '', status1: '' };
    const r2 = await findLower(lowerRef(body.PrecService.판례내용, 'second')); ch.status2 = r2.status;
    if (r2.id) { const b2 = await fetchBody(r2.id); if (b2) { saveJson(path.join('prec_2nd', `${r2.id}.json`), b2); ch.found2 = 'True'; ch.id2 = r2.id;
      const r1 = await findLower(lowerRef(b2.PrecService.판례내용, 'first')); ch.status1 = r1.status;
      if (r1.id) { const b1 = await fetchBody(r1.id); if (b1) { saveJson(path.join('prec_1st', `${r1.id}.json`), b1); ch.found1 = 'True'; ch.id1 = r1.id; } } } }
    chains.push(ch); idx.push({ id: it.id, caseNo: it.caseNo, date: it.date, status: 'queued' }); ids.add(it.id);
    log(`수집: ${it.caseNo} (${it.date}) ${lb.label} · 2심 ${ch.found2} · 1심 ${ch.found1}`);
  }
  const newest = [...idx.map((r) => r.date), sinceDate].sort().pop(); state.last_date = newest;
  let round = null; while (idx.filter((r) => r.status === 'queued').length >= SIZE) { const r = await formRound(state, idx, labels, chains); if (!r) break; round = r; log(`라운드 ${r.rd} 편성: ${r.batch.map((b) => b.caseNo).join(', ')}`); if (!AUTO) break; }
  writeCsv(P('index_live.csv'), ['id', 'caseNo', 'date', 'status'], idx);
  writeCsv(P('labels_live.csv'), ['id', 'date', 'caseNo', 'label', 'binary', 'order'], labels);
  writeCsv(P('chain_live.csv'), ['id', 'found2', 'id2', 'found1', 'id1', 'status2', 'status1'], chains); saveState(state);
  log(`대기열 ${idx.filter((r) => r.status === 'queued').length}/${SIZE}건 · 마지막 라운드 r${String(state.last_round).padStart(2, '0')}`);
  if (round && AUTO && !DRY) await auto(round, state);
  else if (round) log(`라운드 ${round.rd} 편성 완료(개요 작성 전). 이어서 하려면 같은 명령에 --auto --repo="<저장소 경로>" 를 붙여 다시 실행하세요(이미 수집한 사건은 다시 받지 않습니다).`);
}

async function auto(round, state) {
  const REPO = args.repo; if (!REPO) throw new Error('--auto에는 --repo="<저장소 경로>"가 필요합니다.'); const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  runNode(path.join(here, 'overview_writer.mjs'), ['--provider=deepseek', '--dev=live/dev_live.csv', '--chain=live/chain_live.csv', `--round=${round.rn}`]);
  runNode(path.join(here, 'export_prep_cases.mjs'), [`--repo=${REPO}`, '--dev=live/dev_live.csv', `--round=${round.rn}`]);
  fs.writeFileSync(P(`ROUND_READY_${round.rd}.txt`), `라운드 ${round.rd} 준비 완료 (${new Date().toISOString()})\nDeepSeek 담당: ${round.asg.deepseek.join(', ')}\nClaude 담당: ${round.asg.claude.join(', ')}\n` +
    `다음: ① 저장소에서 build_rounds_manifest.mjs 실행 후 PR ② Claude 담당분은 채팅 창 실험(진행 담당에게 알림) ③ DeepSeek 담당분은 --run-deepseek 또는 klaw_runner.mjs\n`, 'utf8');
  if (args['run-deepseek']) { const rows = readCsv(P('dev_live.csv')).filter((r) => round.asg.deepseek.includes(r.id)); writeCsv(P(`dsk_${round.rd}.csv`), ['round', 'id', 'caseNo', 'date', 'label', 'binary', 'has1', 'has2'], rows);
    runNode(path.join(here, 'klaw_runner.mjs'), [`--round=${round.rn}`, '--version=v17.2', '--method=klaw_v17_2.md', '--format=가상판결_출력형식_v13_3.txt', `--dev=${P(`dsk_${round.rd}.csv`)}`, `--tag=${round.rd}-dsk`, '--concurrency=2']); }
  log(`라운드 ${round.rd} 자동 처리 완료 — live\\ROUND_READY_${round.rd}.txt 참고`); }

function status() { const s = loadState(); const idx = readCsv(P('index_live.csv'));
  console.log(`마지막 조회 기준일: ${s.last_date || '(없음)'} · 마지막 라운드: r${String(s.last_round).padStart(2, '0')}`);
  console.log(`수집 ${idx.length}건 · 대기열 ${idx.filter((r) => r.status === 'queued').length}/${SIZE} · 편성됨 ${idx.filter((r) => r.status !== 'queued').length}`); }

// ── 자체 시험(네트워크 불필요) ──
async function selftest() { const assertEq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('실패:', m, JSON.stringify(a), '≠', JSON.stringify(b)); process.exit(1); } };
  const xml = `<PrecSearch><totalCnt>2</totalCnt><prec id="1"><판례일련번호>111</판례일련번호><사건번호><![CDATA[2025다1234]]></사건번호><선고일자>2026.07.16</선고일자><사건종류명>민사</사건종류명><법원명>대법원</법원명><사건명>대여금</사건명></prec><prec id="2"><판례일련번호>112</판례일련번호><사건번호>2025두9</사건번호><선고일자>20260716</선고일자><사건종류명>일반행정</사건종류명></prec></PrecSearch>`;
  const r = parseList(xml); assertEq(r.items.length, 2, '목록 수'); assertEq(r.items.map(isCivilJudgment), [true, false], '민사 다 판결 필터'); assertEq(r.items[0].date, '20260716', '선고일 정규화');
  assertEq(parseList('<Response><msg>필수 입력값이 존재하지 않습니다.</msg></Response>').error !== null, true, '오류 응답 감지');
  const body = `<PrecService><판례일련번호>111</판례일련번호><판례내용><![CDATA[【주    문】<br/>상고를 기각한다.<br/>상고비용은 피고가 부담한다.<br/>【이    유】<br/>상고이유를 판단한다.<br/>【원심판결】 서울고법 2025. 3. 7. 선고 2024나12345 판결]]></판례내용></PrecService>`;
  const pb = parseBody(body); assertEq(!!pb, true, '본문 파싱'); const lb = labelFromBody(pb.PrecService.판례내용); assertEq([lb.label, lb.binary], ['상고기각', '유지'], '상고기각 라벨');
  const lb2 = labelFromBody('【주    문】<br/>원심판결을 파기하고, 사건을 서울고등법원에 환송한다.<br/>【이    유】<br/>x'); assertEq([lb2.label, lb2.binary], ['전부파기환송', '파기'], '전부파기환송 라벨');
  assertEq(lowerRef(pb.PrecService.판례내용, 'second'), { court: '서울고법', caseNo: '2024나12345' }, '원심 사건 참조'); assertEq(norm('서울고법'), norm('서울고등법원'), '법원명 정규화');
  const queue = Array.from({ length: 12 }, (_, i) => ({ id: String(900 + i), date: i % 2 ? '20260716' : '20260715', status: 'queued' })); const b = pickBatch(queue, 10); assertEq(b.length, 10, '라운드 크기');
  assertEq(b[0].date <= b[9].date, true, '선고일 순 편성'); const a1 = assign(b.map((x) => x.id), 11), a2 = assign(b.map((x) => x.id), 11); assertEq(a1, a2, '배정 재현성'); assertEq([a1.deepseek.length, a1.claude.length], [5, 5], '5/5 배정');
  assertEq(new Set([...a1.deepseek, ...a1.claude]).size, 10, '배정 중복 없음'); console.log('selftest 통과'); }

{
  (async () => { try { if (CMD === 'selftest') await selftest(); else if (CMD === 'status') status(); else if (CMD === 'poll') await poll(); else { console.error('알 수 없는 명령: ' + CMD); process.exit(1); } }
    catch (e) { console.error('오류: ' + e.message); process.exit(1); } })(); }
