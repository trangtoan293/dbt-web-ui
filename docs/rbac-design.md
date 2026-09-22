# RBAC — thiết kế và kế hoạch triển khai

## Trạng thái implement (2026-09-22)

**Đã xong — Phase A (data model), B (dbt-runner), C (Next.js server actions):**
- Migration `20260922072403_add_rbac` áp trên DB dev, kèm backfill (mỗi project cũ tự cấp `edit` cho `created_by`).
- `dbt-runner/app/core/auth.py`: thêm `get_user_role`, `authorize_project(action)`; `verify_project_ownership` giờ là alias mỏng gọi `authorize_project(action="edit")`.
- 7 router dbt-runner (`files.py`, `git.py`, `dbt.py`, `sse.py`, `charts.py`, `ingest.py`, `lake.py`) đã chuyển hết sang `authorize_project` với đúng `view`/`edit` theo bảng ở §3-4. Toàn bộ raw SQL `created_by = :uid` rải rác đã gộp về `authorize_project`.
- Vá thêm 2 lỗ hổng phát hiện khi làm (không nằm trong bảng gốc nhưng cùng loại, sửa luôn vì trong phạm vi "file/git một project"): `connection.py` thiếu `require_user` ở cả 4 endpoint; `sse.py`'s `/sse/files/{project_id}` thiếu auth hoàn toàn.
- `nextjs/src/lib/authz.ts` (mới): `requireProjectAccess`, `requireAdmin`, `visibleProjectsWhere`, `getCurrentUserRole`.
- `nextjs/src/lib/actions/data.ts`: toàn bộ hàm project/run/ingest-source/target/schedule đã chuyển sang `requireProjectAccess`/`visibleProjectsWhere`. `connections`/`dremioSource` **giữ nguyên** `createdBy` cá nhân (đúng thiết kế §3). `createProject` tự cấp `ProjectPermission(level=edit)` cho người tạo trong cùng transaction; chặn role `viewer` tạo project (câu hỏi mở §7.1, chốt phương án b).
- `ingestSource`/`dbtSchedule`: đổi từ "chỉ người tạo mới sửa/xoá được" sang "ai có quyền edit trên project thì sửa/xoá được", đúng quyết định nới quyền ở §3.
- `nextjs/src/app/api/projects/[projectId]/env-vars/route.ts`: đổi từ kiểm tra `createdBy` sang `requireProjectAccess`. **Giá trị biến môi trường vẫn khoá theo `(project, owner)` như cũ** — endpoint này chưa từng trả giá trị thật ra browser (chỉ `hasValue: boolean`), nên quyết định "mở giá trị theo project" ở §3 không có gì để áp dụng ở đây; chỉ quyền *vào được endpoint* đổi theo project access.
- Test: `dbt-runner` — 330 pass, 60 fail (toàn bộ 60 là lỗi môi trường Windows-vs-Linux có sẵn từ trước, đã đối chiếu từng file; 1 test (`test_boards.py::test_board_routes_check_project_owner_before_parsing_or_execution`) phải sửa vì mock nhắm đúng tên hàm cũ, đã sửa). `nextjs` — `npm run test:unit` 120/120 pass; `npm test` (chạm DB) chưa chạy vì chưa có `.env.test`/DB test riêng.

**Đã xong thêm — Phase D (UI, 2026-09-22):**
- `token.role`/`session.user.role` (nextjs/src/lib/auth.ts, types/next-auth.d.ts) — chỉ để hiện/ẩn UI, không dùng để authorize; `GlobalContext.tsx` expose `user.role`.
- `AdminUsersCard.tsx` (Settings, chỉ admin thấy — tự ẩn nếu API trả 403): đổi role qua dropdown.
- `AccessPanel.tsx` (tab "Access" mới trong `ProjectSettingsDialog`): danh sách + thêm/xoá `project_permissions` theo email, level `view`/`edit`.
- API: `GET /api/admin/users`, `PATCH /api/admin/users/[id]` (admin only, chặn hạ quyền admin cuối cùng); `GET/POST /api/projects/[projectId]/access`, `DELETE .../access/[userId]` — dùng `requireProjectAccess(id,'edit')` chứ không phải `requireAdmin()`, đúng theo mục Backlog bên dưới (contributor có edit trên project nào thì tự cấp/thu quyền được trên đúng project đó, không tự phong admin được vì route đổi role tách riêng và admin-only).
- Type-check + lint sạch, `npm run test:unit` vẫn 120/120.

**Đã xong thêm — Phase E (frontend disable theo quyền, 2026-09-22):**
- `authz.ts`: thêm `getProjectAccessSummary(projectId)` — 1 query, trả `{ role, canEdit }` cho project đang mở. Gộp chung rule `permits()` với `requireProjectAccess` để 2 nơi không lệch nhau.
- `getProjectById`/`getProjects` (data.ts) giờ trả kèm `access: { role, canEdit }` — mọi nơi đã load project có sẵn field này, không cần round-trip riêng.
- `DevelopLayout.tsx` → `project.access.canEdit` truyền xuống:
  - `RightPanel`: disable toàn bộ dropdown lệnh dbt (Run/Test/Build/Debug/Deps/Seed/Generate Docs/Delete Project) bằng 1 nút, disable Save File.
  - `SourceControlPanel`: disable Commit/Push/Pull/Sync/Fetch/Create branch/Switch branch/ô nhập message; ẩn hẳn nút "Edit remote" (ẩn luôn form bên trong).
  - `ProjectSettingsDialog`: disable Rename; `TargetsPanel`/`LakehousePanel`/`EnvVarsPanel` nhận `disabled`; Danger zone tách 2 mức — Delete (soft) theo `canEdit`, Restore/Delete permanently theo `role==='admin'` (khớp đúng luật admin-only ở backend).
- Type-check, lint, `npm run test:unit` (120/120) đều sạch sau toàn bộ thay đổi.

**Đã xong thêm — Phase F (Orchestrate, Data, Home, 2026-09-22):**
- `SchedulesView.tsx`: mỗi schedule tra `canEdit` theo đúng `projectId` của nó (không phải role chung) — disable Run now/Pause-Resume/Edit/Delete; "New schedule" chỉ bật khi có ít nhất 1 project edit được; `ScheduleDialog` chỉ nhận danh sách project đã lọc edit-được.
- `SourcesView.tsx` + `IngestRunPanel.tsx` + `SourceDialog.tsx`: cùng pattern — Edit/Delete load theo `canEdit` của đúng project chứa nó; Run load/Stop/Full refresh trong panel chạy load disable theo `canEdit`; form tạo/sửa load chỉ cho chọn project edit-được.
- `ProjectCard.tsx` (Home): nút Delete trên card ẩn hẳn nếu `access.canEdit` false.
- Type-check, lint, `npm run test:unit` (120/120) sạch sau toàn bộ Phase F.

**Biết rõ chưa che — không tự nhận là đã "disable tất cả":**
- File explorer: tạo/xoá/đổi tên/di chuyển/copy file chưa gắn `canEdit` (backend vẫn chặn 404, chỉ là nút không tự disable).
- Ô gõ lệnh tự do trong Terminal (`git ...`, `dbt ...`) không bị chặn ở input — vẫn phụ thuộc hoàn toàn vào backend trả lỗi.
- `AgentPanel` (trợ lý AI) chưa kiểm tra quyền — assistant sửa file qua MCP tool, backend (dbt-runner) đã chặn đúng, nhưng UI chưa disable việc mở chat với ai chỉ có view.
- `SourcesView`/`SchedulesView`: nút Refresh, tìm kiếm, filter theo project — không cần disable (đều là view), chỉ nêu để rõ phạm vi đã rà.
- Explore (dashboard/chart builder), Data page ngoài ingest sources (connections, lakehouse) — chưa rà.

**Chưa làm — cần phiên sau:**
1. Test thủ công qua UI (3 API route mới, 2 component mới) — mới verify bằng type-check/lint/test tự động, **chưa click thử trên trình duyệt thật**.
2. **Set admin đầu tiên:** đã làm cho `zeus@test.local` bằng SQL tay (xem bảng dữ liệu test bên dưới). Giờ có UI rồi, việc gán role tiếp theo nên thử qua chính `AdminUsersCard`.
3. Cụm `/dbt/docs/*` (dbt-runner) + 2 route Next.js `dbt-docs/view`, `dbt-docs/static`:** hoàn toàn không có auth (không `require_user`, không forward token) — phát hiện khi rà `data.ts`, cùng loại lỗi với `connection.py` đã vá nhưng **chưa sửa**, vì cần sửa cả 2 phía (thêm `require_user`+`authorize_project` ở 6 endpoint dbt-runner, và forward bearer token ở 2 route Next.js) mới hoạt động - sửa nửa vời sẽ vỡ tính năng xem docs.
4. `/dbt/init`, `/ingest/meta` (dbt-runner) vẫn không có `require_user` — phát hiện phụ, chưa đánh giá mức độ nghiêm trọng, chưa sửa.
5. Chưa viết test mới cho `authorize_project`/`requireProjectAccess` (chỉ sửa 1 test cũ cho pass lại) — nên có test riêng cho: admin bypass, viewer bị chặn edit dù có level=edit, contributor level=view bị chặn edit, không có dòng permission thì 404.

## Backlog — yêu cầu thêm (2026-09-22, chưa implement)

**Contributor tự cấp quyền trên project mình có edit.** Hiện tại §3 chốt "cấp/thu quyền → chỉ admin". Người dùng yêu cầu nới: **contributor có `level=edit` trên project nào thì được thêm viewer/contributor khác vào đúng project đó** (không cấp được ở project mình không có quyền, và không tự phong admin). Việc cần làm khi implement:
- Đổi `/api/admin/projects/[id]/access` (POST/DELETE) từ `requireAdmin()` sang `requireProjectAccess(id, 'edit')` — vẫn giữ **route riêng cho đổi `users.role`** (`PATCH /api/admin/users/[id]`) là **chỉ admin**, vì đó là trần quyền toàn cục, không phải phạm vi 1 project.
- Chặn rõ: contributor cấp quyền chỉ được chọn level `view` hoặc `edit`, **không được tự đặt ai đó thành admin** qua đường này — đường cấp admin chỉ có `PATCH /api/admin/users/[id]` (admin-only).
- `authorize_project` phía dbt-runner không cần đổi (nó không quản lý bảng `project_permissions`, chỉ đọc).
- Cân nhắc thêm: một contributor có nên tự rút quyền của người khác trên project họ không tạo ra không, hay chỉ admin/người tạo mới rút được — chưa quyết.

## Dữ liệu test hiện có trên DB dev (2026-09-22, để tái dùng ở phiên sau)

| User | Role | Project có quyền | Level |
|---|---|---|---|
| `zeus@test.local` | admin | tất cả (bypass) | — |
| `local@dbt-craft.local` | contributor | `hoaipham-test-dbt1`, `hoaipham-22` | edit (chủ cả 2) |
| `perseus@test.local` | contributor | `hoaipham-test-dbt1` | edit |
| `hermes@test.local` | viewer | `hoaipham-test-dbt1` | view |


> Nguồn yêu cầu: `docs/authorization.md` (giữ nguyên, không sửa). File này là bản
> thiết kế đầy đủ, đối chiếu với code thật tại HEAD `24741c8` + các thay đổi
> auth Keycloak trong phiên làm việc 2026-09-21/22, để implement thẳng được.
> Phần "Review yêu cầu gốc" ở cuối liệt kê chỗ đã làm rõ hoặc bổ sung so với
> `docs/authorization.md`.

## 0. Nguyên tắc nền

- **Role là trần quyền (ceiling), permission theo project quyết định phạm vi.**
  `admin` bỏ qua mọi kiểm tra phạm vi. `contributor`/`viewer` chỉ hành động được
  trên project có dòng cấp quyền (`project_permissions`) — không có dòng thì
  **không thấy project đó tồn tại** (404, không phải 403 — giữ đúng quy ước đã
  có ở `verify_project_ownership`: 403 sẽ xác nhận project có tồn tại, lộ
  thông tin cho người không liên quan).
- **Secret cá nhân không bao giờ "lan" theo quyền project.** `git_credentials`,
  giá trị `dbt_environment_variables`, `ai_credentials`, `ai_providers` luôn
  khoá theo `(project, chính người đó)` hoặc theo user tuyệt đối — được cấp
  quyền edit một project **không** cho xem PAT git, giá trị biến môi trường,
  hay AI key của người khác trong project đó.
- **Không tin role/permission nhúng trong token nào cả** — cả access token
  Keycloak (RS256, do dbt-runner tự verify qua JWKS) lẫn session JWT của
  NextAuth (HS256, `AUTH_SECRET`) đều **không** mang role đáng tin. Mọi hành
  động ghi (mutation) phải tra lại Postgres tại thời điểm xử lý, ở đúng phía
  đang xử lý request đó. Giá trị role đặt vào session NextAuth (`token.role`)
  chỉ để **hiện/ẩn UI cho mượt**, không phải nguồn sự thật.
- **Hai backend độc lập, hai chỗ phải enforce riêng:** dbt-runner (file, git,
  chạy dbt, ingest, lake) và Next.js server actions/API routes (connections,
  schedules, ingest source CRUD qua Prisma trực tiếp, project CRUD). Route qua
  dsh-agent không cần sửa gì — theo CLAUDE.md nó không có `DATABASE_URL`, luôn
  đi qua dbt-runner's MCP endpoint, nên tự động được chặn khi dbt-runner chặn.

## 1. Data model

### 1.1 `users.role` (mới)

```prisma
enum UserRole {
  admin
  contributor
  viewer

  @@map("user_role")
}

model User {
  // ...existing...
  role UserRole @default(contributor) @map("role")
}
```

Vì sao mặc định `contributor` chứ không phải `viewer`: migration backfill (§3)
tự tạo cho mỗi user một dòng `project_permissions(level=edit)` trên đúng
project họ đã tạo — `contributor` là role tối thiểu cho phép dùng dòng đó.
User **mới** tạo sau khi RBAC lên thì mặc định `contributor` nhưng **chưa có
project nào được cấp** — tức là chưa làm được gì cho tới khi admin cấp quyền,
đúng tinh thần default-deny. Muốn một user mới mặc định thấy được gì đó thì
đó là việc admin chủ động cấp, không phải giá trị mặc định của role.

### 1.2 `project_permissions` (bảng mới)

```prisma
enum ProjectPermissionLevel {
  view
  edit

  @@map("project_permission_level")
}

model ProjectPermission {
  id        String                  @id @default(uuid()) @db.Uuid
  projectId String                  @map("project_id") @db.Uuid
  userId    String                  @map("user_id") @db.Uuid
  level     ProjectPermissionLevel
  grantedBy String                  @map("granted_by") @db.Uuid
  createdAt DateTime                @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt DateTime                @updatedAt @map("updated_at") @db.Timestamptz()

  project DbtProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User       @relation("ProjectPermissionUser", fields: [userId], references: [id], onDelete: Cascade)
  granter User       @relation("ProjectPermissionGrantedBy", fields: [grantedBy], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
  @@index([projectId])
  @@map("project_permissions")
}
```

`level` là cột riêng trên **dòng cấp quyền**, không suy ra thuần từ role toàn
cục. Lý do: (a) cho phép admin cấp `view`-only cho một contributor trên đúng
1 project nhạy cảm mà không phải đổi role toàn cục của họ; (b) là chỗ cắm sẵn
cho group ở Phase 2 (§6) mà không phải đổi schema lần nữa.

Quy tắc tính quyền hiệu lực trên 1 project:
```
admin                          -> luôn full (view+edit+delete), bỏ qua bảng trên
contributor + level=edit       -> view + edit + delete
contributor + level=view       -> chỉ view (admin có thể hạ quyền 1 contributor xuống view trên 1 project cụ thể)
viewer      + level bất kỳ     -> chỉ view (viewer không bao giờ edit dù dòng ghi level=edit — role vẫn là trần)
không có dòng                  -> không thấy project (404)
```

### 1.3 Migration Prisma

```
nextjs/prisma/migrations/<ts>_add_rbac/migration.sql
```
```sql
CREATE TYPE user_role AS ENUM ('admin', 'contributor', 'viewer');
ALTER TABLE users ADD COLUMN role user_role NOT NULL DEFAULT 'contributor';

CREATE TYPE project_permission_level AS ENUM ('view', 'edit');
CREATE TABLE project_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES dbt_projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level       project_permission_level NOT NULL,
  granted_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, user_id)
);
CREATE INDEX project_permissions_user_id_idx ON project_permissions(user_id);
CREATE INDEX project_permissions_project_id_idx ON project_permissions(project_id);

-- Backfill: giữ nguyên hành vi hiện tại — mỗi project tự cấp 'edit' cho đúng
-- người đã tạo ra nó. Không ai bỗng dưng thấy thêm project của người khác.
INSERT INTO project_permissions (project_id, user_id, level, granted_by)
SELECT id, created_by, 'edit', created_by
FROM dbt_projects
WHERE deleted_at IS NULL;
```

**Không** đại trà gán `role='admin'` cho user cũ nào — làm vậy sẽ khiến mọi
user hiện có bỗng thấy được project của toàn bộ người khác, tức là **nới
quyền** so với trước khi có RBAC, ngược hoàn toàn tinh thần migration an toàn.
Admin đầu tiên đến từ `RBAC_ADMIN_EMAILS` (§2.3), việc của người triển khai.

## 2. Xác định danh tính & role

### 2.1 dbt-runner (`app/core/auth.py`)

Thêm hàm mới, đặt cạnh `resolve_user_id`/`verify_project_ownership`:

```python
async def get_user_role(session: AsyncSession, user_id: str) -> str:
    result = await session.execute(
        text("SELECT role FROM users WHERE id = CAST(:uid AS uuid)"),
        {"uid": user_id},
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return row[0]


async def authorize_project(
    session: AsyncSession, project_id: str, user_id: str, action: str
) -> None:
    """Raise 404 unless user_id may perform `action` ('view' | 'edit') on project_id.

    404, not 403 — same reasoning as the ownership check it replaces: a 403
    would confirm the project exists to someone who has no business knowing.
    """
    role = await get_user_role(session, user_id)
    if role == "admin":
        return

    result = await session.execute(
        text(
            "SELECT pp.level FROM project_permissions pp "
            "JOIN dbt_projects p ON p.id = pp.project_id "
            "WHERE pp.project_id = CAST(:pid AS uuid) "
            "AND pp.user_id = CAST(:uid AS uuid) "
            "AND p.deleted_at IS NULL"
        ),
        {"pid": project_id, "uid": user_id},
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    level = row[0]
    if action == "edit" and (level != "edit" or role == "viewer"):
        raise HTTPException(status_code=404, detail="Project not found")
```

`verify_project_ownership` **giữ nguyên** để không phá API cũ trong lúc
chuyển đổi, nhưng đánh dấu deprecated và đổi thân hàm thành gọi
`authorize_project(..., action="edit")` — mọi call site cũ tự động được nâng
cấp mà không phải sửa từng nơi ngay lập tức; sửa dần sang gọi thẳng
`authorize_project` với đúng `action` (xem bảng ở §4).

### 2.2 Next.js (`src/lib/authz.ts`, file mới)

```typescript
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/session'

export type ProjectAction = 'view' | 'edit'

export async function requireProjectAccess(
  projectId: string,
  action: ProjectAction,
): Promise<{ userId: string; role: string }> {
  const userId = await getCurrentUserId()
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } })

  if (user.role === 'admin') return { userId, role: user.role }

  const grant = await db.projectPermission.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { level: true },
  })

  const allowed =
    grant && (action === 'view' || (action === 'edit' && grant.level === 'edit' && user.role === 'contributor'))

  if (!allowed) throw new Error('Project not found') // giữ cùng phong cách "không lộ tồn tại" như dbt-runner
  return { userId, role: user.role }
}

export async function requireAdmin(): Promise<string> {
  const userId = await getCurrentUserId()
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } })
  if (user.role !== 'admin') throw new Error('Forbidden')
  return userId
}
```

`getProjects()` (danh sách project ở Home) đổi từ lọc `createdBy: userId`
sang:
```typescript
const userId = await getCurrentUserId()
const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } })
const where =
  user.role === 'admin'
    ? { deletedAt: null }
    : { deletedAt: null, permissions: { some: { userId } } } // 'permissions' = tên relation mới trên DbtProject
```
(Cần thêm relation `permissions ProjectPermission[]` vào `DbtProject` trong
schema, đối xứng với relation đã có trên `ProjectPermission`.)

### 2.3 Bootstrap admin đầu tiên

> **Quyết định (2026-09-22):** chưa cần xây cơ chế tự động — giờ đã có
> DataGrip nối thẳng Postgres (`localhost:5434`), set admin đầu tiên bằng tay
> ngay sau khi chạy migration:
> ```sql
> UPDATE users SET role = 'admin' WHERE email = 'ban@vidu.com';
> ```
> `RBAC_ADMIN_EMAILS` (allowlist tự động qua env, style giống
> `INGEST_FILE_ROOTS`/`LAKE_EXTERNAL_DATA_ROOTS`) để dành cho sau, khi cần
> deploy không có ai rảnh tay chạy SQL mỗi lần setup môi trường mới. Thiết kế
> vẫn giữ nguyên trong `ensureOidcUser`/`ensureLocalUser`
> (`nextjs/src/lib/auth.ts`) để cắm vào không phải đổi gì khác:
> ```typescript
> const ADMIN_EMAILS = new Set(
>   (process.env.RBAC_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
> )
> // trong ensureOidcUser: nếu email khớp -> ép role='admin' lúc upsert.
> // KHÔNG hạ role người đã là admin xuống nếu email bị bỏ khỏi danh sách sau
> // này — hạ quyền phải là thao tác chủ động của admin khác qua UI/SQL, không
> // phải tác dụng phụ của một lần đăng nhập.
> ```

Đưa `token.role` vào JWT/session cùng chỗ đang gán `token.userId` — chỉ để
hiện/ẩn UI, nhắc lại: **không dùng để authorize** bất kỳ mutation nào.

## 3. Phạm vi một quyền "edit project" bao trùm những gì

> **Quyết định (2026-09-22):** Phase 1 đi theo hướng đơn giản nhất — **có
> quyền (view hoặc edit) trên 1 project thì thấy toàn bộ dữ liệu gắn với
> project đó**, không chẻ nhỏ theo từng loại tài nguyên. Tạm thời như vậy,
> sẽ tinh chỉnh chi tiết hơn ở phase sau nếu cần. Ngoại lệ duy nhất giữ lại là
> **git PAT** (xem dòng cuối bảng) vì nó không phải dữ liệu của project mà là
> thông tin đăng nhập cá nhân vào GitHub/GitLab — chia sẻ ra nghĩa là cho
> người khác đẩy code dưới danh nghĩa tài khoản Git của người kia.

| Tài nguyên | Cascade theo quyền project? | Vì sao |
|---|---|---|
| Model/file dbt (`GET/PUT /files`), `dbt run`, git status/commit/push/pull, `dbt_runs`, `dbt_schedules`, `ingest_sources`, `ingest_runs`, `project_targets` | **Có.** `view` → đọc, `edit` → ghi/xoá/chạy. | Nội dung công việc "làm trên project", đúng draft mô tả contributor. |
| `dbt_environment_variables` **giá trị** | **Có.** Ai có quyền view/edit project thì thấy được giá trị biến môi trường của project đó, bất kể ai là `owner` ban đầu. | Theo quyết định trên: đơn giản hoá, không chẻ theo `owner` nữa trong Phase 1. Cột `owner` trên bảng vẫn giữ để biết ai tạo, nhưng không dùng để **ẩn** giá trị với người có quyền project nữa. |
| `connections` (warehouse gắn với project, kể cả mật khẩu) | **Có**, với điều kiện có quyền trên project đang dùng connection đó. | Cùng quyết định trên. Vẫn cần người review `ConnectionDialog.tsx` để biết UI hiện có hiện mật khẩu ra không — nếu có, đây là chỗ rủi ro thật cần cẩn thận khi implement, không chỉ là vấn đề quyền trừu tượng. |
| `ai_providers` / `ai_credentials` | **Ngoài phạm vi RBAC này hoàn toàn**, không đổi. | Theo CLAUDE.md: cấu hình model provider là "per-user config in Settings", không gắn với project nào, key không bao giờ trả về browser. |
| `git_credentials` (PAT) | **Không — ngoại lệ duy nhất.** Luôn riêng theo `(project_id, owner)`, kể cả với admin (admin xem được project nhưng không tự thấy PAT người khác qua UI, chỉ có thể xoá cưỡng bức nếu cần). | PAT là thông tin đăng nhập cá nhân vào dịch vụ Git bên ngoài, không phải dữ liệu do app này sinh ra hay sở hữu. |
| Xoá cứng project (`hardDeleteProject`), khôi phục (`restoreProject`) | **Chỉ admin**, kể cả contributor có `level=edit`. | Xoá cứng là hành động phá huỷ vượt khỏi "sửa nội dung project"; giữ higher bar cho nó. Soft-delete (`softDeleteProject`) thì `edit` đủ quyền. |
| Cấp/thu quyền cho người khác trên chính project đó (`project_permissions` CRUD) | **Chỉ admin.** | Đúng draft: "contributor ... dựa vào project_id mà **admin** thêm vào" — quyền cấp phát không tự động đi kèm quyền edit nội dung. |

Vì `dbt_environment_variables` và (phần nào đó) `git_credentials` vẫn giữ cột
`owner`/scoping theo người tạo ở tầng DB, việc "mở" env var value theo project
chỉ cần **bỏ điều kiện `owner: userId` trong query đọc giá trị**, không cần
đổi schema — dễ thu hẹp lại (revert) ở phase sau nếu quyết định đổi ý, đúng
tinh thần "tạm thời, tính sau".

## 4. Danh sách nơi phải sửa (đã grep, không đoán)

### 4.1 dbt-runner — chuyển từ `verify_project_ownership`/SQL riêng sang `authorize_project(action=...)`

| Router | Số chỗ | Ghi chú |
|---|---|---|
| `routers/files.py` | 14 | GET → `view`, PUT/POST/DELETE/rename/move/copy → `edit` |
| `routers/git.py` | 20 | GET status/log/branches/remotes/diff → `view`; init/clone/commit/push/pull/checkout/exec/add/reset/config/fetch → `edit` |
| `routers/dbt.py` | 14 (+2 raw SQL tại dòng ~260, ~313 — gộp về `authorize_project`) | GET runs/compile → `view`; run/cancel → `edit` |
| `routers/sse.py` | 3 (+1 raw SQL dòng ~267) | Stream file/run đang chạy → `view` |
| `routers/charts.py` | 3 | GET render → `view`; save board → `edit` |
| `routers/ingest.py` | 4 raw SQL (dòng ~142, ~435, ~519, ~880) — **hiện không gọi `verify_project_ownership` chút nào**, tự viết SQL riêng | Chuyển hết sang `authorize_project`; probe/preview → `view`, create/update/delete/run source → `edit` |
| `routers/lake.py` | 1 raw SQL (dòng ~54) | Iceberg publish → `edit` |
| `routers/connection.py` | **0** — không có `Depends(require_user)` nào cả | **Phải thêm auth trước**, xem §4.3 |
| `routers/dremio.py` | 3, tự lọc theo `created_by` của chính `dremio_sources` (không phải qua `dbt_projects`) | Dremio source là tài nguyên **cá nhân** riêng (như `connections`), không nằm trong mô hình project-permission — giữ nguyên logic sở hữu cá nhân, ngoài phạm vi đợt này. |

### 4.2 Next.js — `nextjs/src/lib/actions/data.ts` (30 hàm export)

Tất cả hàm nhận `projectId`/`id` của project hoặc tài nguyên con của project
phải gọi `requireProjectAccess(projectId, action)` thay `createdBy: userId`
trực tiếp trong `where`. Cụ thể theo action:

- `view`: `getProjects`, `getProjectById`, `getRuns`, `getRunById`,
  `getIngestSources`, `getProjectTargets`, `getSchedules`,
  `getRunLogDashboard`, `getAllRunsAcrossProjects` (đổi sang hợp theo quyền
  từng project, không lọc phẳng `createdBy`).
- `edit`: `updateProject`, `softDeleteProject`, `createIngestSource`,
  `updateIngestSource`, `deleteIngestSource`, `createProjectTarget`,
  `updateProjectTarget`, `deleteProjectTarget`, `createSchedule`,
  `updateSchedule`, `deleteSchedule`.
- **Chỉ admin**: `hardDeleteProject`, `restoreProject`, `createProject`
  (tạo mới thì không cần check quyền trên project chưa tồn tại, nhưng nên
  giới hạn **ai được tạo project mới** — xem câu hỏi mở ở §7).
- **Ngoài phạm vi, giữ nguyên `createdBy` cá nhân**: mọi hàm liên quan
  `Connection`, `DremioSource` (`getConnections`, `createConnection`,
  `deleteConnection`, `getConnectionById`, `updateConnection`,
  `getDremioSources`, ...) — đây là tài nguyên cá nhân theo §3, không theo
  quyền project.

`nextjs/src/app/api/projects/[projectId]/env-vars/route.ts`: đổi sang
`requireProjectAccess(projectId, 'view'|'edit')` cho việc **thấy project và
danh sách tên biến**, nhưng **giá trị** biến vẫn lọc thêm `owner: userId` như
hiện tại (§3) — hai lớp lọc chồng nhau, không thay nhau.

### 4.3 Vá trước khi làm RBAC (bug độc lập, phát hiện khi review)

`dbt-runner/app/routers/connection.py` cần thêm
`claims: dict = Depends(require_user)` vào **cả 4** endpoint
(`/connection/test`, `/connection/schema`, `/connection/usage/{id}`,
`/connection/adapters`) trước khi merge phần RBAC này — nếu không, phần còn
lại của công việc chỉ khoá được cửa project/file/git trong khi router
connection vẫn mở toang không cần token.

## 5. Màn quản lý user (frontend)

Theo CLAUDE.md, `/settings` là nơi có ý nghĩa "account/deployment scope,"
đúng bản chất của "quản lý user" hơn là một mục ngang hàng
Home/Develop/Orchestrate/Explore/Data trên sidebar (5 mục đó cố định, đại
diện cho không gian làm việc, không phải chức năng vận hành). Tách UI làm
2 mảnh, không dồn vào 1 dialog mới (đúng nguyên tắc "per-project config thuộc
`ProjectSettingsDialog`, không tạo dialog mới"):

1. **`/settings` → tab "Users" (mới, chỉ admin thấy)** — `AdminUsersCard.tsx`
   cạnh `AssistantProvidersCard.tsx` đã có. Nội dung:
   - Bảng toàn bộ `users` (id, email, name, role, ngày đăng nhập đầu).
   - Đổi role qua dropdown (admin/contributor/viewer) — gọi
     `PATCH /api/admin/users/[id]`.
   - **Giới hạn cần nói rõ ngay trên UI**: danh sách chỉ gồm người **đã từng
     đăng nhập ít nhất 1 lần** (JIT-provisioning) — tạo tài khoản trên
     Keycloak không tự khiến họ xuất hiện ở đây.
2. **`ProjectSettingsDialog.tsx` → tab "Access" (mới, chỉ admin thấy)** —
   danh sách `project_permissions` của đúng project đang mở, thêm/xoá
   user + chọn level (`view`/`edit`). Đây là nơi tự nhiên nhất để "admin thêm
   project_id cho contributor", đúng nguyên văn draft.

API mới, đều tự `requireAdmin()`:
```
GET   /api/admin/users
PATCH /api/admin/users/[id]            { role }
GET   /api/admin/projects/[id]/access
POST  /api/admin/projects/[id]/access  { userId, level }
DELETE /api/admin/projects/[id]/access/[userId]
```

## 6. Phase 2 — Groups (chưa build, chỉ giữ chỗ)

Đúng bullet 13-14 của draft, nhưng **không làm trong đợt này** — 3 role +
per-project grant đã đáp ứng đủ bullet 5-8. Khi cần:

```prisma
model Group {
  id      String @id @default(uuid()) @db.Uuid
  name    String @unique
  members GroupMember[]
  grants  GroupProjectPermission[]
}
model GroupMember {
  groupId String @db.Uuid
  userId  String @db.Uuid
  @@id([groupId, userId])
}
model GroupProjectPermission {
  groupId   String @db.Uuid
  projectId String @db.Uuid
  level     ProjectPermissionLevel
  @@id([groupId, projectId])
}
```
Quyền hiệu lực = `MAX(level)` giữa dòng `project_permissions` trực tiếp và
mọi `GroupProjectPermission` của các group user đó thuộc về. `level` đã tách
riêng trên từng dòng cấp quyền từ Phase 1 (§1.2) chính là để phần này cắm vào
được mà không phải đổi lại schema gốc.

## 7. Câu hỏi còn mở — cần người quyết trước khi code

1. **Ai được tạo project mới?** Draft không nói. Ba lựa chọn: (a) chỉ admin;
   (b) admin + contributor (project mới tự cấp `edit` cho người tạo, giống
   hành vi hiện tại); (c) mọi role kể cả viewer. Đề xuất **(b)** — giữ đúng
   trải nghiệm hiện tại cho contributor, chặn viewer (đúng nghĩa "chỉ xem").
2. **Connection dùng chung nhiều project của nhiều người khác nhau** — §3 để
   ngỏ việc contributor có sửa được mật khẩu connection không nếu không phải
   chủ. Cần xác nhận hành vi hiện tại của `ConnectionDialog.tsx` (mật khẩu có
   hiện lại khi sửa không) trước khi chốt.
3. **`dremio_sources`** có nên đưa vào mô hình project-permission luôn không,
   hay giữ tài nguyên cá nhân như hiện tại? Đề xuất giữ nguyên (out of scope)
   vì đây là legacy path, ít người dùng hơn `connections`.
4. **Role đổi có cần đăng xuất/vào lại không?** Vì role không nhúng trong bất
   kỳ token nào (chỉ tra DB mỗi lần), câu trả lời là **không cần** — có hiệu
   lực ngay ở lần request kế tiếp. Cần xác nhận đây là hành vi mong muốn (tức
   thì) hay nên có độ trễ nào đó vì lý do khác.
