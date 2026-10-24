/**
 * Validate and normalize an untrusted multi-lesson plan (model output or a
 * browser edit) into {@link MultiLessonPlan}.
 *
 * Scene validation reuses the classic outline normalizer
 * (`normalizeSceneOutlines`) per lesson, so anything a single-course
 * confirm-outline accepts, a lesson accepts too. Orders follow list position,
 * exactly as the browser outline editor numbers scenes after every edit.
 */
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import type { SceneOutline } from '@/lib/types/generation';

import type { LessonPlan, MultiLessonPlan } from './types';

export const MAX_LESSONS = 20;
export const MAX_COURSE_TITLE_CHARS = 120;
export const MAX_LESSON_TITLE_CHARS = 120;
export const MAX_LESSON_ID_CHARS = 64;
const MAX_LESSON_DURATION_MIN = 600;

export type NormalizedPlan = { ok: true; value: MultiLessonPlan } | { ok: false; message: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize one lesson. Scene orders are assigned from list position; scene
 * ids default to `p<order>` when the caller/model omitted them.
 */
function normalizeLesson(value: unknown, index: number): LessonPlan | { error: string } {
  const raw = record(value);
  const at = `lessons[${index}]`;
  if (!raw) return { error: `${at} must be an object` };

  const title = trimmedText(raw.title);
  if (!title) return { error: `${at}.title is required` };
  if (title.length > MAX_LESSON_TITLE_CHARS) {
    return { error: `${at}.title must be at most ${MAX_LESSON_TITLE_CHARS} characters` };
  }

  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes : undefined;
  if (!rawScenes) return { error: `${at}.scenes must be an array` };

  // Orders follow the list; ids default like generate_scene does (p1, p2 …).
  const withOrders = rawScenes.map((scene, sceneIndex) => {
    const item = record(scene);
    if (!item) return scene;
    const hasId = typeof item.id === 'string' && item.id.trim().length > 0;
    return { ...item, ...(hasId ? {} : { id: `p${sceneIndex + 1}` }), order: sceneIndex + 1 };
  });
  const scenesResult = normalizeSceneOutlines(withOrders);
  if (!scenesResult.ok) return { error: `${at}: ${scenesResult.message}` };
  const scenes: SceneOutline[] = scenesResult.value.map((scene, sceneIndex) => ({
    ...scene,
    order: sceneIndex + 1,
  }));

  const lesson: LessonPlan = {
    id: trimmedText(raw.id) ?? `lesson-${index + 1}`,
    title,
    scenes,
  };
  if (lesson.id.length > MAX_LESSON_ID_CHARS) {
    return { error: `${at}.id must be at most ${MAX_LESSON_ID_CHARS} characters` };
  }
  const objective = trimmedText(raw.teachingObjective);
  if (objective) lesson.teachingObjective = objective;
  if (typeof raw.estimatedDuration === 'number' && Number.isFinite(raw.estimatedDuration)) {
    const duration = raw.estimatedDuration;
    if (duration > 0 && duration <= MAX_LESSON_DURATION_MIN) {
      lesson.estimatedDuration = duration;
    }
  }
  return lesson;
}

/** Normalize a full multi-lesson plan from untrusted JSON. */
export function normalizeMultiLessonPlan(value: unknown): NormalizedPlan {
  const raw = record(value);
  if (!raw) return { ok: false, message: 'plan must be a JSON object' };

  const courseTitle = trimmedText(raw.courseTitle);
  if (!courseTitle) return { ok: false, message: 'courseTitle is required' };
  if (courseTitle.length > MAX_COURSE_TITLE_CHARS) {
    return {
      ok: false,
      message: `courseTitle must be at most ${MAX_COURSE_TITLE_CHARS} characters`,
    };
  }

  const rawLessons = raw.lessons;
  if (!Array.isArray(rawLessons) || rawLessons.length === 0) {
    return { ok: false, message: 'lessons must be a non-empty array' };
  }
  if (rawLessons.length > MAX_LESSONS) {
    return { ok: false, message: `at most ${MAX_LESSONS} lessons per course` };
  }

  const lessons: LessonPlan[] = [];
  for (const [index, entry] of rawLessons.entries()) {
    const result = normalizeLesson(entry, index);
    if ('error' in result) return { ok: false, message: result.error };
    lessons.push(result);
  }
  if (new Set(lessons.map((lesson) => lesson.id)).size !== lessons.length) {
    return { ok: false, message: 'lesson ids must be unique' };
  }

  const plan: MultiLessonPlan = { courseTitle, lessons };
  const subject = trimmedText(raw.subject);
  const grade = trimmedText(raw.grade);
  const languageDirective = trimmedText(raw.languageDirective);
  if (subject) plan.subject = subject;
  if (grade) plan.grade = grade;
  if (languageDirective) plan.languageDirective = languageDirective;
  return { ok: true, value: plan };
}

// ── Edit reconciliation (pure) ────────────────────────────────────────────

export interface GeneratedSceneRef {
  sceneId: string;
  outlineId: string;
  order: number;
  type: string;
  title: string;
}

/** What an edited plan means for the scenes already generated in a lesson. */
export interface LessonReconcile {
  /** Outline entries in final order (orders renumbered 1..n). */
  outlines: readonly SceneOutline[];
  /** Generated scenes the plan keeps, each mapped to its new 1-based order. */
  keep: { sceneId: string; outlineId: string; order: number; typeMismatch: boolean }[];
  /** Generated scenes whose outline entry disappeared (delete the page). */
  remove: { sceneId: string; outlineId: string }[];
  /** Outline entries with no generated scene yet. */
  planned: { outlineId: string; order: number }[];
  /** Outline entries whose type changed vs the generated page. */
  stale: { sceneId: string; outlineId: string; order: number }[];
}

/**
 * Diff an edited lesson plan against the lesson's currently generated scenes.
 * Matching is by outline id (stable through reorders/renames), not order.
 */
export function reconcileLessonScenes(
  scenes: readonly SceneOutline[],
  generated: readonly GeneratedSceneRef[],
): LessonReconcile {
  const keep: LessonReconcile['keep'] = [];
  const stale: LessonReconcile['stale'] = [];
  const planned: LessonReconcile['planned'] = [];

  scenes.forEach((outline, index) => {
    const order = index + 1;
    const hit = generated.find((scene) => scene.outlineId === outline.id);
    if (!hit) {
      planned.push({ outlineId: outline.id, order });
      return;
    }
    const typeMismatch = hit.type !== outline.type;
    keep.push({ sceneId: hit.sceneId, outlineId: outline.id, order, typeMismatch });
    if (typeMismatch) stale.push({ sceneId: hit.sceneId, outlineId: outline.id, order });
  });

  const plannedIds = new Set(scenes.map((scene) => scene.id));
  const remove = generated
    .filter((scene) => !plannedIds.has(scene.outlineId))
    .map((scene) => ({ sceneId: scene.sceneId, outlineId: scene.outlineId }));

  return { outlines: scenes, keep, remove, planned, stale };
}
