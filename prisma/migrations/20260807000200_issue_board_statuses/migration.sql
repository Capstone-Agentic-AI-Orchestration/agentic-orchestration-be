-- Issue board columns: BACKLOG, BLOCKED, CANCELLED.
--
-- ProjectTask carried four states (TODO, IN_PROGRESS, IN_REVIEW, DONE), which is a task list.
-- An issue board needs somewhere to put work that is not scheduled yet, work that is stuck,
-- and work that was abandoned — otherwise all three end up misfiled as TODO or deleted, and
-- "why did this stop?" has no recorded answer.
--
-- Placed with BEFORE/AFTER rather than appended, so the Postgres type's own sort order matches
-- the left-to-right order of the board. `ORDER BY status` then reads correctly for free instead
-- of returning insertion order, which would put BACKLOG after DONE.
--
-- This migration ONLY adds the labels. Postgres refuses to let a newly added enum value be used
-- in the same transaction that adds it, so any data written into these states must land in a
-- later migration. Nothing here writes.

ALTER TYPE projects."ProjectTaskStatus" ADD VALUE IF NOT EXISTS 'BACKLOG' BEFORE 'TODO';
ALTER TYPE projects."ProjectTaskStatus" ADD VALUE IF NOT EXISTS 'BLOCKED' AFTER 'DONE';
ALTER TYPE projects."ProjectTaskStatus" ADD VALUE IF NOT EXISTS 'CANCELLED' AFTER 'BLOCKED';
