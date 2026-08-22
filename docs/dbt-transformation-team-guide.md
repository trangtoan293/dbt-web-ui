# Team Guide: Transformation với dbt theo kiến trúc Bronze–Silver–Gold

> Trạng thái: chuẩn làm việc đề xuất cho toàn team
>
> Phạm vi: các dbt project được phát triển và chạy qua dbt Web UI hoặc CLI
>
> Phiên bản tham chiếu: `dbt-core 1.10.x`
>
> Nguồn tổng hợp chính: [dbt Guide (bản lưu)](./dbt_guide_ultimate/dbt%20Guide.html)

## 1. Mục tiêu

Guide này quy định cách team xây dựng, kiểm thử, review và vận hành tầng
transformation bằng dbt. Mục tiêu là để mỗi dataset được tạo ra có:

- một định nghĩa business rõ ràng;
- lineage truy vết được từ nguồn đến bảng phục vụ người dùng;
- chất lượng dữ liệu được kiểm tra tự động;
- lịch sử thay đổi nằm trong Git và đi qua review;
- thời gian chạy và chi phí có thể kiểm soát;
- cách phát triển giống nhau trên local, CI và production.

Guide không quy định cách ingest dữ liệu. Ingestion chịu trách nhiệm đưa dữ liệu
gốc vào warehouse/lakehouse. dbt bắt đầu từ khi dữ liệu gốc đã có thể được khai
báo bằng `source()`.

## 2. Chuẩn bắt buộc — bản ngắn

Mọi thay đổi transformation phải tuân theo các nguyên tắc sau:

1. Không đọc bảng vật lý bằng tên hard-code trong model. Bảng thuộc Source layer dùng
   `source()`, model dbt dùng `ref()`.
2. Luồng chuẩn là `source → bronze → silver → gold`.
3. Chỉ model Bronze được gọi `source()`; một source table chỉ có một Bronze model
   chính. Snapshot là ngoại lệ được kiểm soát vì cần đọc trực tiếp từ source.
4. Bronze chỉ rename, cast, chuẩn hóa kỹ thuật và deduplicate khi thật sự cần;
   không join và không chứa business logic.
5. Mỗi model phải khai báo grain, owner, mô tả và test phù hợp.
6. Model public trong Gold phải có primary key logic được test `not_null` và
   `unique`, hoặc test uniqueness trên tổ hợp cột đúng với grain.
7. Dùng `dbt build` làm cổng kiểm tra chính trước khi merge.
8. Không chạy local/CI vào schema production. Mỗi developer hoặc branch phải có
   target schema riêng.
9. Chỉ dùng incremental khi chứng minh được tính đúng đắn, idempotency và lợi ích
   hiệu năng. `--full-refresh` trên production cần được phê duyệt.
10. Không tăng tài nguyên warehouse trước khi kiểm tra filter, join, fan-out, số
    cột, materialization và query plan.
11. Không đưa secret, PII mẫu hoặc dữ liệu production vào Git, seed, log hay ảnh
    chụp màn hình của merge request.
12. Xóa file model không đồng nghĩa bảng/view production tự biến mất; phải có kế
    hoạch deprecation và drop riêng.

Một model được xem là **Done** khi SQL chạy đúng, test pass, documentation đầy
đủ, downstream impact đã được đánh giá và reviewer hiểu được grain lẫn business
rule của model.

## 3. Kiến trúc transformation chuẩn

```text
Source layer         ingested data + source declarations
      │  source()
      ▼
Bronze models        brz_<source>__<entity>
      │  ref()
      ▼
Silver models        slv_<domain>__<verb_or_concept>
      │  ref()
      ▼
Gold models          dim_*, fct_*, mart_*
      │
      ├── BI / dashboard
      ├── data product / API
      └── downstream analytics
```

Snapshot là một nhánh đặc biệt của Bronze: snapshot đọc trực tiếp từ Source để
ghi nhận lịch sử thay đổi dạng SCD Type 2. Model phục vụ phân tích vẫn phải được
xây dựng ở Silver/Gold phía trên snapshot thay vì cho người dùng query snapshot
thô.

### 3.1 Trách nhiệm của từng layer

| Layer | Trách nhiệm | Được phép | Không được phép | Materialization mặc định |
|---|---|---|---|---|
| Source | Dữ liệu do ingestion tạo và được khai báo bằng `source()` | Giữ nguyên dữ liệu nguồn cùng metadata tải | Business logic bằng dbt | Ngoài phạm vi dbt transformation |
| Bronze | Chuẩn hóa kỹ thuật từng source table và giữ nguyên grain nguồn | Rename, cast, chuẩn hóa null/boolean/timezone, deduplicate có giải thích | Join, aggregate, metric, filter theo business | `view` |
| Silver | Dữ liệu đã làm sạch và conformed, chứa logic business tái sử dụng | Join, filter hợp lệ, pivot, union, deduplicate business, aggregate trung gian | Là interface public ổn định cho BI | `view`; `table` nếu có lý do hiệu năng |
| Gold | Dữ liệu public theo domain và use case đã cam kết | Fact, dimension, mart/report, metric đã thống nhất | Phụ thuộc trực tiếp vào Source/Bronze | `table`; `incremental` khi đủ điều kiện |

Dependency giữa các layer là một chiều:

- Bronze dùng `source()` và không phụ thuộc model Silver/Gold.
- Silver dùng `ref()` tới Bronze hoặc Silver; không gọi `source()` trực tiếp.
- Gold dùng `ref()` tới Silver hoặc model Gold dùng chung; không gọi trực tiếp
  Source/Bronze.
- Chỉ Gold là interface public cho BI và các data consumer.

### 3.2 Tổ chức project

```text
dbt_project.yml
packages.yml
models/
  bronze/
    crm/
      _crm__sources.yml
      _crm__models.yml
      brz_crm__customers.sql
      brz_crm__orders.sql
    billing/
      _billing__sources.yml
      _billing__models.yml
      brz_billing__invoices.sql
  silver/
    customers/
      _customers__silver.yml
      slv_customers__order_metrics.sql
    orders/
      _orders__silver.yml
      slv_orders__current.sql
  gold/
    customers/
      _customers__models.yml
      dim_customers.sql
      fct_orders.sql
    finance/
      _finance__models.yml
      fct_invoices.sql
      mart_monthly_revenue.sql
snapshots/
  crm/
    crm_customers_snapshot.sql
seeds/
  country_codes.csv
macros/
  generate_schema_name.sql
  dates/
tests/
  assert_order_total_is_non_negative.sql
selectors.yml
```

Thư mục Gold được chia theo business domain, không chia theo dashboard hoặc
theo tên analyst. Logic dùng riêng tạm thời cho một phân tích nên ở branch hoặc
workspace/sandbox có thời hạn; không được âm thầm trở thành nguồn production.

### 3.3 Cấu hình khởi đầu

```yaml
# dbt_project.yml
name: team_analytics
version: 1.0.0
config-version: 2
profile: team_analytics

model-paths: ["models"]
snapshot-paths: ["snapshots"]
seed-paths: ["seeds"]
test-paths: ["tests"]
macro-paths: ["macros"]

models:
  team_analytics:
    bronze:
      +materialized: view
      +schema: bronze
      +tags: ["bronze"]
    silver:
      +materialized: view
      +schema: silver
      +tags: ["silver"]
    gold:
      +materialized: table
      +schema: gold
      +tags: ["gold"]
```

Chỉ đưa config lên `dbt_project.yml` khi nó là mặc định hợp lý cho đa số model
trong thư mục. Ngoại lệ của một vài model nên đặt cạnh model hoặc trong file
properties YAML để tránh tạo hành vi ngầm khó thấy.

## 4. Quy tắc modeling

### 4.1 Khai báo source

Mỗi hệ thống nguồn có một file source riêng. Tên dbt phải dễ hiểu; dùng
`identifier` để ánh xạ tên bảng vật lý xấu hoặc khó đọc.

```yaml
# models/bronze/crm/_crm__sources.yml
version: 2

sources:
  - name: crm
    description: Dữ liệu CRM do ingestion đồng bộ.
    schema: raw_crm
    config:
      loaded_at_field: _ingested_at
      freshness:
        warn_after: {count: 2, period: hour}
        error_after: {count: 6, period: hour}
    tables:
      - name: customers
        identifier: crm_customer_v2
        description: Một dòng cho trạng thái hiện tại của một khách hàng.
        columns:
          - name: id
            data_tests:
              - not_null
              - unique
      - name: orders
        description: Đơn hàng từ CRM.
```

Quy tắc source:

- khai báo owner, mô tả, freshness và khóa nguồn nếu thông tin có sẵn;
- dùng tên logic ổn định; thay đổi tên bảng vật lý chỉ sửa `identifier`;
- không để BI, Silver hoặc Gold đọc Source trực tiếp; chỉ Bronze và snapshot được
  phép;
- test source chỉ kiểm tra cam kết thực sự của nguồn, không áp business rule mà
  hệ thống nguồn không bảo đảm;
- nếu adapter không hỗ trợ một freshness feature, ghi rõ cách giám sát thay thế.

### 4.2 Bronze model

Một Bronze model tương ứng với một source table và là nơi duy nhất trong tầng
model đọc source table đó. Tên chuẩn là `brz_<source>__<entity>`.

```sql
-- models/bronze/crm/brz_crm__customers.sql
with source as (

    select *
    from {{ source('crm', 'customers') }}

),

renamed as (

    select
        cast(id as bigint) as customer_id,
        nullif(trim(name), '') as customer_name,
        lower(trim(email)) as customer_email,
        cast(created_at as timestamp) as created_at,
        cast(updated_at as timestamp) as updated_at,

        -- ingestion metadata
        cast(_ingested_at as timestamp) as _ingested_at
    from source

)

select *
from renamed
```

Bronze được phép:

- đổi tên cột sang tên dễ hiểu, dùng đầy đủ từ;
- cast kiểu dữ liệu tường minh;
- chuẩn hóa timezone, boolean, chuỗi rỗng/null và reserved words;
- tạo surrogate key kỹ thuật nếu nguồn thật sự không có khóa ổn định;
- deduplicate do đặc tính ingestion, nhưng phải mô tả tiêu chí chọn bản ghi.

Bronze không được:

- join với bảng khác;
- bỏ record vì một business condition;
- tính KPI, status business hay aggregate;
- làm thay đổi grain của bảng nguồn;
- che giấu data-quality issue bằng `distinct` không có giải thích.

Sắp xếp cột theo nhóm: primary key và thuộc tính chính, foreign key, thuộc tính
business, timestamp, ingestion metadata. Trong mỗi nhóm, giữ thứ tự ổn định để
diff dễ review.

### 4.3 Silver model

Silver chứa dữ liệu đã làm sạch/conformed và các bước business logic có thể đọc,
test, tái sử dụng. Tên phải diễn tả hành động hoặc khái niệm, ví dụ
`slv_customers__order_metrics`, không dùng `temp_1`, `final_final`.

```sql
-- models/silver/orders/slv_orders__current.sql
with orders as (

    select *
    from {{ ref('brz_crm__orders') }}

),

conformed as (

    select
        order_id,
        customer_id,
        case
            when order_status in ('complete', 'completed') then 'paid'
            else order_status
        end as order_status,
        order_amount,
        ordered_at,
        updated_at
    from orders

)

select *
from conformed
```

Silver model khác có thể tái sử dụng dataset đã conformed này:

```sql
-- models/silver/customers/slv_customers__order_metrics.sql
with orders as (

    select *
    from {{ ref('slv_orders__current') }}

),

order_metrics as (

    select
        customer_id,
        count(*) as lifetime_order_count,
        sum(order_amount) as lifetime_order_amount,
        min(ordered_at) as first_ordered_at,
        max(ordered_at) as last_ordered_at
    from orders
    where order_status <> 'cancelled'
    group by customer_id

)

select *
from order_metrics
```

Tách model khi bước logic có tên business riêng, được dùng lại, cần test riêng,
hoặc một query đã khó hiểu trong một lần đọc. Không tách thành nhiều model chỉ
để mỗi file có một CTE.

Silver mặc định là `view` để layer hiện hữu và có thể được kiểm tra độc lập.
`ephemeral` chỉ phù hợp với helper rất nhẹ, ít consumer và không được xem là một
dataset Silver ổn định. Nếu một Silver model được dùng rộng rãi hoặc làm query
downstream chậm đáng kể, chuyển sang `table` dựa trên số đo thay vì cảm tính.

### 4.4 Gold: fact, dimension và mart tổng hợp

Gold là interface dữ liệu được cam kết với người dùng.

- `dim_<entity>`: một dòng cho mỗi thực thể tại grain đã công bố, ví dụ một dòng
  mỗi khách hàng.
- `fct_<event>`: một dòng cho mỗi sự kiện/giao dịch, ví dụ một dòng mỗi order
  line.
- `mart_<subject>`: dataset tổng hợp phục vụ một subject area ổn định, không gắn
  chặt với layout của một dashboard.

Trước khi viết SQL, tác giả phải trả lời được:

1. Grain chính xác là gì?
2. Primary key logic là cột nào hoặc tổ hợp cột nào?
3. Measure nào có thể cộng được, và cộng theo dimension nào?
4. Record bị loại theo rule nào?
5. Khi dữ liệu nguồn đến trễ hoặc cập nhật quá khứ thì model phản ứng thế nào?
6. Ai sở hữu định nghĩa business và ai là consumer chính?

Không join hai bảng khi chưa xác định cardinality. Với quan hệ one-to-many, phải
aggregate phía many về đúng grain hoặc chấp nhận và test grain mới. `select
distinct` không phải cách sửa fan-out.

## 5. Naming và SQL style

### 5.1 Naming

| Thành phần | Quy tắc | Ví dụ |
|---|---|---|
| Source | tên hệ thống ngắn, ổn định | `crm`, `billing` |
| Bronze | `brz_<source>__<entity>` | `brz_crm__customers` |
| Silver | `slv_<domain>__<verb_or_concept>` | `slv_orders__allocated_discount` |
| Dimension | `dim_<plural_entity>` | `dim_customers` |
| Fact | `fct_<plural_event>` | `fct_order_lines` |
| Mart | `mart_<subject>` | `mart_monthly_revenue` |
| Snapshot | `<source>_<entity>_snapshot` | `crm_customers_snapshot` |
| Primary key | `<entity>_id` | `customer_id` |
| Boolean | `is_`, `has_`, `can_` | `is_active` |
| Timestamp | `_at` | `created_at` |
| Date | `_date` | `order_date` |
| Count | `_count` | `order_count` |
| Amount | kèm đơn vị/currency khi dễ mơ hồ | `net_amount_usd` |

Tên file model phải trùng tên model. Tên macro phải trùng tên file macro. Tránh
viết tắt nội bộ nếu một người mới không thể đoán được nghĩa.

### 5.2 SQL

- Đặt các CTE chứa `source()` và `ref()` ở đầu file như phần import.
- Mỗi CTE làm một việc và có tên diễn tả kết quả, không dùng `a`, `b`, `tmp`.
- Chọn cột tường minh ở output public; không dùng `select *` trong Gold.
- Filter càng sớm càng tốt khi không thay đổi ngữ nghĩa.
- Không lặp business rule; trích ra Silver model hoặc macro khi thật sự tái sử
  dụng.
- Ưu tiên SQL dễ đọc trước SQL ngắn.
- Comment giải thích **tại sao**, edge case và assumption; không mô tả lại câu
  lệnh SQL.
- Dùng formatter/linter thống nhất trong CI. SQLFluff là lựa chọn khuyến nghị nếu
  project chưa có linter.

Repo hỗ trợ nhiều adapter, vì vậy core models nên ưu tiên ANSI SQL và
`cast(... as ...)`. Các cú pháp như `::`, `qualify`, `ilike`, hàm JSON/date hoặc
incremental strategy có thể khác giữa PostgreSQL, DuckDB, Dremio, Oracle và
Spark. Logic phụ thuộc engine phải được:

1. cô lập trong macro có `adapter.dispatch`, hoặc
2. đặt trong project/folder chuyên cho adapter và được test trên adapter đó.

Không copy cùng một business rule thành nhiều phiên bản SQL nếu có thể giải
quyết bằng macro portable.

## 6. Documentation, contract và metadata

Mỗi model phải có:

- `description` bắt đầu bằng grain rồi đến mục đích;
- owner/domain trong `meta`;
- mô tả cho primary key, foreign key, measure và cột dễ hiểu sai;
- test cho các invariant;
- tags phục vụ selection và vận hành.

```yaml
# models/gold/customers/_customers__models.yml
version: 2

models:
  - name: dim_customers
    description: >
      Một dòng cho mỗi customer_id. Dimension khách hàng hiện tại, dùng chung
      cho reporting bán hàng và chăm sóc khách hàng.
    config:
      contract:
        enforced: true
    meta:
      owner: data-platform
      domain: customers
      contains_pii: true
    columns:
      - name: customer_id
        description: Khóa ổn định của khách hàng từ CRM.
        data_type: bigint
        data_tests:
          - not_null
          - unique
      - name: customer_name
        description: Tên hiển thị hiện tại của khách hàng.
        data_type: varchar
      - name: lifetime_order_count
        description: Số order không bị hủy trong toàn bộ lịch sử đã tải.
        data_type: bigint
        data_tests:
          - not_null
      - name: first_ordered_at
        description: Thời điểm order không bị hủy đầu tiên.
        data_type: timestamp
```

Kiểu dữ liệu contract phải khớp adapter đang chạy; ví dụ trên cần được điều
chỉnh nếu warehouse dùng tên type khác. Bắt buộc contract cho model public quan
trọng. Với project cũ, rollout contract theo từng domain thay vì bật đồng loạt
khi chưa khai báo data type.

Chạy và publish dbt docs sau khi merge. Documentation là một phần của interface,
không phải công việc bổ sung làm sau.

## 7. Chiến lược test và data quality

Test phải bảo vệ assumption và business contract, không chạy cho đủ số lượng.

### 7.1 Mức test tối thiểu

| Loại model | Test tối thiểu |
|---|---|
| Source | freshness nếu có timestamp tải; khóa nguồn `not_null`/`unique` nếu nguồn cam kết |
| Bronze | primary key, accepted values quan trọng, dedup invariant |
| Silver | grain sau join/aggregate và business rule dễ sai |
| Gold | primary key hoặc composite grain, foreign-key relationships, required fields, accepted values, business-rule tests |
| Incremental | uniqueness sau merge, cập nhật record cũ, late-arriving data, chạy lặp không tạo duplicate |
| Snapshot | một current row cho mỗi key, khoảng hiệu lực hợp lệ, không overlap |

Ví dụ relationships và accepted values:

```yaml
version: 2

models:
  - name: fct_orders
    columns:
      - name: order_id
        data_tests:
          - not_null
          - unique
      - name: customer_id
        data_tests:
          - not_null
          - relationships:
              arguments:
                to: ref('dim_customers')
                field: customer_id
      - name: order_status
        data_tests:
          - accepted_values:
              arguments:
                values: ["pending", "paid", "cancelled", "refunded"]
```

Singular data test phải trả về **các dòng vi phạm**; không có dòng trả về nghĩa
là pass.

```sql
-- tests/assert_order_total_is_non_negative.sql
select
    order_id,
    order_total
from {{ ref('fct_orders') }}
where order_total < 0
```

Phân loại test:

- `error`: vi phạm có thể làm sai dataset hoặc quyết định business;
- `warn`: dấu hiệu cần theo dõi nhưng chưa đủ để chặn pipeline, ví dụ volume dao
  động trong biên kiểm soát;
- unit test: logic phức tạp với input/output nhỏ, đặc biệt CASE, allocation,
  date boundary và incremental logic;
- golden-data test: chỉ dùng cho một số record/KPI bất biến thật sự quan trọng;
  không biến toàn bộ production data thành fixture.

Không bỏ qua test fail. Trước review, phải sửa hoặc ghi rõ nguyên nhân, owner và
thời hạn xử lý. Test flaky cần được sửa; không mặc định hạ từ error xuống warn.

## 8. Materialization

Chọn materialization theo hành vi và số đo thực tế:

| Loại | Dùng khi | Tránh khi |
|---|---|---|
| `view` | Bronze/Silver, logic nhẹ, cần dữ liệu luôn mới | Query downstream phải lặp logic nặng |
| `ephemeral` | Helper Silver nhỏ, ít consumer, giúp SQL dễ đọc | Dataset Silver ổn định hoặc nhiều downstream làm compiled SQL phình lớn |
| `table` | Gold hoặc logic nặng cần compute một lần | Bảng rất lớn nhưng mỗi run chỉ đổi ít record |
| `incremental` | Dataset lớn, run chậm, phần lớn lịch sử không đổi và có watermark/key đáng tin | Current-state thay đổi rộng, không có cách nhận biết update, logic thường xuyên backfill |

Mặc định bắt đầu đơn giản với `view` ở Bronze/Silver và `table` ở Gold. Chỉ chuyển
materialization sau khi có bằng chứng từ runtime, query plan, số dòng/bytes và
hành vi cập nhật của nguồn.

### 8.1 Incremental model

Một incremental model production phải có:

- `unique_key` phù hợp với grain;
- điều kiện `is_incremental()` dựa trên cột update đáng tin;
- quy tắc xử lý late-arriving records;
- `on_schema_change` tường minh;
- test idempotency: chạy lại cùng input không đổi kết quả;
- test update: record cũ thay đổi được cập nhật đúng;
- runbook full refresh/backfill và ước lượng chi phí.

```sql
-- models/gold/customers/fct_orders.sql
{{
    config(
        materialized='incremental',
        unique_key='order_id',
        on_schema_change='fail'
    )
}}

with orders as (

    select
        order_id,
        customer_id,
        order_status,
        order_amount,
        ordered_at,
        updated_at
    from {{ ref('slv_orders__current') }}

    {% if is_incremental() %}
    where updated_at >= (
        select coalesce(max(updated_at), cast('1900-01-01' as timestamp))
        from {{ this }}
    )
    {% endif %}

)

select
    order_id,
    customer_id,
    order_status,
    order_amount,
    ordered_at,
    updated_at
from orders
```

Ví dụ dùng `>=` để không bỏ sót record cùng watermark; `unique_key` chịu trách
nhiệm merge lại record. Với nguồn có thể đến trễ, dùng lookback window đã đo
được và cô lập hàm date theo adapter. Nếu nguồn sửa dữ liệu cũ mà không cập nhật
watermark, model này không an toàn để incremental.

Không dùng incremental chỉ vì table “có vẻ lớn”. Độ phức tạp vận hành là một
chi phí thật. Model current-state thường xuyên thay đổi trên toàn bảng thường phù
hợp với table rebuild hơn.

## 9. Snapshot và dữ liệu lịch sử

Snapshot dbt là bảng SCD Type 2 ghi lại phiên bản của record mutable theo thời
gian. Mỗi source table có một snapshot table chứa toàn bộ lịch sử, không phải một
bảng mới cho mỗi ngày.

```sql
-- snapshots/crm/crm_customers_snapshot.sql
{% snapshot crm_customers_snapshot %}

    {{
        config(
            target_schema='bronze',
            unique_key='id',
            strategy='timestamp',
            updated_at='updated_at'
        )
    }}

    select *
    from {{ source('crm', 'customers') }}

{% endsnapshot %}
```

Quy tắc snapshot:

- đọc trực tiếp từ `source()`, không snapshot model business downstream;
- quản trị output snapshot như lịch sử kỹ thuật của Bronze; Silver đọc snapshot
  bằng `ref()` và chuẩn hóa semantics trước khi Gold sử dụng;
- ưu tiên `timestamp` nếu có `updated_at` đáng tin; chỉ dùng `check` khi không có;
- tránh transformation, ngoại trừ deduplicate bắt buộc và được giải thích;
- không đổi `unique_key` tùy tiện sau khi snapshot đã có lịch sử;
- không cho BI dùng snapshot thô; tạo model lịch sử với grain và semantics rõ;
- test `dbt_valid_from < dbt_valid_to` cho record đã đóng và chỉ một current row
  cho mỗi business key;
- xác định retention, quyền truy cập và quy trình xóa PII/GDPR trước khi snapshot
  dữ liệu nhạy cảm;
- thay đổi schema nguồn và thay đổi snapshot nên tách thành các deployment để
  snapshot có thể hấp thụ schema mới an toàn.

Date spine có thể tạo một dòng cho mỗi entity mỗi ngày nhưng làm tăng dữ liệu
rất nhanh. Chỉ dùng khi consumer thật sự cần grain theo ngày. Model date-spine
có thể incremental theo ngày mới, nhưng thay đổi logic lịch sử vẫn có thể yêu
cầu rebuild/backfill.

## 10. Seeds, macros, packages và tags

### 10.1 Seeds

Seed phù hợp với bảng mapping nhỏ, tĩnh, ít thay đổi và cần review trong Git, ví
dụ country code hoặc nhóm trạng thái chuẩn.

Không dùng seed cho:

- dữ liệu lớn hoặc cập nhật thường xuyên;
- dữ liệu cá nhân/nhạy cảm;
- output được xuất thủ công từ production;
- dữ liệu đáng ra phải có owner và pipeline ingestion riêng.

Seed phải có mô tả, test key và quy trình cập nhật giống model.

### 10.2 Macros và packages

- Tên file macro trùng tên macro.
- Macro public phải mô tả purpose, arguments, output và adapter support.
- Chỉ tạo macro cho logic tái sử dụng hoặc abstraction theo adapter; không dùng
  Jinja để che một câu SQL vốn dễ đọc.
- Pin version package, review changelog và chạy regression build khi nâng cấp.
- Ưu tiên package đã được team duyệt; không thêm dependency chỉ để tiết kiệm vài
  dòng SQL.

### 10.3 Tags và selectors

Tags dùng cho taxonomy ổn định như domain, SLA hoặc cost tier:

```yaml
models:
  - name: fct_orders
    config:
      tags: ["domain_customers", "hourly", "tier_1"]
```

Không tạo tag tự phát cho từng developer hoặc ticket. Duy trì danh sách tag hợp
lệ trong tài liệu/project seed và review tag mới.

Với selection logic lặp lại, đặt tên trong `selectors.yml` thay vì copy một
chuỗi selector dài vào nhiều job.

## 11. Quy trình phát triển hằng ngày

### 11.1 Chuẩn bị

1. Tạo branch từ nhánh chính mới nhất.
2. Chọn connection và target development của cá nhân/branch.
3. Xác nhận target không phải production.
4. Chạy dependency và connection check.

```bash
dbt deps
dbt debug
dbt parse
```

Trong dbt Web UI, tạo/mở project ở trang Develop, chọn connection đúng, sau đó
dùng editor, Compile, Preview, Lineage và terminal output tương ứng. Credential
được quản lý qua connection; không tạo hoặc commit `profiles.yml` chứa secret.

### 11.2 Vòng lặp phát triển

```bash
# Compile để kiểm tra Jinja và xem SQL thực tế
dbt compile --select dim_customers

# Build model cùng ancestors cần thiết
dbt build --select +dim_customers

# Build model cùng descendants trực tiếp để kiểm tra impact
dbt build --select dim_customers+

# Build một lineage đầy đủ; cẩn thận vì có thể tốn tài nguyên
dbt build --select +dim_customers+

# Chạy riêng test của model
dbt test --select dim_customers

# Kiểm tra source freshness
dbt source freshness --select source:crm
```

Selector `@model` còn bao gồm ancestors cần để dựng descendants nên hữu ích khi
dev schema còn trống, nhưng phạm vi có thể lớn. Luôn kiểm tra `dbt ls --select
...` trước một lệnh tốn tài nguyên.

Khi cần sample để tăng tốc local:

- sample phải deterministic và chỉ hoạt động ở target dev;
- production mặc định luôn dùng full data;
- không commit `limit`/`sample` tạm vào model dùng chung;
- trước review phải build/test lại trên full data hoặc một dataset CI đại diện.

### 11.3 Trước khi mở merge request

```bash
dbt clean
dbt deps
dbt parse
dbt build --select <changed_models_and_their_impact>
dbt docs generate
```

Ngoài ra:

- chạy SQL linter/formatter;
- xem compiled SQL của model phức tạp;
- kiểm tra lineage và consumer downstream;
- so sánh row count, grain, null rate và metric trước/sau;
- ghi runtime trước/sau nếu thay đổi materialization hoặc performance;
- không commit `target/`, `logs/`, package tải về hoặc credential.

## 12. Merge request và code review

Merge request phải trả lời ngắn gọn:

```markdown
## Mục tiêu
- Business problem và link ticket:

## Data contract
- Model/grain bị thay đổi:
- Primary key:
- Cột thêm, sửa, xóa:

## Lineage và downstream impact
- Source/model upstream:
- Dashboard/job/consumer downstream:
- Breaking change: Có/Không

## Kiểm thử
- Lệnh dbt đã chạy:
- Kết quả build/test:
- So sánh row count/metric:

## Vận hành
- Runtime trước/sau:
- Full refresh/backfill cần thiết:
- Kế hoạch rollback:
```

Reviewer kiểm tra theo thứ tự:

1. Grain và định nghĩa business có đúng không?
2. Lineage có dùng `source()`/`ref()` đúng layer không?
3. Join cardinality có làm fan-out không?
4. Test có bảo vệ assumption chính không?
5. Model public có documentation/contract không?
6. Incremental/snapshot có đúng với update semantics của nguồn không?
7. Thay đổi có phá consumer downstream không?
8. Query có đọc thừa row/column hoặc lặp compute nặng không?
9. Có dữ liệu nhạy cảm hoặc secret bị lộ không?
10. Có kế hoạch deploy, backfill và rollback không?

Không review chỉ dựa trên việc SQL “chạy được”.

## 13. CI/CD và lịch chạy

### 13.1 Pull request CI

Cổng CI tối thiểu:

1. cài dependency từ lock/pin;
2. `dbt parse`;
3. lint SQL/YAML;
4. build model thay đổi và downstream liên quan trong schema CI biệt lập;
5. lưu `manifest.json`, `run_results.json` và log làm artifact;
6. xóa/expire schema CI theo chính sách.

Nếu CI có production artifacts, ưu tiên state-based selection và defer:

```bash
dbt build \
  --select state:modified+ \
  --defer \
  --state path/to/production-artifacts
```

Nếu chưa có state artifacts, dùng selector theo domain/model và kiểm tra phạm vi
bằng `dbt ls`. Không dùng schema production để tiết kiệm bước build upstream.

### 13.2 Production

Pipeline production nên:

- dùng service account quyền tối thiểu;
- pin cùng dbt/adapters/packages như CI;
- chạy `dbt source freshness` theo SLA nguồn;
- dùng `dbt build` để test chạy theo DAG ngay sau resource liên quan;
- publish dbt docs và artifacts;
- phát cảnh báo kèm model/test, owner, invocation ID và link log;
- ngăn hai run ghi cùng project/schema nếu adapter không hỗ trợ an toàn.

Chia schedule theo SLA/tag thay vì build toàn project với cùng tần suất, ví dụ
`hourly`, `daily`, `weekly`. Một model chỉ nằm trong một ownership/SLA rõ ràng;
dependency khác schedule phải được xem xét freshness.

Với dbt Web UI, external orchestrator có thể gọi run qua API đã mô tả tại
`docs/external-orchestrator-api.md`. Orchestrator chịu trách nhiệm schedule và
retry; dbt project vẫn chịu trách nhiệm selection, test và data contract.

### 13.3 Quản lý phiên bản

- Pin `dbt-core`, adapter và package; local, CI và production dùng cùng bộ phiên
  bản.
- Theo dõi support window và deprecation warning; không chờ đến khi phiên bản
  hết hỗ trợ mới lập kế hoạch nâng cấp.
- Mỗi lần nâng version phải đọc migration guide/changelog, chạy `dbt parse`,
  build regression trên các domain quan trọng và so sánh artifacts.
- Nâng adapter cùng compatibility range của dbt Core; kiểm tra riêng feature như
  incremental, contract, freshness và snapshot trên từng engine đang dùng.
- Deploy upgrade vào đầu tuần làm việc, có image/lockfile cũ để rollback và tránh
  thời điểm business-critical.

## 14. Performance và cost

Tối ưu theo impact tổng thể, không theo cảm giác. Theo dõi ít nhất:

- thời gian build từng model và toàn invocation;
- số dòng/bytes output;
- bytes scan và spill nếu engine cung cấp;
- queue/concurrency;
- tần suất chạy;
- số downstream lặp lại cùng logic.

Thứ tự xử lý khi model chậm:

1. xác nhận grain và loại bỏ fan-out/cartesian join;
2. giảm cột và row trước join/aggregate;
3. đẩy filter sớm mà không đổi semantics;
4. bỏ join, sort, window hoặc `distinct` dư thừa;
5. xem query plan và compiled SQL;
6. cân nhắc materialize Silver model nặng;
7. đánh giá table partitioning/clustering theo engine;
8. đánh giá incremental bằng update semantics thực tế;
9. chỉ sau đó mới tăng compute/concurrency.

Mỗi project nên đặt performance budget dựa trên warehouse của mình. Điểm khởi
đầu tham khảo từ guide gốc là không để một model chạy quá 60 phút và luôn bắt
đầu với tài nguyên nhỏ nhất đủ dùng; team phải hạ ngưỡng nếu SLA thực tế chặt
hơn.

Tăng warehouse không đảm bảo giảm tổng chi phí. Một query kém hiệu quả chạy
nhanh hơn trên compute lớn vẫn là một lỗi lặp lại ở mọi production run.

## 15. Security, privacy và quyền truy cập

- Dùng environment variable hoặc connection secret store; không hard-code
  credential vào model, macro, seed hay Git.
- Phân quyền theo layer/domain và nguyên tắc least privilege.
- Đánh dấu model/cột chứa PII trong metadata.
- Masking phải được thực thi bằng cơ chế warehouse hoặc macro/hook đã được duyệt;
  không phụ thuộc vào việc người viết query “nhớ che cột”.
- Test dữ liệu nhạy cảm bằng invariant, không đưa literal thật vào fixture.
- Snapshot làm dữ liệu tồn tại lâu hơn nguồn hiện tại; phải nằm trong quy trình
  retention, right-to-erasure và audit.
- Không log compiled SQL nếu SQL có thể chứa secret truyền qua biến.
- Output preview và artifact CI phải có retention/quyền đọc phù hợp.

## 16. Breaking change, deprecation và drop model

Breaking change gồm: đổi grain, đổi nghĩa metric, rename/drop cột, đổi data type,
thay primary key, đổi timezone hoặc filter làm mất record mà consumer đang dùng.

Quy trình:

1. Tìm consumer qua dbt lineage, repository search và catalog BI.
2. Thông báo owner, phạm vi ảnh hưởng và ngày cutover.
3. Nếu cần, tạo model/cột version mới và chạy song song.
4. So sánh metric trong một khoảng thời gian đại diện.
5. Migrate consumer và xác nhận không còn reference cũ.
6. Merge việc xóa model khỏi code.
7. Drop relation production bằng migration/runbook riêng, có phê duyệt và
   rollback/retention rõ ràng.

Không để model bị disabled vô thời hạn. Model deprecated phải có owner và ngày
xóa dự kiến.

## 17. Ownership và trách nhiệm

| Vai trò | Trách nhiệm chính |
|---|---|
| Model owner | Định nghĩa grain/logic, test, docs, SLA và xử lý incident |
| Domain/business owner | Phê duyệt ý nghĩa metric và breaking change |
| Reviewer | Kiểm tra correctness, maintainability, downstream impact và cost |
| Data platform | Runtime, adapter, CI artifacts, orchestration, access và observability |
| Consumer | Dùng interface public, phản hồi contract/SLA, không query layer nội bộ |

Mỗi model public phải có owner là team/role có thể tiếp nhận sự cố, không chỉ là
tên một cá nhân.

## 18. Lộ trình áp dụng cho project hiện có

Không cần đổi toàn bộ project trong một merge request. Áp dụng theo vertical
slice:

1. Chọn một domain có owner và consumer rõ.
2. Inventory source tables, model và dashboard hiện tại.
3. Chốt grain/contract của các Gold models cần giữ.
4. Tạo source declarations và Bronze models mỏng.
5. Di chuyển business logic vào Silver/Gold.
6. Bổ sung test, docs, tags và owner.
7. Chạy song song, so sánh row count/metric với pipeline cũ.
8. Chuyển consumer.
9. Deprecate rồi drop model cũ theo quy trình.
10. Ghi lại pattern tái sử dụng cho domain tiếp theo.

Thứ tự ưu tiên migration:

- dataset ảnh hưởng quyết định business quan trọng;
- model thường xuyên fail hoặc không có owner;
- logic bị copy ở nhiều dashboard;
- model có runtime/cost cao;
- dataset chứa PII nhưng chưa có governance rõ.

## 19. Quick reference

```bash
# Kiểm tra project và connection
dbt debug
dbt parse

# Xem resource mà selector sẽ chọn
dbt ls --select +dim_customers+

# Build theo DAG (khuyến nghị)
dbt build --select +dim_customers+

# Chạy model hoặc test riêng khi debug
dbt run --select dim_customers
dbt test --select dim_customers

# Source freshness
dbt source freshness --select source:crm

# Snapshot trong target không phải production
dbt snapshot --select crm_customers_snapshot

# Generate docs/artifacts
dbt docs generate

# Full refresh: chỉ sau khi đánh giá impact/cost
dbt build --full-refresh --select fct_orders
```

### Checklist Definition of Done

- [ ] Model nằm đúng layer và đúng domain.
- [ ] Source layer dùng `source()`, các dbt model dùng `ref()`.
- [ ] Grain và primary key được ghi rõ.
- [ ] Join cardinality đã được kiểm tra.
- [ ] Test tối thiểu và business-rule test đã pass.
- [ ] Model/cột public có documentation; contract được áp dụng khi cần.
- [ ] Incremental/snapshot có test và runbook tương ứng.
- [ ] Full-data validation hoặc CI dataset đại diện đã chạy.
- [ ] Downstream impact và breaking change đã đánh giá.
- [ ] Runtime/cost không bị suy giảm ngoài dự kiến.
- [ ] Không có secret, PII mẫu hoặc artifact generated trong commit.
- [ ] Có owner, cách deploy/backfill và rollback.

## 20. Các quyết định được kế thừa và điều chỉnh từ ultimate guide

Guide nội bộ này kế thừa các nguyên tắc mạnh của tài liệu gốc: source layer mỏng,
lineage qua `source()`/`ref()`, test và documentation là một phần của model,
snapshot cho SCD2, review downstream impact, quản lý dữ liệu nhạy cảm và tối ưu
query/materialization trước compute.

Các chi tiết chỉ dành cho GitLab/Snowflake như tên database, warehouse size,
zero-copy clone, macro nội bộ, dashboard và merge-request project riêng không
được biến thành chuẩn của team. Thay vào đó, guide dùng kiến trúc
`source → bronze → silver → gold`, cú pháp dbt Core 1.10 và nguyên tắc portable
cho các adapter mà dbt Web UI hiện hỗ trợ.
