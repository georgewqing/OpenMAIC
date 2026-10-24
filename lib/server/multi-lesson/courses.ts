/**
 * Orchestration between multi-lesson plans and the document store.
 *
 * Mapping:
 *   course  -> one document folder
 *   lesson  -> one stage inside that folder, carrying the lesson outline and
 *              only the scenes already generated
 * The plan index lives in `multi_lesson_courses` (./persistence.ts).
 *
 * Selective generation is the defining behaviour: saving a plan never invokes
 * an LLM and never deletes a generated page without an explicit
 * `allowDeleteGenerated` opt-in — instead the conflict is returned for the
 * caller to confirm.
 */
import { randomBytes } from 'node:crypto';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import { FolderNameError } from '@/lib/utils/folder-name-validation';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { createFolderForOwner } from '@/lib/server/folder-persistence';

import { reconcileLessonScenes, type GeneratedSceneRef } from './plan-schema';
import { upsertMultiLessonCourse } from './persistence';
import type {
  LessonGenerationStatus,
  LessonPlan,
  LessonSceneStatus,
  LessonStageBinding,
  MultiLessonCourseRecord,
  MultiLessonPlan,
} from './types';

/** Mint a fresh stage id in the same family as POST /api/stages. */
export function createStageId(): string {
  return `stage-${randomBytes(9).toString('base64url')}`;
}

function outlineRef(scene: AppScene): string {
  return scene.outlineId ?? `p${scene.order}`;
}

/** Create a folder; on a same-name clash with an unrelated folder, suffix. */
async function createFolderWithSuffix(
  store: Awaited<ReturnType<typeof getOwnerScopedDocumentStore>>,
  title: string,
) {
  let name = title;
  for (let attempt = 2; attempt <= 50; attempt += 1) {
    try {
      const created = await createFolderForOwner(store, name, { reuseExisting: false });
      return created.folder;
    } catch (error) {
      if (error instanceof FolderNameError && error.kind === 'duplicate') {
        name = `${title} (${attempt})`;
        continue;
      }
      throw error;
    }
  }
  throw new FolderNameError('Could not allocate a unique folder name', 'duplicate');
}

function emptyLessonOutline(
  plan: MultiLessonPlan,
  lesson: LessonPlan,
  now: number,
  folderId: string,
): AppDocumentOutline {
  return {
    outlines: lesson.scenes.map((scene) => ({ ...scene })),
    requirement: `${plan.courseTitle} / ${lesson.title}`,
    generationComplete: false,
    producer: 'server-job',
    producerRef: `multi-lesson:${folderId}`,
    createdAt: now,
    updatedAt: now,
  };
}

export interface CreateCourseResult {
  record: MultiLessonCourseRecord;
}

/** Create folder + one empty (outline-only) stage per lesson, then index it. */
export async function createMultiLessonCourse(
  ownerId: string,
  plan: MultiLessonPlan,
): Promise<CreateCourseResult> {
  const store = await getOwnerScopedDocumentStore(ownerId);
  const now = Date.now();

  // Folder names are unique per owner; a clash with an unrelated folder gets a
  // numeric suffix (the plan keeps the title the teacher typed).
  const folder = await createFolderWithSuffix(store, plan.courseTitle);

  const lessonStages: LessonStageBinding[] = [];
  for (const lesson of plan.lessons) {
    const stageId = createStageId();
    await store.saveDocument({
      stage: {
        id: stageId,
        name: lesson.title,
        ...(lesson.teachingObjective ? { description: lesson.teachingObjective } : {}),
        ...(plan.languageDirective ? { languageDirective: plan.languageDirective } : {}),
        createdAt: now,
        updatedAt: now,
      },
      scenes: [],
      outline: emptyLessonOutline(plan, lesson, now, folder.id),
    });
    await store.setStageFolder(stageId, folder.id);
    lessonStages.push({ lessonId: lesson.id, stageId });
  }

  const record: MultiLessonCourseRecord = {
    folderId: folder.id,
    plan,
    lessonStages,
    createdAt: now,
    updatedAt: now,
  };
  await upsertMultiLessonCourse(ownerId, folder.id, record);
  return { record };
}

export interface PlanEditConflict {
  kind: 'generated-scene-delete' | 'lesson-delete';
  lessonId: string;
  sceneIds: string[];
}

export interface UpdatePlanResult {
  record: MultiLessonCourseRecord;
  removedStageIds: string[];
}

export interface UpdatePlanOptions {
  /** Confirm deleting generated pages / lessons the edited plan removed. */
  allowDeleteGenerated?: boolean;
}

/**
 * Apply an edited plan: rename lessons, add stages for new lessons, tombstone
 * removed lessons, and reconcile each lesson's generated scenes against the
 * edited outline. Scenes are matched by outline id (stable through reorders).
 */
export async function updateMultiLessonPlan(
  ownerId: string,
  existing: MultiLessonCourseRecord,
  plan: MultiLessonPlan,
  options: UpdatePlanOptions = {},
): Promise<UpdatePlanResult> {
  const store = await getOwnerScopedDocumentStore(ownerId);
  const now = Date.now();
  const allowDelete = Boolean(options.allowDeleteGenerated);

  interface ExistingLesson {
    lesson: LessonPlan;
    binding: LessonStageBinding;
    doc: NonNullable<Awaited<ReturnType<typeof store.loadDocument>>>;
    removeSceneIds: string[];
  }
  interface RemovedLesson {
    binding: LessonStageBinding;
    hasGenerated: boolean;
  }

  // Pass 1 — load everything and compute destructive conflicts BEFORE writes.
  const conflicts: PlanEditConflict[] = [];
  const existingLessons: ExistingLesson[] = [];
  const newLessons: LessonPlan[] = [];
  for (const lesson of plan.lessons) {
    const binding = existing.lessonStages.find((item) => item.lessonId === lesson.id);
    if (!binding) {
      newLessons.push(lesson);
      continue;
    }
    const doc = await store.loadDocument(binding.stageId);
    if (!doc) {
      throw new Error(`stage ${binding.stageId} for lesson ${lesson.id} is not readable`);
    }
    const generated: GeneratedSceneRef[] = doc.scenes.map((scene) => ({
      sceneId: scene.id,
      outlineId: outlineRef(scene),
      order: scene.order,
      type: scene.type,
      title: scene.title,
    }));
    const diff = reconcileLessonScenes(lesson.scenes, generated);
    if (diff.remove.length > 0 && !allowDelete) {
      conflicts.push({
        kind: 'generated-scene-delete',
        lessonId: lesson.id,
        sceneIds: diff.remove.map((item) => item.sceneId),
      });
    }
    existingLessons.push({
      lesson,
      binding,
      doc,
      removeSceneIds: diff.remove.map((item) => item.sceneId),
    });
  }

  const removedLessons: RemovedLesson[] = [];
  const lessonIds = new Set(plan.lessons.map((lesson) => lesson.id));
  for (const binding of existing.lessonStages) {
    if (lessonIds.has(binding.lessonId)) continue;
    const doc = await store.loadDocument(binding.stageId);
    const hasGenerated = Boolean(doc && doc.scenes.length > 0);
    if (hasGenerated && !allowDelete) {
      conflicts.push({
        kind: 'lesson-delete',
        lessonId: binding.lessonId,
        sceneIds: doc ? doc.scenes.map((scene) => scene.id) : [],
      });
    }
    removedLessons.push({ binding, hasGenerated });
  }
  if (conflicts.length > 0) throw new PlanEditConflictError(conflicts);

  // Pass 2 — apply. Folder tracks the course title best-effort; plan is canonical.
  if (plan.courseTitle !== existing.plan.courseTitle) {
    try {
      await store.renameFolder(existing.folderId, plan.courseTitle);
    } catch (error) {
      // A duplicate name refuses; the folder is only the container.
      console.warn(`[multi-lesson] folder rename skipped: ${String(error)}`);
    }
  }

  const bindings: LessonStageBinding[] = [];
  const removedStageIds: string[] = [];

  for (const lesson of newLessons) {
    const stageId = createStageId();
    await store.saveDocument({
      stage: {
        id: stageId,
        name: lesson.title,
        ...(plan.languageDirective ? { languageDirective: plan.languageDirective } : {}),
        createdAt: now,
        updatedAt: now,
      },
      scenes: [],
      outline: emptyLessonOutline(plan, lesson, now, existing.folderId),
    });
    await store.setStageFolder(stageId, existing.folderId);
    bindings.push({ lessonId: lesson.id, stageId });
  }

  for (const { lesson, binding, doc, removeSceneIds } of existingLessons) {
    const removeSet = new Set(removeSceneIds);
    const plannedScenes = reconcileLessonScenes(
      lesson.scenes,
      doc.scenes.map((scene) => ({
        sceneId: scene.id,
        outlineId: outlineRef(scene),
        order: scene.order,
        type: scene.type,
        title: scene.title,
      })),
    );
    const orderByScene = new Map(plannedScenes.keep.map((item) => [item.sceneId, item.order]));
    const titleById = new Map(lesson.scenes.map((scene) => [scene.id, scene.title]));
    const scenes = doc.scenes
      .filter((scene) => !removeSet.has(scene.id))
      .map((scene) => {
        const order = orderByScene.get(scene.id);
        const keep = plannedScenes.keep.find((item) => item.sceneId === scene.id);
        const title = keep ? titleById.get(keep.outlineId) : undefined;
        return {
          ...scene,
          ...(order !== undefined ? { order } : {}),
          ...(title ? { title } : {}),
        };
      });

    const priorOutline = doc.outline ?? { outlines: [], createdAt: now, updatedAt: now };
    await store.saveDocument({
      stage: {
        ...doc.stage,
        name: lesson.title,
        ...(lesson.teachingObjective ? { description: lesson.teachingObjective } : {}),
        ...(plan.languageDirective ? { languageDirective: plan.languageDirective } : {}),
        updatedAt: now,
      },
      scenes,
      outline: {
        ...priorOutline,
        outlines: lesson.scenes.map((scene) => ({ ...scene })),
        updatedAt: now,
      },
    });
    bindings.push(binding);
  }

  for (const { binding } of removedLessons) {
    await store.deleteDocument(binding.stageId);
    removedStageIds.push(binding.stageId);
  }

  const record: MultiLessonCourseRecord = {
    folderId: existing.folderId,
    plan,
    lessonStages: bindings,
    createdAt: existing.createdAt,
    updatedAt: now,
  };
  await upsertMultiLessonCourse(ownerId, existing.folderId, record);
  return { record, removedStageIds };
}

export class PlanEditConflictError extends Error {
  constructor(readonly conflicts: PlanEditConflict[]) {
    super(`plan edit needs confirmation: ${conflicts.length} conflict(s)`);
    this.name = 'PlanEditConflictError';
  }
}

/** Read a course with each lesson's generation status against its stage doc. */
export async function loadCourseWithStatus(
  ownerId: string,
  record: MultiLessonCourseRecord,
): Promise<{ record: MultiLessonCourseRecord; lessons: LessonGenerationStatus[] }> {
  const store = await getOwnerScopedDocumentStore(ownerId);
  const lessons: LessonGenerationStatus[] = [];

  for (const lesson of record.plan.lessons) {
    const binding = record.lessonStages.find((item) => item.lessonId === lesson.id);
    const empty: LessonGenerationStatus = {
      stageId: binding?.stageId ?? '',
      lessonId: lesson.id,
      title: lesson.title,
      total: lesson.scenes.length,
      generated: 0,
      stale: 0,
      scenes: lesson.scenes.map(() => ({ status: 'planned' as const })),
    };
    if (!binding) {
      lessons.push(empty);
      continue;
    }
    const doc = await store.loadDocument(binding.stageId);
    if (!doc) {
      lessons.push(empty);
      continue;
    }
    const generated = doc.scenes.map((scene) => ({
      sceneId: scene.id,
      outlineId: outlineRef(scene),
      order: scene.order,
      type: scene.type,
      title: scene.title,
    }));
    const diff = reconcileLessonScenes(lesson.scenes, generated);
    const staleIds = new Set(diff.stale.map((item) => item.outlineId));
    const keepById = new Map(diff.keep.map((item) => [item.outlineId, item]));
    const scenes: LessonSceneStatus[] = lesson.scenes.map((outline) => {
      const keep = keepById.get(outline.id);
      if (!keep) return { status: 'planned' as const };
      return {
        sceneId: keep.sceneId,
        status: staleIds.has(outline.id) ? ('stale' as const) : ('generated' as const),
      };
    });
    lessons.push({
      stageId: binding.stageId,
      lessonId: lesson.id,
      title: lesson.title,
      total: lesson.scenes.length,
      // A page exists for the entry (even if its type drifted = stale).
      generated: diff.keep.length,
      stale: diff.stale.length,
      scenes,
    });
  }
  return { record, lessons };
}
