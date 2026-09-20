# 05 — API reference (phạm vi Develop)

> Base URL runner: `getDbtRunnerUrl()` (`nextjs/src/lib/api/client.ts`).
> Mọi endpoint runner yêu cầu `Authorization: Bearer <accessToken>` và tự kiểm tra
> quyền sở hữu project (`_verify_project_ownership`).
> Client tương ứng: `nextjs/src/lib/api/{dbt,files,git,env-vars}.ts`.

## 1. Chạy lệnh & stream

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| POST | `/sse/dbt/{project_id}` | `{command, selector?, flags?, environment_variables?}` | `text/event-stream`, mỗi dòng `data: {type,…}` |
| GET | `/sse/files/{project_id}` | — | `text/event-stream` sự kiện file |
| GET | `/sse/dbt-runs/{run_id}/events` | — | stream sự kiện của một run đã lưu |
| POST | `/dbt/command` | `DbtCommand` | `{success, command, stdout, stderr, returncode, run_id}` |
| POST | `/dbt/runs` | `DbtCommand` | **202** `{run_id, status, started_at}` (chạy nền) |
| POST | `/dbt/runs/{run_id}/cancel` | — | `{success}` |

`DbtCommand`: `{project_id, command, selector?, target?, flags?, environment_variables?}`.

### Sự kiện SSE của `/sse/dbt/{project_id}`

```json
{"type":"started","command":"dbt run --select dim_customer --target dev"}
{"type":"output","line":"12:01:02  1 of 1 OK created sql table model ..."}
{"type":"completed","returncode":0}
{"type":"error","error":"..."}
```

## 2. Model: compile / preview / explain / lineage

| Method | Path | Body | Trả về |
|---|---|---|---|
| POST | `/dbt/compile` | `{project_id, model_path, additional_args?, environment_variables?, target?}` | `{success, compiled_sql, error?}` |
| POST | `/dbt/preview` | `+ {limit: 1..1000 = 100}` | `{success, data[], columns[], column_types, row_count, execution_time}` |
| POST | `/dbt/explain` | như compile | `{success, adapter, model, mode:"Estimated", plan, signals[], compiled_sql, execution_time, stage?}` |
| POST | `/dbt/lineage` | `{project_id, model_path}` | `{success, table_lineage:{nodes[],edges[]}, column_lineage{}}` |
| POST | `/dbt/query` | `{project_id, sql, limit, target?, environment_variables?}` | Chạy một `SELECT` read-only qua `dbt show --inline` |
| POST | `/dbt/format` | `{sql, dialect?}` | `{formatted: bool, sql, reason?}` — sqlglot, **từ chối** thay vì đoán |

Chú ý: các endpoint này nhận **`model_path`** (đường dẫn file trong project),
không phải tên model.

## 3. Metadata & docs

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/dbt/intellisense/{project_id}` | Chuẩn hoá `manifest.json` + `catalog.json`. `status`: bình thường / `missing_manifest` / `parse_error` |
| POST | `/dbt/docs/generate` | `{project_id, select?, target?}` |
| POST | `/dbt/docs/serve` | `{project_id, port?}` — cấp port động, yêu cầu có `catalog.json` |
| POST | `/dbt/docs/stop?project_id=` | |
| GET | `/dbt/docs/status?project_id=` | |
| GET | `/dbt/docs/list` | Mọi docs server đang chạy |
| GET | `/dbt/docs/view/{project_id}` | HTML tĩnh; frontend proxy qua `/api/dbt-docs/view/{projectId}` |

## 4. Profile & chẩn đoán kết nối

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/dbt/regenerate-profiles/{project_id}` | Ép sinh lại `profiles.yml` từ DB |
| GET | `/dbt/check-connection/{project_id}` | 3 điều kiện + preview `profiles.yml` (password đã redact) |
| GET | `/dbt/check-target/{project_id}?target=` | Kết nối thật tới warehouse của đúng target đó |
| POST | `/dbt/init` | `{project_id, project_name}` |

## 5. File

Tất cả nhận đường dẫn **tương đối** so với gốc project; runner kiểm tra bằng
`ProjectService.validate_subpath()`.

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/files/{project_id}?path=` | Trả **một cấp** thư mục |
| GET | `/files/{project_id}/search?query=` | Tìm toàn project |
| GET | `/files/{project_id}/content?path=` | Đọc file |
| POST | `/files/{project_id}/content` | `{path, content}` — lưu (đường dùng bởi IDE) |
| PUT | `/files/{project_id}/content` | Ghi file |
| POST | `/files/{project_id}/create` | `{path, file_type: file\|directory, content}` |
| DELETE | `/files/{project_id}?path=` | |
| PUT | `/files/{project_id}/rename?old_path=&new_path=` | |
| POST | `/files/{project_id}/move?source_path=&dest_path=` | Từ chối move một thư mục vào chính nó |
| POST | `/files/{project_id}/copy?source_path=&dest_path=` | |
| POST | `/files/{project_id}/duplicate?path=` | |
| GET | `/files/{project_id}/status` | |

File mới được tạo với nội dung mặc định theo đuôi (`_get_default_content`), ví dụ `.py`
ra sẵn khung `def model(dbt, session)`.

## 6. Git

| Method | Path | Body |
|---|---|---|
| POST | `/git/clone` | `{project_id, git_url, branch, username?, token?}` |
| POST | `/git/pull` \| `/git/push` | `{project_id, username?, token?}` |
| POST | `/git/commit` | `{project_id, message, stage_all?}` — author lấy từ OIDC claims |
| POST | `/git/add` \| `/git/reset` | `{project_id, paths?}` |
| POST | `/git/exec` | `{project_id, command}` — chặn `config --global/--system/--file` |
| POST | `/git/checkout` \| `/git/init` \| `/git/remote/add` \| `/git/config` | |
| GET | `/git/status/{id}` \| `/log/{id}` \| `/branches/{id}` \| `/remotes/{id}` \| `/config/{id}` \| `/diff/{id}` | |
| POST | `/git/fetch/{project_id}` | |

## 7. Project

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/project/delete` | `{project_id, hard_delete}` — xoá file |
| POST | `/project/restore` | Kéo lại từ storage |
| POST | `/project/sync/{project_id}` | Đồng bộ file từ storage về workspace |

## 8. Route Next.js dùng bởi Develop

| Path | Ghi chú |
|---|---|
| `GET\|POST /api/projects` | Danh sách / tạo project (Prisma) |
| `GET\|POST\|PATCH\|DELETE /api/targets?projectId=` | `project_targets` |
| `GET\|PUT /api/projects/{projectId}/env-vars` | PUT là replace toàn bộ; giá trị không bao giờ trả về |
| `GET /api/connections` | Danh sách connection để chọn warehouse/target |
| `GET /api/dbt-docs/view/{projectId}` | Proxy docs HTML |
| `GET /api/dbt-docs/static/{projectId}/{...filePath}` | Asset của docs |
| `POST /api/agent/...` | Proxy tới dsh-agent (chỉ khi `AGENT_URL` được đặt) |

## 9. Mã lỗi thường gặp

| Mã | Ý nghĩa trong Develop |
|---|---|
| 401 | JWT thiếu/hết hạn |
| 403 / 404 | Project không thuộc về user (`_verify_project_ownership`) |
| 429 | Hết slot `global_run_semaphore` — có quá nhiều dbt run đồng thời |
| 400 | Target sai shape, thiếu email trong claims khi commit, body không hợp lệ |
| 500 | `DbtOperationError` — thường là không render được `profiles.yml` |
