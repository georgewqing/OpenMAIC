/**
 * Persistence for the multi-lesson ("单元多课") feature.
 *
 * Folders and stages carry no metadata beyond a name, so the binding between a
 * folder and its planned lessons lives in one small app-owned table,
 * `multi_lesson_courses` (one row per folder). Stage documents still own their
 * per-lesson outline copies and generated scenes; this row is only the index:
 * which lessons exist, in what order, and which stage each maps to.
 *
 * Schema is created lazily and cached per connection string exactly like the
 * agent session store (lib/server/agent-runtime/store.ts).
 */
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';
import { createLogger } from '@/lib/logger';

import type { MultiLessonCourseRecord } from './types';

const log = createLogger('MultiLessonStore');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS multi_lesson_courses (
  owner_id TEXT NOT NULL,
  folder_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS multi_lesson_courses_owner_idx
  ON multi_lesson_courses (owner_id, updated_at DESC);
`;

async function ensureSchema(queryable: Queryable): Promise<void> {
  await queryable.query(SCHEMA);
}

interface StoreState {
  pool: Pool;
}

const STATE_KEY = Symbol.for('openmaic.multi-lesson.store');
const globalState = globalThis as typeof globalThis & {
  [STATE_KEY]?: Map<string, Promise<StoreState>>;
};
const states = (globalState[STATE_KEY] ??= new Map());

/** Get the shared pool for this DATABASE_URL, creating the schema once. */
export async function getMultiLessonPool(connectionString?: string): Promise<Pool> {
  const url = connectionString ?? process.env.DATABASE_URL ?? '';
  const existing = states.get(url);
  if (existing) return (await existing).pool;

  const created = (async (): Promise<StoreState> => {
    const { pool } = await getServerPersistenceProvider(url);
    await withSchemaBootstrapLock(pool as unknown as ConnectableQueryable, ensureSchema);
    return { pool };
  })();
  states.set(url, created);
  try {
    return (await created).pool;
  } catch (error) {
    states.delete(url);
    throw error;
  }
}

interface CourseRow {
  owner_id: string;
  folder_id: string;
  data: MultiLessonCourseRecord;
}

/** Upsert a course index row. Caller has already authorized the owner. */
export async function upsertMultiLessonCourse(
  ownerId: string,
  folderId: string,
  record: MultiLessonCourseRecord,
): Promise<void> {
  const pool = await getMultiLessonPool();
  await pool.query(
    `INSERT INTO multi_lesson_courses (owner_id, folder_id, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (folder_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at`,
    [ownerId, folderId, JSON.stringify(record), record.createdAt, record.updatedAt],
  );
}

/** Read a course row; returns null when absent or owned by someone else. */
export async function readMultiLessonCourse(
  ownerId: string,
  folderId: string,
): Promise<(MultiLessonCourseRecord & { ownerId: string }) | null> {
  const pool = await getMultiLessonPool();
  const result = await pool.query<CourseRow>(
    'SELECT owner_id, folder_id, data FROM multi_lesson_courses WHERE folder_id = $1',
    [folderId],
  );
  const row = result.rows[0];
  if (!row || row.owner_id !== ownerId) return null;
  return { ...row.data, ownerId: row.owner_id };
}

export interface MultiLessonCourseSummary {
  folderId: string;
  courseTitle: string;
  subject?: string;
  grade?: string;
  lessonCount: number;
  updatedAt: number;
}

/** List the owner's multi-lesson courses, newest edit first. */
export async function listMultiLessonCourses(ownerId: string): Promise<MultiLessonCourseSummary[]> {
  const pool = await getMultiLessonPool();
  const result = await pool.query<{ data: MultiLessonCourseRecord }>(
    `SELECT data FROM multi_lesson_courses
      WHERE owner_id = $1
      ORDER BY updated_at DESC, folder_id ASC`,
    [ownerId],
  );
  return result.rows.map(({ data }) => ({
    folderId: data.folderId,
    courseTitle: data.plan.courseTitle,
    ...(data.plan.subject ? { subject: data.plan.subject } : {}),
    ...(data.plan.grade ? { grade: data.plan.grade } : {}),
    lessonCount: data.plan.lessons.length,
    updatedAt: data.updatedAt,
  }));
}

/** Delete the index row (stage documents are handled by the caller). */
export async function deleteMultiLessonCourse(folderId: string): Promise<void> {
  const pool = await getMultiLessonPool();
  await pool.query('DELETE FROM multi_lesson_courses WHERE folder_id = $1', [folderId]);
  log.info(`deleted multi-lesson course index ${folderId}`);
}
