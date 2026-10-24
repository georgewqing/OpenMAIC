/**
 * Generate a multi-lesson plan from a teacher's requirement.
 *
 * Model call uses the same `course.outline` slot as the classic outline step
 * (via the `scene-outlines-stream` LLM stage); the response is parsed
 * leniently (tolerating code fences) and then forced through the same strict
 * normalizer the API applies to browser edits.
 */
import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import { buildPrompt } from '@/lib/prompts';
import { createLogger } from '@/lib/logger';

import { normalizeMultiLessonPlan } from './plan-schema';
import type { MultiLessonPlan } from './types';

const log = createLogger('MultiLessonPlan');

export interface GeneratePlanInput {
  requirement: string;
  lessonCount?: number;
  subject?: string;
  grade?: string;
  durationMinutes?: number;
  /** Selected lesson phases; defaults to the full 回顾/讲解/练习/作业 rhythm. */
  structure?: string[];
}

export class PlanGenerationError extends Error {
  constructor(
    message: string,
    readonly code: 'empty-output' | 'invalid-json' | 'invalid-plan',
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PlanGenerationError';
  }
}

const STRUCTURE_LABELS: Record<string, string> = {
  review: '回顾/导入(激活旧知)',
  lecture: '讲解(新知建构,可含互动件)',
  practice: '练习(测验/互动游戏)',
  homework: '作业(课后任务;单元末课可放 PBL 项目)',
};

/** Pull a JSON object out of a model response, tolerating fences/prose. */
function extractJsonObject(text: string): unknown {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence) body = fence[1].trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last <= first) {
    throw new PlanGenerationError('model did not return a JSON object', 'invalid-json');
  }
  try {
    return JSON.parse(body.slice(first, last + 1));
  } catch (error) {
    throw new PlanGenerationError(
      'model returned unparseable JSON',
      'invalid-json',
      error instanceof Error ? error.message : undefined,
    );
  }
}

export async function generateMultiLessonPlan(
  ownerId: string,
  input: GeneratePlanInput,
): Promise<MultiLessonPlan> {
  const lessonCount = input.lessonCount ?? 3;
  const durationMinutes = input.durationMinutes ?? 50;
  const phases = (input.structure ?? ['review', 'lecture', 'practice', 'homework'])
    .map((key) => STRUCTURE_LABELS[key])
    .filter(Boolean)
    .join(' → ');

  const prompts = buildPrompt('multi-lesson-outline', {
    requirement: input.requirement,
    lessonCount: String(lessonCount),
    subject: input.subject?.trim() || '由教师需求推断',
    grade: input.grade?.trim() || '由教师需求推断',
    durationMinutes: String(durationMinutes),
    structureGuidance: phases || '回顾 → 讲解 → 练习 → 作业',
  });
  if (!prompts) {
    throw new PlanGenerationError('multi-lesson-outline prompt unavailable', 'empty-output');
  }

  const aiCall = createGenerationAiCallFactory({ ownerId });
  const raw = await aiCall('scene-outlines-stream')(prompts.system, prompts.user);
  if (!raw || !raw.trim()) {
    throw new PlanGenerationError('model returned an empty outline', 'empty-output');
  }

  const parsed = normalizeMultiLessonPlan(extractJsonObject(raw));
  if (!parsed.ok) {
    log.warn({ reason: parsed.message }, 'multi-lesson plan failed validation');
    throw new PlanGenerationError(
      `model plan failed validation: ${parsed.message}`,
      'invalid-plan',
      parsed.message,
    );
  }
  return parsed.value;
}
