/**
 * 웹서비스설계 9주차 실습 · 백엔드 API 서버 (Node.js Express + 1,000건 인메모리 데이터셋)
 *
 *   1) 방어적 파라미터 파싱 (정수 문자열만 허용, 0·음수·문자 → 기본값, limit 상한)
 *   2) 정렬 화이트리스트 (자기 소유 속성만 허용 → __proto__, constructor 등 상속 속성 차단)
 *   3) 오프셋 페이징 API (/api/posts) + meta Envelope
 *   4) 커서(Keyset) 페이징 API (/api/posts/cursor) + 제목·본문 검색 + limit + 1 hasNext 판단
 *
 * 실행 방법:
 *   npm install
 *   node server.js                         # 일반 실행
 *   DELAY_MS=1500 node server.js           # 느린 네트워크 재현 (모든 API 응답 1.5초 지연)
 *   DELAY_MS=300 JITTER_MS=1500 node server.js  # 응답마다 지연이 달라 응답 순서가 뒤바뀜
 *
 * [수정] 표시가 붙은 부분이 원본 예제에서 바꾼 곳입니다.
 */

const express = require('express');
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// [수정] 느린 네트워크 재현용 인위적 지연 (기본 0 → 실제 동작에는 영향 없음)
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS) || 0);
const JITTER_MS = Math.max(0, Number(process.env.JITTER_MS) || 0);

app.use(express.static(__dirname)); // 현재 폴더의 index.html 정적 서빙
app.use(express.json());

// 1,000건의 더미 게시글 데이터 생성 (1~1000)
const TOPICS = [
  'B-Tree 인덱스 구조와 LIKE %kw% 검색 튜닝 실무',
  '커서 기반(Keyset) 페이지네이션 O(log N) 탐색 원리',
  'ORDER BY SQL Injection과 화이트리스트 매핑 방어',
  'InnoDB 버퍼 풀과 LIMIT OFFSET Cache Thrashing',
  'AbortController를 이용한 비동기 Race Condition 방어',
  '300ms 디바운스(Debounce)와 프론트엔드 입력 최적화',
  'URLSearchParams와 history.pushState 뒤로가기 동기화',
  'InnoDB MVCC 메커니즘과 COUNT(*) 전수 스캔 병목',
  '복합 인덱스(Compound Index) 컬럼 순서의 황금률',
  'Redis 분산 캐시를 활용한 카운트 캐싱 아키텍처',
  'RESTful JSON 페이징 Envelope 규격 표준화',
  'ElasticSearch 역색인(Inverted Index)과 N-gram 전문 검색'
];
const AUTHORS = ['이경수', '김철수', '이영희', '박민수', '정다은', '최준호', '강서연', '윤성호'];

// [수정] Math.random() → 시드 고정 난수(mulberry32)
//        서버를 재시작해도 조회수가 같아야 테스트 결과(캡처)를 재현할 수 있음
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261115);

// [수정] 작성일을 id와 같은 순서로 생성 (id가 클수록 최신)
//        원본은 같은 달 안에서 id가 작아질수록 날짜가 커져 "최신순" 화면의 날짜가 뒤섞여 보였음
const BASE_DATE = Date.UTC(2026, 10, 14); // 2026-11-14 = id 1000의 작성일
const DAY = 24 * 60 * 60 * 1000;

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const topic = TOPICS[i % TOPICS.length];
  const author = AUTHORS[i % AUTHORS.length];
  const views = Math.floor(rand() * 5000) + 10;
  return {
    id,
    title: `[#${id}] ${topic}`,
    content: `게시글 ${id}번의 상세 본문 데이터입니다. DB 인덱스와 페이징 최적화를 실습합니다.`,
    author,
    views,
    createdAt: new Date(BASE_DATE - i * DAY).toISOString().slice(0, 10)
  };
});

// 화이트리스트 정렬 정의 (동점자 방지 id 결합)
// [수정] Object.create(null): 프로토타입이 없는 객체라 __proto__/constructor 등을 상속하지 않음
const SORT_WHITELIST = Object.freeze(Object.assign(Object.create(null), {
  latest: (a, b) => b.id - a.id,
  oldest: (a, b) => a.id - b.id,
  views: (a, b) => (b.views !== a.views ? b.views - a.views : b.id - a.id)
}));

// ==========================================
// [수정] 파라미터 파싱 헬퍼
// ==========================================

// 같은 키가 여러 번 오면(?search=a&search=b) Express는 배열을 만든다.
// 원본은 배열에 .trim()을 호출해 500 에러가 났음 → 문자열 하나만 사용
function single(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value : '';
}

// "12"처럼 숫자로만 된 양의 정수만 허용. 0, -1, abc, 2abc, 1.5 → 기본값
// (원본 parseInt는 "2abc"를 2로 해석했음)
function parsePositiveInt(value, fallback) {
  const s = single(value).trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// 정렬 키: 화이트리스트에 "자기 소유"로 정의된 키만 허용, 나머지는 latest
function parseSort(value) {
  const key = single(value);
  return Object.hasOwn(SORT_WHITELIST, key) ? key : 'latest';
}

const MAX_SEARCH_LENGTH = 100;
function parseSearch(value) {
  return single(value).trim().slice(0, MAX_SEARCH_LENGTH);
}

// 제목·본문 부분 일치 검색 (WHERE title LIKE '%kw%' OR content LIKE '%kw%')
function matchSearch(post, keyword) {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return post.title.toLowerCase().includes(kw) || post.content.toLowerCase().includes(kw);
}

function elapsedMs(startTime) {
  const diff = process.hrtime(startTime);
  return Number((diff[0] * 1000 + diff[1] / 1e6).toFixed(2));
}

// [수정] 느린 네트워크 재현용 지연 미들웨어 (DELAY_MS / JITTER_MS 설정 시에만 동작)
app.use('/api', (req, res, next) => {
  const wait = DELAY_MS + Math.floor(Math.random() * JITTER_MS);
  if (wait > 0) setTimeout(next, wait); else next();
});

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=인덱스
// ==========================================
app.get('/api/posts', (req, res) => {
  const startTime = process.hrtime();

  const page = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, 10), 100);
  const search = parseSearch(req.query.search);
  const sort = parseSort(req.query.sort);

  // 1) 검색 필터링 (WHERE ...)
  const filtered = POSTS.filter(p => matchSearch(p, search));

  // 2) 화이트리스트 정렬 (ORDER BY ...)
  filtered.sort(SORT_WHITELIST[sort]);

  // 3) 오프셋 계산 및 데이터 슬라이싱
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages); // 마지막 페이지를 넘으면 마지막 페이지로
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      sort,    // [수정] 실제 적용된 정렬 키 (잘못된 값이면 latest)
      search,  // [수정] 실제 적용된 검색어
      executionTimeMs
    }
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10&search=인덱스
// 정렬은 id DESC 고정 (커서 = 마지막으로 받은 글의 id)
// ==========================================
app.get('/api/posts/cursor', (req, res) => {
  const startTime = process.hrtime();

  const cursor = parsePositiveInt(req.query.cursor, null); // 잘못된 커서 → 첫 페이지
  const limit = Math.min(parsePositiveInt(req.query.limit, 10), 50);
  const search = parseSearch(req.query.search); // [수정] 커서 API에도 검색 추가

  // [수정] 검색 조건 + 커서 조건을 함께 적용한 뒤 id DESC 정렬
  //   SQL: WHERE (title LIKE ? OR content LIKE ?) AND id < ? ORDER BY id DESC LIMIT limit + 1
  const candidate = POSTS
    .filter(p => matchSearch(p, search) && (cursor === null || p.id < cursor))
    .sort((a, b) => b.id - a.id);

  // limit + 1개를 조회해 다음 데이터 존재 여부(hasNext) 판단 (COUNT(*) 불필요)
  const sliced = candidate.slice(0, limit + 1);
  const hasNext = sliced.length > limit;
  const items = hasNext ? sliced.slice(0, limit) : sliced;
  // [수정] 다음 페이지가 없으면 nextCursor = null
  const nextCursor = hasNext ? items[items.length - 1].id : null;

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      cursor,
      nextCursor,
      limit,
      hasNext,
      search,          // [수정]
      order: 'id DESC', // [수정] 커서 정렬 기준 명시
      executionTimeMs
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 웹서비스설계 9주차 실습 서버 구동 완료`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`📦 데이터: 1,000건의 인메모리 게시글 로드 완료`);
    if (DELAY_MS || JITTER_MS) console.log(`🐢 인위적 지연: ${DELAY_MS}ms + 0~${JITTER_MS}ms`);
    console.log(`====================================================`);
  });
}

module.exports = { app, POSTS };
