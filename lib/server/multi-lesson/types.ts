/**
 * Multi-lesson planning ("单元多课") types.
 *
 * A multi-lesson course is one document folder containing one stage per
 * lesson. Each lesson carries a flat {@link SceneOutline} plan exactly like a
 * classic single-course generation run, so content generation reuses the same
 * scene-content prompts and slots. Scenes are generated selectively: a stage
 * may hold its outline while having zero (or only some) scene rows.
 */
import type { SceneOutline } from '@/lib/types/generation';

/** One lesson within a multi-lesson course; maps 1:1 to a document stage. */
export interface LessonPlan {
  /** Stable within the course, e.g. `lesson-1`. Survives reorders/renames. */
  id: string;
  title: string;
  /** Lesson-level teaching objective (used by the planning prompt and UI). */
  teachingObjective?: string;
  /** Planned lesson length in minutes (typically 50). */
  estimatedDuration?: number;
  /** Planned pages, order 1..n within the lesson. */
  scenes: SceneOutline[];
}

/** The editable plan of a whole multi-lesson course. */
export interface MultiLessonPlan {
  courseTitle: string;
  subject?: string;
  grade?: string;
  /** Teaching-language directive, copied onto every created stage. */
  languageDirective?: string;
  lessons: LessonPlan[];
}

/** A lesson's bound stage, persisted alongside the plan. */
export interface LessonStageBinding {
  lessonId: string;
  stageId: string;
}

/**
 * The persisted multi-lesson course record (one row per folder in
 * `multi_lesson_courses`). The plan is the editable canonical copy; stage
 * documents hold per-lesson outline copies and the generated scenes.
 */
export interface MultiLessonCourseRecord {
  folderId: string;
  plan: MultiLessonPlan;
  lessonStages: LessonStageBinding[];
  createdAt: number;
  updatedAt: number;
}

// ── Lesson generation status (computed, never persisted) ──────────────────

export type ScenePlanStatus =
  | 'planned' // outline only, nothing generated
  | 'generated' // a scene row matching the outline exists
  | 'stale'; // generated, but its type drifted from the edited outline

export interface LessonSceneStatus {
  /** Matched scene row id when a generated page exists for this outline. */
  sceneId?: string;
  status: ScenePlanStatus;
}

export interface LessonGenerationStatus {
  stageId: string;
  lessonId: string;
  title: string;
  total: number;
  generated: number;
  stale: number;
  scenes: LessonSceneStatus[];
}
