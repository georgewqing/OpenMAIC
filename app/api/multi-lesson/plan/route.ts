/**
 * POST /api/multi-lesson/plan
 *   { requirement, lessonCount?, subject?, grade?, durationMinutes?, structure? }
 * Generates (no persistence) a multi-lesson teaching plan through the
 * `course.outline` slot. The caller reviews/edits the plan before saving it
 * via POST /api/multi-lesson/courses.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  generateMultiLessonPlan,
  PlanGenerationError,
} from '@/lib/server/multi-lesson/generate-plan';
import { MAX_LESSONS } from '@/lib/server/multi-lesson/plan-schema';

export const runtime = 'nodejs';

const MAX_REQUIREMENT_CHARS = 20_000;
const STRUCTURE_KEYS = new Set(['review', 'lecture', 'practice', 'homework']);

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const value = body as Record<string, unknown> | null;
  if (typeof value !== 'object' || value === null) {
    return apiError('INVALID_REQUEST', 400, 'request body must be a JSON object');
  }
  const requirement = value.requirement;
  if (typeof requirement !== 'string' || !requirement.trim()) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'requirement is required');
  }
  if (requirement.length > MAX_REQUIREMENT_CHARS) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `requirement must be at most ${MAX_REQUIREMENT_CHARS} characters`,
    );
  }
  let lessonCount = 3;
  if (value.lessonCount !== undefined) {
    if (
      typeof value.lessonCount !== 'number' ||
      !Number.isInteger(value.lessonCount) ||
      value.lessonCount < 1 ||
      value.lessonCount > MAX_LESSONS
    ) {
      return apiError('INVALID_REQUEST', 400, `lessonCount must be 1..${MAX_LESSONS}`);
    }
    lessonCount = value.lessonCount;
  }
  let durationMinutes = 50;
  if (value.durationMinutes !== undefined) {
    if (
      typeof value.durationMinutes !== 'number' ||
      value.durationMinutes < 20 ||
      value.durationMinutes > 180
    ) {
      return apiError('INVALID_REQUEST', 400, 'durationMinutes must be 20..180');
    }
    durationMinutes = value.durationMinutes;
  }
  const optionalText = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key].trim()
      ? (value[key] as string).trim().slice(0, 200)
      : undefined;
  let structure: string[] | undefined;
  if (value.structure !== undefined) {
    if (!Array.isArray(value.structure) || !value.structure.every((k) => typeof k === 'string')) {
      return apiError('INVALID_REQUEST', 400, 'structure must be an array of phase keys');
    }
    structure = [...new Set(value.structure as string[])].filter((key) => STRUCTURE_KEYS.has(key));
    if (structure.length === 0) structure = undefined;
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      await assertWorkspaceModelsAuthorized(ownerId, ['course.outline']);
    } catch (error) {
      if (error instanceof ModelAuthorizationError) {
        return ownerApiError('PROVIDER_DISABLED', 403, error.message, responseHeaders);
      }
      throw error;
    }
    try {
      const plan = await generateMultiLessonPlan(ownerId, {
        requirement,
        lessonCount,
        durationMinutes,
        subject: optionalText('subject'),
        grade: optionalText('grade'),
        structure,
      });
      return ownerJson({ plan }, 200, responseHeaders);
    } catch (error) {
      if (error instanceof PlanGenerationError) {
        return ownerApiError('GENERATION_FAILED', 502, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
