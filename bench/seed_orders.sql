-- Grow the demo CRM to a size where engine differences are measurable.
--
-- The shipped demo has 15 orders, so a dbt run there measures dbt's own
-- startup and nothing else. Set :rows to what the comparison needs;
-- 2,000,000 orders is a few hundred MB and finishes in about a minute.
--
--   docker compose exec -T demo-source \
--     psql -U demo -d crm -v rows=2000000 -f - < bench/seed_orders.sql
--
-- Idempotent: it deletes generated rows (id > 1000) before inserting.

\set rows :rows

DELETE FROM orders WHERE id > 1000;

INSERT INTO orders (id, customer_id, product_id, quantity, amount, status, ordered_at, updated_at)
SELECT
  1000 + n,
  1 + (n % (SELECT count(*) FROM customers)),
  1 + (n % (SELECT count(*) FROM products)),
  1 + (n % 9),
  round((10 + (n % 4990) + (n % 97) / 100.0)::numeric, 2),
  (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + (n % 4)],
  DATE '2023-01-01' + ((n % 1095) || ' days')::interval,
  now()
FROM generate_series(1, :rows) AS n;

ANALYZE orders;
SELECT count(*) AS orders FROM orders;
