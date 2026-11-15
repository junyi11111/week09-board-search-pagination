# 9주차 실습 2 · 검색·정렬·페이지네이션 게시판 개선

웹서비스설계 9주차 실습 예제(`week09-practice.zip`)를 실행·검증하고, 발견한 문제를 고친 결과물입니다.
항목별 테스트 입력/기대/실제 결과와 캡처는 **[실습 보고서 (docs/REPORT.md)](docs/REPORT.md)** 에 있습니다.

- 원본 코드: 첫 커밋 `5190422` (수정 전 그대로)
- 수정 내역: 이후 커밋들 / 코드에서 `[수정]` 주석으로 표시
- 원본과의 전체 차이: `git diff 5190422 -- server.js index.html`

## 실행 방법

```bash
npm install          # express 설치 (node_modules는 저장소에 포함하지 않음)
npm start            # = node server.js → http://localhost:3000
npm test             # API 자동 테스트 37개 (Node 20 이상, 추가 설치 없음)

# 느린 네트워크 재현 (요청 취소 실험용)
DELAY_MS=1500 node server.js                 # 모든 API 응답 1.5초 지연
DELAY_MS=300 JITTER_MS=1500 node server.js   # 응답마다 지연이 달라 순서가 뒤바뀜
```

브라우저 DevTools → Network → Throttling(Slow 3G)으로도 같은 실험을 할 수 있습니다.

## 파일 구성

| 파일 | 내용 |
|---|---|
| `server.js` | Express API. `GET /api/posts` (오프셋), `GET /api/posts/cursor` (커서), 1,000건 인메모리 데이터 |
| `index.html` | 게시판 SPA + 우측 검사기(요청 URL, SQL 미리보기, JSON 응답, **요청 로그**) |
| `test/api.test.js` | `node:test` 기반 API 테스트 37개 |
| `docs/REPORT.md` | 실습 보고서 (항목별 테스트·수정 내용·개념 설명) |
| `docs/screenshots/` | 테스트 캡처 |
| `docs/test-output.txt` | `npm test` 실행 결과 |

## API

| 엔드포인트 | 파라미터 | 비고 |
|---|---|---|
| `GET /api/posts` | `page`(기본 1), `limit`(기본 10, 최대 100), `sort`(`latest`·`oldest`·`views`), `search` | `meta`: page, limit, totalCount, totalPages, hasNext, hasPrev, sort, search |
| `GET /api/posts/cursor` | `cursor`(마지막으로 받은 id), `limit`(기본 10, 최대 50), `search` | 정렬은 **id DESC 고정**. `meta`: cursor, nextCursor, limit, hasNext, search, order |

잘못된 값 처리: `page`/`limit`/`cursor`는 숫자로만 된 양의 정수만 인정(`0`, `-1`, `abc`, `2abc`, `1.5` → 기본값), `page`가 마지막 페이지를 넘으면 마지막 페이지, `sort`는 화이트리스트에 없으면 `latest`.

## 주요 수정 사항 요약

| 구분 | 수정 전 (원본) | 수정 후 |
|---|---|---|
| 정렬 화이트리스트 | 일반 객체 조회 → `sort=__proto__`, `hasOwnProperty` 입력 시 **500**, `constructor`는 `Object` 함수가 비교 함수로 사용됨 | `Object.create(null)` + `Object.hasOwn` 검사 → 상속 속성 차단, `latest`로 처리 |
| 파라미터 파싱 | `parseInt`라 `page=2abc` → 2, `search=a&search=b`(배열) → **500** | 정규식으로 숫자 문자열만 허용, 배열은 첫 값만 사용 |
| 커서 API | 검색어 **무시** | 검색 + `id < cursor` 조건 후 id DESC, `limit + 1`로 hasNext 판단, 끝이면 `nextCursor=null` |
| 커서 화면 | 정렬 선택 가능(실제로는 반영 안 됨), 검색어 미전송 | 정렬 선택 비활성화 + "id DESC 고정" 안내, 검색어 전송, 검색 변경 시 누적 목록·커서 초기화, 로딩 중·끝에서 더 보기 비활성화 |
| 오래된 응답 | `abort()`만 사용 | `abort()` + 요청 번호(seq) 검사로 늦게 온 응답 무시 |
| 오류 처리 | `res.ok` 미확인 | HTTP 오류 시 메시지 표시, AbortError는 정상 흐름으로 기록만 |
| URL 복원 | `sort`·`page`를 검증 없이 사용, 같은 URL도 매번 `pushState` | 값 검증, 서버가 보정한 값은 `replaceState`로 반영, 같은 URL은 기록 생략 |
| 데이터 | 조회수 `Math.random()`(재시작마다 바뀜), 작성일이 id 순서와 불일치 | 시드 고정 난수, 작성일을 id 순서와 일치 |
| 확인 도구 | – | 결과 요약(총 N건·페이지), 요청 로그(전송/반영/취소/무시), 느린 네트워크 옵션, 자동 테스트 |

## 개념 설명

### ① 오프셋·커서에 적합한 화면

| | 오프셋 (`LIMIT ? OFFSET ?`) | 커서 (`WHERE id < ? ORDER BY id DESC LIMIT ?`) |
|---|---|---|
| 적합한 화면 | 페이지 번호가 있는 게시판, 관리자 목록, 검색 결과 n페이지로 바로 이동 | 무한 스크롤 피드(SNS 타임라인, 댓글, 알림), "더 보기" 목록 |
| 장점 | 임의 페이지 점프, 총 개수·총 페이지 표시 | 깊은 위치도 인덱스로 바로 찾음, 중간에 글이 추가돼도 중복·누락 없음 |
| 단점 | 뒤 페이지일수록 앞의 행을 건너뛰는 비용 증가, 조회 중 글이 추가/삭제되면 중복·누락 | 특정 페이지로 점프 불가, 정렬 기준이 고유하고 인덱스가 있어야 함 |

### ② 디바운스·요청 취소의 역할

- **디바운스(300ms)**: 입력이 멈춘 뒤 300ms 동안 추가 입력이 없을 때만 요청합니다. "Redis 분산"을 100ms 간격으로 치면 8번 입력해도 요청은 **1번**만 나갑니다. **요청 개수 자체를 줄입니다.**
- **요청 취소(AbortController)**: 디바운스를 통과한 요청끼리도 겹칠 수 있습니다(느린 네트워크에서 검색어를 다시 바꾼 경우). 새 요청을 보내기 전에 이전 요청을 `abort()`해서 네트워크 낭비를 줄이고, **먼저 보낸 요청의 응답이 늦게 도착해 최신 결과를 덮어쓰는 문제(race condition)** 를 막습니다. 이 코드는 응답 직전에 취소가 늦는 경우까지 대비해 요청 번호 검사를 한 번 더 합니다.

### ③ `limit + 1` 원리

`limit`개를 보여줄 때 **`limit + 1`개를 조회**합니다. 결과가 `limit`보다 많으면 다음 데이터가 있다는 뜻이므로 `hasNext = true`로 두고, 마지막 1개는 버린 뒤 `limit`개만 응답합니다. 이렇게 하면 `COUNT(*)`로 전체 개수를 세지 않고도 "더 보기" 버튼을 켤지 정할 수 있습니다.
예) limit=10 → 11개 조회. 11개가 오면 10개만 반환하고 hasNext=true, 10개 이하로 오면 그대로 반환하고 hasNext=false.

### ④ offset·totalPages 계산식

```
offset     = (page - 1) × limit
totalPages = max(1, ceil(totalCount / limit))   // 결과 0건이어도 1페이지
page       = min(요청 page, totalPages)          // 마지막 페이지를 넘으면 보정
hasNext    = page < totalPages,  hasPrev = page > 1
```

예) "Redis" 검색 83건, limit=10 → totalPages = ceil(83/10) = 9. page=3이면 offset = 20 → 21~30번째 글. page=9이면 offset 80 → 3건.

## AI 활용 내역

- 사용 도구: Claude Code (Anthropic, Claude Opus 5.5)
- AI가 한 일: 원본 코드 분석과 문제점 찾기, `server.js`·`index.html` 수정, API 테스트(`test/api.test.js`) 작성, Playwright로 브라우저 동작 확인과 캡처, README·보고서 초안 작성
- 자동으로 검증한 내용: `npm test` 37개 통과, 브라우저에서 디바운스 요청 수, 느린 네트워크(1.5초)에서의 요청 취소, 오래된 응답 무시, 새로고침·뒤로 가기 복원 (자세한 결과는 [보고서](docs/REPORT.md))
- 직접 검증한 내용: [보고서 9절](docs/REPORT.md#9-ai-활용-및-직접-검증)에 기록
