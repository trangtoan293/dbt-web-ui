-- What a load does when the source grows a column.
--
-- Until now this was not a decision anyone made: dlt's default absorbed the new
-- column, and the only mention of drift in the product was a sentence in the run
-- panel explaining that a merge would fail and to re-run with a full refresh.
-- That is an explanation after the fact, where a choice before it belongs.
--
-- Two values only. "evolve" takes the new column - today's behaviour, which is
-- why it is the default and why every existing row keeps it. "freeze" stops the
-- load and names the column. There is deliberately no third option that carries
-- on and drops it: a load that succeeds while quietly discarding data is the
-- failure nobody notices until a report goes blank.
--
-- New *tables* stay evolvable under both: a load's first run is what creates its
-- tables, so freezing those would make a new source unusable on day one.

ALTER TABLE "ingest_sources"
  ADD COLUMN IF NOT EXISTS "schema_contract" TEXT NOT NULL DEFAULT 'evolve';
