# 02 — Chạy dbt từ Develop

> Tham chiếu: `nextjs/src/lib/hooks/useDbtRunStream.ts`,
> `nextjs/src/lib/dbt-command-args.ts`,
> `dbt-runner/app/routers/{sse,dbt}.py`,
> `dbt-runner/app/services/{dbt_service,dbt_worker,command}.py`.

## 1. Hai đường chạy lệnh

| Đường | Endpoint | Dùng khi | Log |
|---|---|---|---|
| **SSE (mặc định)** | `POST /sse/dbt/{project_id}` | Mọi lệnh từ menu dbt, nút Run, ô terminal | Stream từng dòng |
| HTTP đồng bộ | `POST /dbt/command` | Fallback khi SSE không mở được; `dbt parse` | Trả một lần khi xong |

`handleRunDbt()` luôn thử SSE trước; thất bại thì in
`[WARN] Log stream unavailable, falling back to the HTTP API...` rồi chạy đường HTTP.

### Vòng đời một lệnh SSE

```
handleRunDbt(command)
  ├─ claimCommandSlot()                     ← chặn lệnh thứ hai (mục 4)
  ├─ buildDbtCommandWithArgs(...)           ← ghép extra args + --target
  ├─ dbtRunStream.sendCommand(cmd, ...)
  │     POST /sse/dbt/{id}  body {command, selector, flags, environment_variables}
  │        runner: verify JWT → verify ownership → get_or_sync(project)
  │                → shlex.split → ["dbt", ...] → strip --profiles-dir của client
  │                → gắn --profiles-dir <project_path>
  │                → _regenerate_profiles_from_db()   ← sinh lại profiles.yml
  │                → _build_dbt_environment()         ← biến môi trường
  │                → subprocess dbt, đọc stdout từng dòng
  └─ nhận event: started → output* → completed | error
```

Sự kiện SSE (`DbtRunEvent`):

```ts
{ type: 'started',   command: string }
{ type: 'output',    line: string }
{ type: 'completed', returncode: number }
{ type: 'error',     error: string }
```

### Stream sống ngoài component

`activeStreams: Map<projectId, ActiveStream>` là **module-level**, không phải state React.
Hệ quả có chủ đích:

- Rời khỏi `/develop/[projectId]` **không huỷ** process dbt đang chạy.
- Message nhận được khi IDE không mount được xếp vào `backgroundMessages`
  (trần 5.000 dòng) và phát lại khi quay lại.
- `sendCommand` **abort stream cũ của cùng project** trước khi mở stream mới.

## 2. Ghép câu lệnh

`nextjs/src/lib/dbt-command-args.ts` — một chỗ duy nhất, tất cả lối vào đều đi qua đây.

```ts
buildDbtCommandWithArgs(command, extraArgs, fullRefresh, target)
```

Quy tắc:

1. `--full-refresh` chỉ thêm cho `build | compile | run | show`, và chỉ khi chưa có sẵn.
2. Extra args cũng chỉ áp cho 4 lệnh trên (`COMMANDS_WITH_EXTRA_ARGS`).
3. `--target <name>` được **append ở đúng một chỗ này**. Tên phải khớp
   `/^[a-z][a-z0-9_]{0,29}$/` (cùng shape với `TARGET_NAME_RE` phía runner); sai shape
   thì bị bỏ chứ không gửi đi. Nếu câu lệnh đã có `--target`/`-t` thì không thêm nữa.

> Vì sao gom một chỗ: mỗi lối vào tự append sẽ để sót một đường nào đó chạy trên `dev`
> trong im lặng. Cả dòng echo trong terminal cũng đi qua builder này, nên dòng hiện trên
> màn hình đúng bằng lệnh thực chạy.

Extra args và `--full-refresh` được đặt trong dialog "dbt command args"
(`transforms/Dialogs/index.tsx`), lưu trong `localStorage` theo `{userId}:{projectId}`.

## 3. Menu lệnh (RightPanel)

**Current Model** — `getModelName()` lấy tên file đang mở, bỏ đuôi:

| Mục | Lệnh |
|---|---|
| Run | `run --select <model>` |
| Run + Upstream | `run --select +<model>` |
| Run + Downstream | `run --select <model>+` |
| Test | `test --select <model>` |
| Preview (100 rows) | `show --select <model> --limit 100` |

**Project**: `run`, `build`, `test`, `debug`, `source freshness`, `deps`, `seed`,
`docs generate`, và lối tắt tới Danger zone.

## 4. Chống chạy trùng

Ba lớp, từ trình duyệt vào máy chủ:

1. **`commandInFlightRef`** (`DevelopLayout`) — một `useRef`, không phải state, vì
   state trễ một render còn `Cmd+Enter` giữ phím thì bắn liên tục.
   `claimCommandSlot()` trả `false` và in thông báo thay vì xếp hàng chồng job.
2. **Khoá per-project** — `AsyncFileLock.lock(project_id, "dbt_run", timeout=30)`
   trong `DbtService.run_command`. DuckDB là single-writer.
3. **Semaphore toàn cục** — `global_run_semaphore()`; đầy thì API trả **429**.
   Số slot = `MAX_CONCURRENT_DBT_RUNS`; console query dùng semaphore riêng.

Thêm: `run_command` **retry tối đa 3 lần** (giãn 2s) khi stderr/stdout chứa
`Conflicting lock` — đây là lỗi khoá DuckDB, không phải lỗi model.

**Huỷ lệnh**: nút Stop → `CommandService.cancel(project_id)`; process được `terminate()`,
sau 5s không thoát thì `kill()`. Lệnh bị huỷ trả `returncode = -1`.

### Warm worker

`services/dbt_worker.py` giữ sẵn tiến trình dbt "ấm" cho mỗi project để bỏ chi phí khởi động.
Pool được thu hồi **idle trước, rồi LRU**, không bao giờ cắt ngang một job đang chạy.
Vì worker giữ file `.duckdb`, mọi thao tác cần ghi đè profile phải `release_project()` trước.

## 5. Preview / Compile / Explain

Ba lệnh này **không** đi SSE — chúng gọi HTTP và trả kết quả có cấu trúc.

### Preview — `POST /dbt/preview`

`handlePreviewModel` → `ensureSavedSqlFile()` → `dbtApi.preview(projectId, path, 100, extraArgs, env, target)`.

Runner chạy `dbt show --select <model> --limit N`, parse bảng stdout thành
`{ data, columns, column_types, row_count, execution_time }`. Kiểu cột lấy thêm từ
catalog khi có. Hiển thị ở tab **Results → results**.

### Compile — `POST /dbt/compile`

Body nhận `model_path` (không phải tên model). Trả `compiled_sql` — Jinja đã render.
Hiển thị ở tab **Compiled**. Thành công thì refresh IntelliSense.

### Explain — `POST /dbt/explain`

`DbtService.explain_model` chạy hai bước:

1. Compile model (dùng lại `compile_model`), lấy `compiled_sql`.
2. Chạy `EXPLAIN` **ước lượng** qua `dbt show --inline` với SQL đã compile.
   Dremio có nhánh riêng qua REST (`_try_dremio_rest_explain`).

Trả `{ adapter, model, mode: "Estimated", plan, signals, compiled_sql, execution_time }`.
`signals` là các cảnh báo rút từ plan (`_detect_explain_signals`). Hiển thị ở tab
**Results → plan**. `mode` luôn là `Estimated` — đây là plan trước khi chạy, không phải
số đo thực tế.

SQL inline được lọc bằng `_is_allowed_inline_sql()` trước khi gửi.

## 6. Lineage — `POST /dbt/lineage`

`app/lineage.py`:

- **Lineage bảng** đọc từ `target/manifest.json`: `depends_on` cho upstream,
  `child_map` cho downstream. Mỗi node mang `position: upstream | current | downstream`.
- **Lineage cột** dùng `sqlglot.lineage` trên compiled SQL, đi tới lá để lấy cột nguồn.
  `sqlglot` là import có điều kiện (`SQLGLOT_AVAILABLE`) — thiếu thì chỉ mất phần cột.

Cần `manifest.json`, tức là project phải `parse`/`compile` ít nhất một lần.

## 7. Docs

| Hành động | Đường đi |
|---|---|
| Generate Docs | `POST /dbt/docs/generate` → `dbt docs generate --profiles-dir <path>` (kèm `--target`) |
| View Docs | Generate xong → mở tab mới tới `/api/dbt-docs/view/{projectId}` |

`docs generate` đọc catalog của warehouse, nên nó tài liệu hoá đúng target đang chọn.
Runner còn có `docs/serve|stop|status|list` (cấp port động, kiểm tra `catalog.json` tồn tại)
nhưng UI Develop dùng đường `view` tĩnh.

## 8. Biến môi trường khi chạy

`DbtService._build_dbt_environment` hợp nhất ba nguồn, **sau đè trước**:

```
sanitize_dbt_environment(request_environment)   ← client gửi (đã lọc tên)
  ← dbt_environment_variables của user           ← giải mã từ DB
  ← profile_env                                  ← secret do _regenerate_profiles sinh ra
```

Biến của profile luôn thắng, nên không ai ghi đè được credential của warehouse bằng
một biến gửi từ trình duyệt. Xem [03 — Cấu hình project](./03-cau-hinh-project.md).

## 9. Lịch sử run

Mỗi lệnh (cả SSE lẫn HTTP) ghi một dòng `dbt_runs`:
`_insert_run_start` khi bắt đầu, `_update_run_complete` khi xong — kèm logs, số model
total/success/error (đọc từ `target/run_results.json`, so `mtime` để chắc chắn là file mới),
và `dbt_run_artifacts` cho từng node.

Với SSE, việc ghi nằm trong `_SseRunPersistence` với cờ `persisted` — **ghi đúng một lần**
dù stream kết thúc bình thường, lỗi, hay bị abort.

API đọc: `GET /dbt/runs`, `/dbt/runs/{id}`, `/dbt/runs/{id}/logs`, `/dbt/runs/{id}/artifacts`.
