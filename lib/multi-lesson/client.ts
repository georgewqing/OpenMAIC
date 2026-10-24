/**
 * Browser client for the multi-lesson feature's API.
 * Pure fetch helpers (no React), so both the new-plan flow and the outline
 * page share one typed surface.
 */
import type {
  LessonGenerationStatus,
  MultiLessonCourseRecord,
  MultiLessonPlan,
} from '@/lib/server/multi-lesson/types';
import type { SceneOutline } from '@/lib/types/generation';

export interface PlanRequirement {
  requirement: string;
  lessonCount?: number;
  subject?: string;
  grade?: string;
  durationMinutes?: number;
  structure?: string[];
}

export interface CourseWithStatus {
  record: MultiLessonCourseRecord;
  lessons: LessonGenerationStatus[];
}

export interface PlanEditConflict {
  kind: 'generated-scene-delete' | 'lesson-delete';
  lessonId: string;
  sceneIds: string[];
}

export class MultiLessonApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly conflicts?: PlanEditConflict[],
  ) {
    super(message);
    this.name = 'MultiLessonApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const body = data as
      | { errorCode?: string; error?: string; details?: string }
      | { error?: { code?: string; message?: string; conflicts?: PlanEditConflict[] } }
      | null;
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'object') {
      const nested = (
        body as { error: { code?: string; message?: string; conflicts?: PlanEditConflict[] } }
      ).error;
      throw new MultiLessonApiError(
        res.status,
        nested.code ?? `HTTP_${res.status}`,
        nested.message ?? res.statusText,
        nested.conflicts,
      );
    }
    const flat = body as { errorCode?: string; error?: string; details?: string } | null;
    throw new MultiLessonApiError(
      res.status,
      flat?.errorCode ?? `HTTP_${res.status}`,
      flat?.error ?? flat?.details ?? res.statusText,
    );
  }
  return data as T;
}

export function generatePlan(input: PlanRequirement): Promise<{ plan: MultiLessonPlan }> {
  return request('/api/multi-lesson/plan', { method: 'POST', body: JSON.stringify(input) });
}

export function createCourse(plan: MultiLessonPlan): Promise<{ course: MultiLessonCourseRecord }> {
  return request('/api/multi-lesson/courses', {
    method: 'POST',
    body: JSON.stringify({ plan }),
  });
}

export interface CourseSummary {
  folderId: string;
  courseTitle: string;
  subject?: string;
  grade?: string;
  lessonCount: number;
  updatedAt: number;
}

export function listCourses(): Promise<{ courses: CourseSummary[] }> {
  return request('/api/multi-lesson/courses');
}

export function getCourse(folderId: string): Promise<CourseWithStatus> {
  return request(`/api/multi-lesson/courses/${encodeURIComponent(folderId)}`);
}

export function saveCoursePlan(
  folderId: string,
  plan: MultiLessonPlan,
  allowDeleteGenerated = false,
): Promise<CourseWithStatus> {
  return request(`/api/multi-lesson/courses/${encodeURIComponent(folderId)}`, {
    method: 'PUT',
    body: JSON.stringify({ plan, allowDeleteGenerated }),
  });
}

export interface GenerateSceneBody {
  order: number;
  type: SceneOutline['type'];
  title: string;
  brief: string;
  keyPoints?: string[];
  outlineId?: string;
  instruction?: string;
  quizConfig?: SceneOutline['quizConfig'];
  widgetType?: SceneOutline['widgetType'];
  widgetOutline?: SceneOutline['widgetOutline'];
  pblConfig?: SceneOutline['pblConfig'];
}

export function generateScene(
  stageId: string,
  body: GenerateSceneBody,
): Promise<{ scene: { id: string; order: number; title: string; type: string } }> {
  return request(`/api/stages/${encodeURIComponent(stageId)}/scenes/generate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
