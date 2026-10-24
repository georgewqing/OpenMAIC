/**
 * /api/multi-lesson/courses
 *   GET  — list the caller's multi-lesson courses (folder index rows)
 *   POST { plan } — validate a plan and materialize it as a folder containing
 *          one outline-only stage per lesson. No LLM work happens here.
 */
import type { NextRequest } from 'next/server';

import { isDocumentWriteRefusedError } from '@openmaic/storage';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { createMultiLessonCourse } from '@/lib/server/multi-lesson/courses';
import { listMultiLessonCourses } from '@/lib/server/multi-lesson/persistence';
import { normalizeMultiLessonPlan } from '@/lib/server/multi-lesson/plan-schema';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const courses = await listMultiLessonCourses(ownerId);
    return ownerJson({ courses }, 200, responseHeaders);
  });
}

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const candidate = normalizeMultiLessonPlan((body as { plan?: unknown } | null)?.plan ?? body);
  if (!candidate.ok) return apiError('INVALID_REQUEST', 400, candidate.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { record } = await createMultiLessonCourse(ownerId, candidate.value);
      return ownerJson({ course: record }, 201, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      if (isDocumentWriteRefusedError(error)) {
        return ownerApiError('CREATE_REFUSED', 403, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
