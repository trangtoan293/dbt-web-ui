-- Fix: update_updated_at() trigger sets NEW.updated_at on dremio_sources and
-- connections, but those tables had no updated_at column. Any UPDATE raised
-- "record \"new\" has no field \"updated_at\"". Add the missing columns.

-- AlterTable
ALTER TABLE "dremio_sources" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "connections" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
