# HuAI Collab Chatroom System — 설치 및 사용 설명서

이 문서 하나로 설치부터 실제 사용까지 다 됩니다. 기술을 몰라도 순서대로 따라 하면 됩니다 —
각 단계마다 "왜 이걸 하는지"도 한 줄씩 적어뒀으니, 뭘 하는지 모르고 그냥 베끼는 느낌은
안 들 겁니다.

이 시스템이 하는 일: 텔레그램 비공개 그룹방 하나가 "AI 업무 지휘소"가 됩니다. 방에서
사람 말투로 지시하면, AI(Claude·Codex)가 실제로 파일을 만들고 고치고, 결과를 방에 보고하고,
방장이 승인 버튼을 눌러야 최종 확정됩니다.

최신 갱신일: 2026-08-23

---

## 시작 전 체크리스트

아래 5가지가 필요합니다. 계정은 전부 무료로 시작할 수 있습니다.

| 무엇 | 왜 필요한가 | 비용 |
|---|---|---|
| Windows PC 1대 | AI가 실제로 코드를 실행하는 곳. 설치 후에는 이 PC가 켜져 있어야 시스템이 돌아갑니다 | 이미 있는 PC면 무료 |
| Node.js | 이 시스템 자체가 Node.js로 만들어져 있습니다 | 무료 |
| Supabase 계정 | 작업 기록·승인 이력·산출물 주소를 저장하는 DB | 무료 플랜으로 충분 |
| Telegram 계정 + 봇 4개 | 사람이 지시하고 결과를 받는 화면 | 무료 |
| Vercel 계정 | AI가 만든 웹 결과물(예: HTML 페이지)을 인터넷에 올려 폰에서 열어보는 용도 | 무료 플랜으로 충분 |

예상 소요 시간: 처음이면 30~50분 정도 걸립니다. 대부분 "계정 만들고 값 복사해서 붙여넣기"입니다.

---

# PART 1. 설치

## 1단계 — Node.js 설치

1. https://nodejs.org 에 접속합니다.
2. "LTS"라고 적힌 버전을 다운로드합니다 (권장 버전).
3. 다운로드한 설치 파일을 실행하고, 나오는 화면에서 전부 "Next"만 눌러 설치를 끝냅니다.
4. 확인: 키보드에서 `Win` 키를 누르고 `PowerShell`이라고 친 뒤 엔터로 엽니다. 그 창에
   아래를 치고 엔터:

   ```powershell
   node --version
   ```

   `v24`로 시작하는 숫자가 나오면 성공입니다. (더 낮은 버전이 나오면 nodejs.org에서
   최신 LTS를 다시 설치하세요.)

## 2단계 — 시스템 파일 받기

**git을 쓸 줄 알면:**

```powershell
git clone https://github.com/SUNWOONGKYU/HuAIChatroomSystem.git C:\Dev\HuAIChatroomSystem
```

**git을 모르면(ZIP으로):**

1. https://github.com/SUNWOONGKYU/HuAIChatroomSystem 접속
2. 초록색 `Code` 버튼 클릭 → `Download ZIP`
3. 다운로드된 zip 파일을 오른쪽 클릭 → "압축 풀기(추출)" → `C:\Dev\HuAIChatroomSystem` 같은
   기억하기 쉬운 경로에 풀기 (이 경로는 뒤에서 계속 씁니다. 폴더명에 한글이나 공백이 없는
   경로를 권장합니다.)

## 3단계 — 필요한 부품 설치 + 빌드

PowerShell에서 방금 그 폴더로 이동한 뒤 아래 3줄을 순서대로 칩니다.

```powershell
cd C:\Dev\HuAIChatroomSystem
npm install
npm run build
```

`npm install`은 시간이 좀 걸립니다(1~3분). 중간에 빨간 글씨가 좀 보여도 마지막에
에러 없이 끝나면 괜찮습니다.

## 4단계 — Supabase 프로젝트 만들기 (데이터 저장소)

왜: 이 시스템은 "누가 뭘 시켰고, 누가 승인했고, 결과물이 뭔지"를 전부 DB에 기록합니다.
텔레그램 메시지는 화면일 뿐이고, 공식 기록은 여기(Supabase)입니다.

1. https://supabase.com 접속 → 회원가입(구글 계정으로 바로 가능)
2. "New Project" 클릭 → 프로젝트 이름 아무거나, DB 비밀번호는 안전한 걸로 정하고 **어딘가에
   메모**(잊어버리면 곤란) → 지역(Region)은 가까운 곳 아무거나 → "Create new project"
3. 1~2분 기다리면 프로젝트가 준비됩니다.
4. 왼쪽 메뉴에서 톱니바퀴(Project Settings) → API 클릭
5. 여기서 두 값을 메모장 같은 곳에 복사해둡니다(뒤에서 씁니다):
   - **Project URL** (`https://xxxxx.supabase.co` 형태)
   - **service_role** 키 (`eyJ...`로 시작하는 긴 문자열 — "secret", "reveal" 눌러야 보임)

   ⚠️ service_role 키는 이 시스템 전체를 조작할 수 있는 열쇠입니다. 남에게 보여주거나
   인터넷(GitHub 등)에 올리면 안 됩니다.

6. 왼쪽 메뉴에서 "SQL Editor" 클릭 → "New query"
7. 방금 받은 폴더 안의 `supabase/schema.sql` 파일을 메모장으로 열어서 **전체 내용을 복사**한
   뒤, SQL Editor에 붙여넣고 오른쪽 아래 "Run" 클릭. "Success" 비슷한 메시지가 뜨면 성공입니다.

## 5단계 — 텔레그램 봇 4개 만들기

왜: 이 시스템은 봇 1개가 아니라 4개(소대장·클로드·코덱스·감사관 역할)를 씁니다. 역할별로
누가 무슨 말을 하는지 구분하기 위해서입니다.

1. 텔레그램 앱에서 `BotFather`를 검색해서 대화를 엽니다(파란 체크마크 있는 공식 봇).
2. `/newbot`을 보냅니다.
3. 봇 이름(사람이 보는 이름, 아무거나)을 물어보면 입력, 예: `HuAI Leader`
4. 봇 아이디(username, 반드시 `bot`으로 끝나야 함)를 물어보면 입력, 예: `my_leader_chatroom_bot`
   (이미 남이 쓰는 이름이면 다른 걸로 다시 시도하라고 나옵니다.)
5. 성공하면 긴 토큰 문자열(`123456:AAxxxxx...` 형태)을 줍니다 — **메모장에 복사**해두고
   어느 역할인지 표시해둡니다.
6. 이 과정(`/newbot`부터)을 **4번 반복**해서 아래 4개를 전부 만듭니다:
   - LeaderBot (소대장 — 지시 접수, 제안, 승인 흐름 담당)
   - ClaudeBot (Claude Code 실행 담당)
   - CodexBot (Codex 실행 담당)
   - AuditBot (독립 검증 담당)

   ⚠️ 4개는 반드시 서로 다른 봇(다른 토큰)이어야 합니다. 봇 1개로 4역할을 흉내내는 방식이
   아닙니다.

## 6단계 — 텔레그램 비공개 그룹 만들고 봇 초대

1. 텔레그램에서 새 그룹을 만듭니다(비공개로).
2. 그룹에 방금 만든 봇 4개를 전부 초대합니다(연락처 검색하듯 봇 username으로 검색).
3. **그룹 chat_id 알아내기** (숫자, 보통 `-`로 시작하는 음수):
   - 그룹에서 아무 메시지나 하나 보냅니다(예: "테스트").
   - 브라우저 주소창에 아래를 입력합니다(`<봇토큰>` 자리에 LeaderBot 토큰을 넣습니다):
     ```
     https://api.telegram.org/bot<봇토큰>/getUpdates
     ```
   - 화면에 나오는 텍스트에서 `"chat":{"id":` 뒤에 나오는 숫자가 그룹 chat_id입니다
     (예: `-1004334034373`). 메모해둡니다.
4. **내 텔레그램 user_id 알아내기**:
   - 텔레그램에서 `@userinfobot`을 검색해서 아무 메시지나 보냅니다.
   - 숫자로 된 내 Id를 알려줍니다. 메모해둡니다. (이 값이 나중에 "방장 권한"의 기준이 됩니다 —
     승인 버튼은 이 id를 가진 사람만 누를 수 있습니다.)

## 7단계 — 설정 파일 만들기

왜: 위에서 모은 값들(Supabase URL, 봇 토큰 4개, chat_id, 내 user_id)을 시스템이 읽는
파일 하나에 모아둡니다.

1. 파일 탐색기에서 받은 폴더(`C:\Dev\HuAIChatroomSystem`) 안의 `.env.operation.example`
   파일을 찾습니다. (파일 탐색기에서 점(`.`)으로 시작하는 파일이 안 보이면, 보기 메뉴에서
   "숨긴 항목" 체크)
2. 이 파일을 복사해서 붙여넣고, 새 파일 이름을 `.env.operation.local`로 바꿉니다.
3. `.env.operation.local`을 메모장(오른쪽 클릭 → 연결 프로그램 → 메모장)으로 엽니다.
4. 아래 표를 보고 값을 채워 넣습니다(`=` 뒤에 값만 붙여넣으면 됩니다, 따옴표 없이):

   | 이 파일의 항목 | 어디서 가져온 값인지 |
   |---|---|
   | `SUPABASE_URL` | 4단계의 Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | 4단계의 service_role 키 |
   | `BOT_SERVICE_TELEGRAM_CHAT_ID` | 6단계의 그룹 chat_id |
   | `BOT_SERVICE_OWNER_TELEGRAM_USER_ID` | 6단계의 내 user_id |
   | `BOT_SERVICE_PLATOON_BOT_TOKEN` | LeaderBot 토큰 |
   | `BOT_SERVICE_CLAUDE_BOT_TOKEN` | ClaudeBot 토큰 |
   | `BOT_SERVICE_CODEX_BOT_TOKEN` | CodexBot 토큰 |
   | `BOT_SERVICE_AUDITOR_BOT_TOKEN` | AuditBot 토큰 |

5. `BOT_SERVICE_RECEIVE_MODE=polling` 줄이 이미 있는지 확인합니다(없으면 추가). 이 값이면
   공개 인터넷 주소·터널 설정 없이 그냥 이 PC에서 텔레그램으로 직접 연결됩니다 — 초보자에게
   가장 간단한 방식입니다.
6. `LOCAL_GATEWAY_ALLOWED_ROOTS`를 2단계에서 받은 폴더 경로로 맞춰둡니다(기본값이 이미
   `C:\Dev\HuAIChatroomSystem`이면 그대로 두면 됩니다. 다른 경로에 풀었다면 그 경로로 바꿉니다).
7. 저장하고 메모장을 닫습니다.

⚠️ 이 파일(`.env.operation.local`)은 절대 GitHub에 올리거나 남에게 보내면 안 됩니다.
비밀번호나 다름없는 값들이 들어있습니다. (`.gitignore`에 이미 등록돼 있어서 실수로
git에 올라가지는 않습니다.)

## 8단계 — 이 방을 시스템에 등록하기

왜: Supabase DB에 "이 텔레그램 그룹 = 이 프로젝트 폴더"라는 연결 정보를 넣어야, 봇이
어느 방에서 온 지시를 어느 폴더에서 실행할지 압니다.

1. 방 고유 번호(UUID)를 하나 만듭니다. PowerShell에서:

   ```powershell
   node -e "console.log(crypto.randomUUID())"
   ```

   나온 값(`xxxxxxxx-xxxx-...` 형태)을 메모해둡니다 — 이게 이 방의 room-id입니다.

2. 아래 명령을 실행합니다(`<room-id>`, `<chat-id>`, `<owner-id>`, `<project-path>`를
   앞에서 모은 실제 값으로 바꿔서):

   ```powershell
   node scripts/generate-supabase-room-seed.mjs --room-id <room-id> --chat-id <chat-id> --owner-id <owner-id> --project-path "C:\Dev\HuAIChatroomSystem"
   ```

3. 화면에 SQL 문장들이 출력됩니다. 이 전체를 복사해서 Supabase SQL Editor(4단계에서 썼던
   그 화면)에 새 쿼리로 붙여넣고 Run을 누릅니다.

## 9단계 — Claude Code / Codex 로그인

이 PC에 Claude Code와 Codex CLI가 설치·로그인돼 있어야 실제 작업 실행이 됩니다(이 부분은
각 도구의 공식 설치 절차를 따르며, 이 문서 범위를 벗어납니다 — 이미 설치돼 있다면 이
단계는 건너뛰어도 됩니다).

## 10단계 — 서비스 실행하기

PowerShell 창을 **2개** 엽니다(각각 하나씩 계속 띄워둘 겁니다).

**창 1**:
```powershell
cd C:\Dev\HuAIChatroomSystem
node dist/apps/bot-service/src/cli.js
```

**창 2**:
```powershell
cd C:\Dev\HuAIChatroomSystem
node dist/apps/local-gateway/src/cli.js
```

두 창 모두 에러 없이 뭔가 계속 떠 있는 상태(멈추지 않고 대기 중)면 정상입니다. 이 두 창은
**PC가 켜져 있는 동안 계속 열려 있어야** 시스템이 작동합니다(닫으면 봇이 멈춥니다).

## 11단계 — 설치 확인

텔레그램 그룹방에 가서 아래처럼 쳐봅니다(봇 이름은 실제로 만든 username으로):

```text
@my_leader_chatroom_bot 안녕
```

LeaderBot이 몇 초 안에 반응하면 설치 성공입니다. 반응이 없으면 맨 아래 "문제가 생기면"
섹션을 봅니다.

---

# PART 2. 사용법

## AI에게 일 시키기

방에서 봇을 지목해서 말하면 접수됩니다(그냥 아무 말이나 하면 시스템이 관여하지 않습니다 —
사람끼리 대화하는 공간이기도 하니까요).

```text
@my_leader_chatroom_bot 버튼 오류 원인을 찾아 수정해줘
```

LeaderBot이 이걸 "작업 제안"으로 정리해서 목적·범위·완료 조건을 방에 올립니다.

## 승인하기

작업 제안 아래에 버튼이 뜹니다:

- **실행**: 승인하고 진짜 작업을 시작합니다.
- **수정**: 제안 내용을 다시 다듬어달라고 요청합니다.
- **반려**: 이 제안은 진행하지 않습니다.

**예외 — 자동허용**: 파일을 전혀 안 바꾸는 조회·분석·설명성 지시는 이 버튼 자체가 뜨지
않고 바로 실행이 시작됩니다(방에 "🟢 자동 시작" 안내만 뜹니다). 판단이 애매하면 시스템은
항상 안전한 쪽(승인 필요)으로 처리하므로, 실제로 파일을 만들거나 고치는 지시라면 거의
항상 버튼이 뜹니다.

## 결과 확인하기

작업이 끝나면 방에 결과가 옵니다. 300자가 넘는 긴 보고는 앞부분만 방에 오고
**[전문 보기]** 버튼이 붙습니다 — 눌러 현황판에서 전체를 봅니다.

현황판(작업 목록·진행률·전문·완료 승인)은 방에 고정된 링크나 `/tasks` 명령으로 엽니다.

## 완료 승인하기

작업이 끝나면 **현황판에서** 완료 승인을 합니다(방 안에는 완료 승인 버튼이 따로 없습니다 —
"완료 승인은 현황판에서"라고 안내가 뜹니다).

**퀴즈가 뜰 수 있습니다**: 파일을 실제로 만들거나 바꾼 작업은, 완료 승인을 누르기 전에
"뭐가 바뀌었는지 이해했는지" 확인하는 객관식 3문항이 먼저 나옵니다(인지부채 방지 장치 —
AI에게 맡기기만 하고 아무도 내용을 모르는 상태를 막기 위해서입니다). 통과해야 진짜
완료 승인 버튼이 나옵니다.

**웹 페이지를 만든 작업이라면**: 완료 승인 전에는 산출물 링크가 "프리뷰"(미리보기, 아직
정식 주소 아님) 상태입니다. 완료 승인을 누르는 순간 그 링크가 정식(프로덕션) 주소로
바뀝니다 — 승인 전에 결과물이 먼저 공개돼버리는 걸 막기 위한 설계입니다.

## 그 밖의 명령어

```text
/tasks                작업 목록
/task <task_id>       작업 하나 상세
/search <단어>         작업 검색
/trace <task_id>      이벤트·산출물·검증 이력
@audit_chatroom_bot 이 작업을 보안 검토해줘   (감사관에게 직접 요청)
```

---

# 문제가 생기면

| 증상 | 원인·해결 |
|---|---|
| 봇이 아무 반응이 없다 | 10단계의 두 PowerShell 창이 열려 있는지 확인. 닫혀 있으면 다시 실행 |
| `npm install`에서 멈추거나 에러 | 인터넷 연결 확인 후 `npm install` 다시 실행. 그래도 안 되면 Node.js 버전을 v24 LTS로 재설치 |
| 창을 열자마자 바로 꺼진다(에러) | `.env.operation.local`에 빈 값이 없는지 확인(특히 4개 봇 토큰, Supabase URL/키) |
| "봇 여러 개가 같은 토큰" 비슷한 에러 | 5단계에서 봇 4개가 진짜 서로 다른 토큰인지 확인 |
| 승인 버튼을 눌러도 반응이 늦다 | 정상입니다 — 실제 AI 실행은 몇 초~몇 분 걸립니다. 방에 "⏳ 작업 중" 표시가 주기적으로 올라옵니다 |
| Supabase SQL 실행에서 에러 | `supabase/schema.sql` 전체를 빠짐없이 붙여넣었는지 확인(일부만 붙여넣으면 실패) |

이 표에 없는 문제는 `GITHUB_QUICKSTART.md`(같은 폴더, 더 기술적인 버전)와
`OPERATION_STATUS.md`(현재 알려진 이슈 목록)를 참고하세요.
