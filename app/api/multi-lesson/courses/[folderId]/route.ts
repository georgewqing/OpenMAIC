/**
 * /api/multi-lesson/courses/:folderId
 *   GET — course plan with per-lesson generation status
 *   PUT { plan, allowDeleteGenerated? } — edit the plan: rename lessons,
 *         reorder/add/remove pages and lessons. Removing generated pages or
 *         non-empty lessons needs an explicit confirm flag; otherwise the
 *         answer is 409 PLAN_EDIT_CONFLICT listing what would be deleted.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  loadCourseWithStatus,
  PlanEditConflictError,
  updateMultiLessonPlan,
} from '@/lib/server/multi-lesson/courses';
import { readMultiLessonCourse } from '@/lib/server/multi-lesson/persistence';
import { normalizeMultiLessonPlan } from '@/lib/server/multi-lesson/plan-schema';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ folderId: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { folderId } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const record = await readMultiLessonCourse(ownerId, folderId);
    if (!record) return ownerNotFound(responseHeaders);
    const withStatus = await loadCourseWithStatus(ownerId, record);
    return ownerJson(withStatus, 200, responseHeaders);
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ folderId: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { folderId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const root = body as { plan?: unknown; allowDeleteGenerated?: unknown } | null;
  const candidate = normalizeMultiLessonPlan(root?.plan);
  if (!candidate.ok) return apiError('INVALID_REQUEST', 400, candidate.message);
  const allowDeleteGenerated = root?.allowDeleteGenerated === true;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const existing = await readMultiLessonCourse(ownerId, folderId);
    if (!existing) return ownerNotFound(responseHeaders);
    try {
      const result = await updateMultiLessonPlan(ownerId, existing, candidate.value, {
        allowDeleteGenerated,
      });
      const withStatus = await loadCourseWithStatus(ownerId, result.record);
      return ownerJson(withStatus, 200, responseHeaders);
    } catch (error) {
      if (error instanceof PlanEditConflictError) {
        return ownerJson(
          {
            error: {
              code: 'PLAN_EDIT_CONFLICT',
              message: error.message,
              conflicts: error.conflicts,
            },
          },
          409,
          responseHeaders,
        );
      }
      throw error;
    }
  });
}
