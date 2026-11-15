// API 자동 테스트 (Node 내장 test runner, 추가 의존성 없음)
// 실행: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, POSTS } = require('../server');

let server, base;
before(() => new Promise(resolve => {
  server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; resolve(); });
}));
after(() => server.close());

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}
const ids = items => items.map(p => p.id);

// ---------- 검색·정렬 ----------
test('제목 검색: "디바운스"가 제목에 들어간 글만 반환', async () => {
  const { body } = await get('/api/posts?search=' + encodeURIComponent('디바운스') + '&limit=100');
  assert.ok(body.meta.totalCount > 0);
  for (const p of body.items) assert.ok(p.title.includes('디바운스'));
});

test('본문 검색: "게시글 777번"은 본문에만 있는 문구 → 777번 1건', async () => {
  const { body } = await get('/api/posts?search=' + encodeURIComponent('게시글 777번'));
  assert.equal(body.meta.totalCount, 1);
  assert.deepEqual(ids(body.items), [777]);
});

test('결과 없음: items=[], totalCount=0, totalPages=1, hasNext=false', async () => {
  const { body } = await get('/api/posts?search=zzzz');
  assert.deepEqual(body.items, []);
  assert.equal(body.meta.totalCount, 0);
  assert.equal(body.meta.totalPages, 1);
  assert.equal(body.meta.hasNext, false);
});

test('최신순(latest) = id DESC', async () => {
  const { body } = await get('/api/posts?sort=latest&limit=5');
  assert.deepEqual(ids(body.items), [1000, 999, 998, 997, 996]);
});

test('오래된순(oldest) = id ASC', async () => {
  const { body } = await get('/api/posts?sort=oldest&limit=5');
  assert.deepEqual(ids(body.items), [1, 2, 3, 4, 5]);
});

test('조회순(views): views DESC, 동점이면 id DESC (전체 1000건 검사)', async () => {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const { body } = await get(`/api/posts?sort=views&limit=100&page=${page}`);
    all.push(...body.items);
  }
  assert.equal(all.length, 1000);
  let ties = 0;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    assert.ok(a.views >= b.views, `views 순서 오류: ${a.id}(${a.views}) → ${b.id}(${b.views})`);
    if (a.views === b.views) { ties++; assert.ok(a.id > b.id, `동점 id 순서 오류: ${a.id} → ${b.id}`); }
  }
  assert.ok(ties > 0, '동점 데이터가 있어야 id DESC 규칙을 검증할 수 있음');
});

for (const bad of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'views; DROP TABLE posts--', 'LATEST', '']) {
  test(`잘못된 정렬 키 "${bad}" → 200 + latest로 처리`, async () => {
    const { status, body } = await get('/api/posts?limit=3&sort=' + encodeURIComponent(bad));
    assert.equal(status, 200);
    assert.equal(body.meta.sort, 'latest');
    assert.deepEqual(ids(body.items), [1000, 999, 998]);
  });
}

test('같은 키 반복(?search=a&search=b, ?sort=views&sort=x)도 500 없이 처리', async () => {
  let r = await get('/api/posts?search=a&search=b');
  assert.equal(r.status, 200);
  r = await get('/api/posts?sort=views&sort=x');
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.sort, 'views');
});

// ---------- 오프셋 페이지네이션 ----------
test('오프셋: page=3, limit=10 → id 980~971, meta 값 확인', async () => {
  const { body } = await get('/api/posts?page=3&limit=10');
  assert.deepEqual(ids(body.items), [980, 979, 978, 977, 976, 975, 974, 973, 972, 971]);
  assert.deepEqual(
    { page: body.meta.page, limit: body.meta.limit, totalCount: body.meta.totalCount, totalPages: body.meta.totalPages, hasNext: body.meta.hasNext, hasPrev: body.meta.hasPrev },
    { page: 3, limit: 10, totalCount: 1000, totalPages: 100, hasNext: true, hasPrev: true }
  );
});

test('오프셋: 마지막 페이지(100) → hasNext=false', async () => {
  const { body } = await get('/api/posts?page=100&limit=10');
  assert.deepEqual(ids(body.items), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(body.meta.hasNext, false);
  assert.equal(body.meta.hasPrev, true);
});

for (const bad of ['0', '-1', 'abc', '2abc', '1.5', '']) {
  test(`page="${bad}" → page=1`, async () => {
    const { status, body } = await get('/api/posts?page=' + encodeURIComponent(bad));
    assert.equal(status, 200);
    assert.equal(body.meta.page, 1);
    assert.equal(body.items[0].id, 1000);
  });
}

test('page=9999 → 마지막 페이지(100)로 보정', async () => {
  const { body } = await get('/api/posts?page=9999');
  assert.equal(body.meta.page, 100);
});

test('limit=1000 → 100으로 제한', async () => {
  const { body } = await get('/api/posts?limit=1000');
  assert.equal(body.meta.limit, 100);
  assert.equal(body.items.length, 100);
  assert.equal(body.meta.totalPages, 10);
});

for (const bad of ['0', '-5', 'abc']) {
  test(`limit="${bad}" → 기본값 10`, async () => {
    const { body } = await get('/api/posts?limit=' + bad);
    assert.equal(body.meta.limit, 10);
  });
}

test('검색 + 정렬 + 페이지 조합: totalPages = ceil(totalCount / limit)', async () => {
  const { body } = await get('/api/posts?search=' + encodeURIComponent('인덱스') + '&sort=views&limit=7&page=2');
  assert.equal(body.meta.totalPages, Math.ceil(body.meta.totalCount / 7));
  assert.equal(body.items.length, 7);
});

// ---------- 커서 페이지네이션 ----------
async function collectCursor(search, limit) {
  const all = [];
  let cursor = null, calls = 0, last;
  do {
    const q = new URLSearchParams({ limit });
    if (cursor) q.set('cursor', cursor);
    if (search) q.set('search', search);
    last = (await get('/api/posts/cursor?' + q)).body;
    all.push(...last.items);
    cursor = last.meta.nextCursor;
    calls++;
    assert.ok(calls < 2000, '무한 루프 방지');
  } while (last.meta.hasNext);
  return { all, calls, last };
}

test('커서: 검색 없이 끝까지 → 1000건, 누락·중복 없음, id DESC', async () => {
  const { all, calls, last } = await collectCursor('', 30);
  assert.equal(all.length, 1000);
  assert.equal(new Set(ids(all)).size, 1000);
  assert.deepEqual(ids(all), ids(POSTS).sort((a, b) => b - a));
  assert.equal(calls, Math.ceil(1000 / 30));
  assert.equal(last.meta.hasNext, false);
  assert.equal(last.meta.nextCursor, null);
});

for (const kw of ['인덱스', 'Redis', '게시글 5', '커서']) {
  test(`커서 + 검색 "${kw}": 끝까지 모은 결과 = 오프셋 검색 전체 결과 (누락·중복 없음)`, async () => {
    const { all } = await collectCursor(kw, 7);
    const expected = POSTS.filter(p => (p.title + ' ' + p.content).toLowerCase().includes(kw.toLowerCase()))
      .map(p => p.id).sort((a, b) => b - a);
    assert.ok(expected.length > 0);
    assert.equal(new Set(ids(all)).size, all.length, '중복 발생');
    assert.deepEqual(ids(all), expected);
    for (const p of all) assert.ok((p.title + p.content).toLowerCase().includes(kw.toLowerCase()));
  });
}

test('커서: limit + 1 → 정확히 limit개 남았을 때 hasNext=false', async () => {
  // 검색 결과가 정확히 limit개인 경우: limit+1개를 요청해도 limit개만 오므로 hasNext=false
  const kw = '게시글 77'; // 본문 기준 77, 770~779번 → 11건 (커서 limit 상한 50 이하)
  const n = POSTS.filter(p => p.content.includes(kw)).length;
  assert.equal(n, 11);
  const { body } = await get(`/api/posts/cursor?limit=${n}&search=${encodeURIComponent(kw)}`);
  assert.equal(body.items.length, n);
  assert.equal(body.meta.hasNext, false);
  const { body: b2 } = await get(`/api/posts/cursor?limit=${n - 1}&search=${encodeURIComponent(kw)}`);
  assert.equal(b2.items.length, n - 1);
  assert.equal(b2.meta.hasNext, true);
});

test('커서: 결과 없음 → items=[], hasNext=false, nextCursor=null', async () => {
  const { body } = await get('/api/posts/cursor?search=zzzz');
  assert.deepEqual(body.items, []);
  assert.equal(body.meta.hasNext, false);
  assert.equal(body.meta.nextCursor, null);
});

test('커서: 잘못된 cursor(abc, -1, 0) → 첫 페이지, limit=1000 → 50', async () => {
  for (const c of ['abc', '-1', '0']) {
    const { body } = await get('/api/posts/cursor?limit=3&cursor=' + c);
    assert.deepEqual(ids(body.items), [1000, 999, 998]);
  }
  const { body } = await get('/api/posts/cursor?limit=1000');
  assert.equal(body.meta.limit, 50);
  assert.equal(body.meta.order, 'id DESC');
});
