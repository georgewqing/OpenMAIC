/**
 * POST /api/stages/:id/scenes/generate
 *
 * Generate (or regenerate) ONE page directly, without an agent session:
 * the multi-lesson outline UI and any server caller use this for selective
 * generation. Reuses the exact generation chain the agent tool uses:
 *
 *   generateSceneContent → generateSceneActions → buildCompleteScene → putScene
 *
 * Body:
 *   { order, type, title, brief, keyPoints?, instruction? (slide only),
 *     outlineId?, quizConfig?, widgetType?, widgetOutline?, pblConfig? }
 *
 * The call is intentionally NOT tied to the request's abort signal: a page
 * takes minutes on slow backends, so a client navigating away must not kill
 * the server-side generation (the caller reconciles via the manifest).
 */
import type { NextRequest } from 'next/server';

import {
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  type SceneContentFailureCode,
} from '@openmaic/generation';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { apiError } from '@/lib/server/api-response';
import {
  createGenerationAiCallFactory,
  sceneContentStage,
} from '@/lib/server/agent-runtime/generation-ai-call';
import { filterKnownActions } from '@/lib/server/agent-runtime/generation-tools';
import { putSceneBringingCurrent } from '@/lib/server/agent-runtime/document-writes';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerApiError, ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { runStageMutation } from '@/lib/server/agent-runtime/mutation-fence';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import type { SceneOutline } from '@/lib/types/generation';

export const runtime = 'nodejs';

const SUPPORTED = new Set(['slide', 'quiz', 'interactive', 'pbl']);
const WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);
const MAX_TITLE = 200;
const MAX_BRIEF = 8000;
const MAX_KEY_POINTS = 30;

function sceneIdFor(scenes: readonly { id: string }[], order: number): string {
  const preferred = `scene-p${order}`;
  const taken = new Set(scenes.map((scene) => scene.id));
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

interface GenerateBody {
  order: number;
  type: SceneOutline['type'];
  title: string;
  brief: string;
  keyPoints?: string[];
  instruction?: string;
  outlineId?: string;
  quizConfig?: SceneOutline['quizConfig'];
  widgetType?: SceneOutline['widgetType'];
  widgetOutline?: SceneOutline['widgetOutline'];
  pblConfig?: SceneOutline['pblConfig'];
}

function parseBody(
  value: unknown,
): { ok: true; body: GenerateBody } | { ok: false; message: string } {
  const body = value as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null)
    return { ok: false, message: 'body must be an object' };
  const order = body.order;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
    return { ok: false, message: 'order must be a positive integer' };
  }
  const type = body.type;
  if (typeof type !== 'string' || !SUPPORTED.has(type)) {
    return { ok: false, message: 'type must be slide | quiz | interactive | pbl' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!title) return { ok: false, message: 'title is required' };
  if (title.length > MAX_TITLE) return { ok: false, message: `title must be ≤ ${MAX_TITLE} chars` };
  if (!brief) return { ok: false, message: 'brief is required' };
  if (brief.length > MAX_BRIEF) return { ok: false, message: `brief must be ≤ ${MAX_BRIEF} chars` };

  const keyPoints = Array.isArray(body.keyPoints)
    ? body.keyPoints
        .filter((point): point is string => typeof point === 'string' && point.trim() !== '')
        .slice(0, MAX_KEY_POINTS)
        .map((point) => point.trim())
    : [];

  const parsed: GenerateBody = {
    order,
    type: type as GenerateBody['type'],
    title,
    brief,
    ...(keyPoints.length ? { keyPoints } : {}),
  };

  if (typeof body.outlineId === 'string' && body.outlineId.trim()) {
    parsed.outlineId = body.outlineId.trim();
  }
  if (typeof body.instruction === 'string' && body.instruction.trim()) {
    if (type !== 'slide') return { ok: false, message: 'instruction is only supported for slides' };
    parsed.instruction = body.instruction.trim();
  }
  if (type === 'interactive') {
    if (body.widgetType !== undefined) {
      if (typeof body.widgetType !== 'string' || !WIDGET_TYPES.has(body.widgetType)) {
        return { ok: false, message: 'widgetType must be one of the 5 supported widget types' };
      }
      parsed.widgetType = body.widgetType as GenerateBody['widgetType'];
    }
    if (body.widgetOutline !== undefined) {
      if (
        typeof body.widgetOutline !== 'object' ||
        body.widgetOutline === null ||
        Array.isArray(body.widgetOutline)
      ) {
        return { ok: false, message: 'widgetOutline must be a plain object' };
      }
      parsed.widgetOutline = body.widgetOutline as GenerateBody['widgetOutline'];
    }
    // Mirror generate_scene: bare widgetType gets a concept-shaped outline.
    if (parsed.widgetType && !parsed.widgetOutline) parsed.widgetOutline = { concept: title };
  } else if (body.widgetType !== undefined || body.widgetOutline !== undefined) {
    return { ok: false, message: 'widgetType/widgetOutline are only valid for interactive pages' };
  }
  if (type === 'quiz' && body.quizConfig && typeof body.quizConfig === 'object') {
    parsed.quizConfig = body.quizConfig as GenerateBody['quizConfig'];
  }
  if (type === 'pbl' && body.pblConfig && typeof body.pblConfig === 'object') {
    parsed.pblConfig = body.pblConfig as GenerateBody['pblConfig'];
  }
  return { ok: true, body: parsed };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id: stageId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const parsedBody = parseBody(raw);
  if (!parsedBody.ok) return apiError('INVALID_REQUEST', 400, parsedBody.message);
  const params2 = parsedBody.body;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const store = await getOwnerScopedDocumentStore(ownerId);
    const doc = await store.loadDocument(stageId);
    if (!doc) return ownerNotFound(responseHeaders);
    // Match the page by its stable outline id first: after a reorder, the
    // scene at this order may belong to a different outline entry, and
    // regenerating must replace the page the caller means, not that one.
    const existing =
      (params2.outlineId
        ? doc.scenes.find((scene) => scene.outlineId === params2.outlineId)
        : undefined) ?? doc.scenes.find((scene) => scene.order === params2.order);
    if (existing && !SUPPORTED.has(existing.type)) {
      return ownerApiError(
        'INVALID_REQUEST',
        422,
        `page ${params2.order} has unsupported type "${existing.type}" and was left unchanged`,
        responseHeaders,
      );
    }
    if (existing?.type === 'pbl' && params2.type !== 'pbl') {
      return ownerApiError(
        'INVALID_REQUEST',
        422,
        'a PBL page cannot change type; delete it first',
        responseHeaders,
      );
    }

    try {
      await assertWorkspaceModelsAuthorized(ownerId, [
        `course.content.${params2.type}` as 'course.content.slide',
        'course.actions',
      ]);
    } catch (error) {
      if (error instanceof ModelAuthorizationError) {
        return ownerApiError('PROVIDER_DISABLED', 403, error.message, responseHeaders);
      }
      throw error;
    }

    const outline: SceneOutline = {
      id: existing?.outlineId ?? params2.outlineId ?? `p${params2.order}`,
      order: params2.order,
      title: params2.title,
      type: params2.type,
      description: params2.brief,
      keyPoints: params2.keyPoints ?? [],
      ...(params2.quizConfig ? { quizConfig: params2.quizConfig } : {}),
      ...(params2.widgetType
        ? { widgetType: params2.widgetType, widgetOutline: params2.widgetOutline }
        : {}),
      ...(params2.pblConfig
        ? {
            pblConfig: {
              projectTopic: params2.pblConfig.projectTopic || params2.title,
              projectDescription: params2.pblConfig.projectDescription || params2.brief,
              targetSkills: params2.pblConfig.targetSkills?.length
                ? params2.pblConfig.targetSkills
                : (params2.keyPoints ?? []),
              ...(params2.pblConfig.issueCount !== undefined
                ? { issueCount: params2.pblConfig.issueCount }
                : {}),
              ...(params2.pblConfig.scenarioRoleplay
                ? { scenarioRoleplay: true, scenarioBrief: params2.pblConfig.scenarioBrief }
                : {}),
            },
          }
        : params2.type === 'pbl'
          ? {
              pblConfig: {
                projectTopic: params2.title,
                projectDescription: params2.brief,
                targetSkills: params2.keyPoints ?? [],
              },
            }
          : {}),
    };

    const baseline =
      params2.instruction && existing?.type === 'slide'
        ? {
            elements: existing.content.canvas.elements,
            background: existing.content.canvas.background,
          }
        : undefined;

    const aiCallFor = createGenerationAiCallFactory({ ownerId });
    let contentFailure: SceneContentFailureCode | undefined;
    let content: Awaited<ReturnType<typeof generateSceneContent>>;
    try {
      content = await generateSceneContent(outline, aiCallFor(sceneContentStage(params2.type)), {
        agents: doc.stage.generatedAgentConfigs,
        languageDirective: doc.stage.languageDirective ?? '',
        allowProceduralSkill: true,
        ...(params2.instruction ? { editDirective: params2.instruction } : {}),
        ...(baseline ? { baselineContent: baseline } : {}),
        onFailure: (failure) => {
          contentFailure = failure.code;
        },
      });
    } catch (error) {
      if (error instanceof PBLGenerationError) {
        return ownerApiError('GENERATION_FAILED', 502, error.message, responseHeaders);
      }
      throw error;
    }
    if (!content) {
      return ownerApiError(
        'GENERATION_FAILED',
        502,
        contentFailure === 'invalid-model-output'
          ? 'the model response could not be parsed into page content'
          : contentFailure === 'prompt-unavailable'
            ? 'the content prompt could not be prepared'
            : 'page content generation failed',
        responseHeaders,
        contentFailure,
      );
    }

    const actions = filterKnownActions(
      await generateSceneActions(outline, content, aiCallFor('scene-actions'), {
        agents: doc.stage.generatedAgentConfigs,
        languageDirective: doc.stage.languageDirective ?? '',
      }),
    );
    const built = buildCompleteScene(outline, content, actions, stageId, {
      sceneId: existing?.id ?? sceneIdFor(doc.scenes, params2.order),
    });
    if (!built) {
      return ownerApiError('GENERATION_FAILED', 502, 'page assembly failed', responseHeaders);
    }
    const scene = built as (typeof doc.scenes)[number];

    await runStageMutation(undefined, () => putSceneBringingCurrent(store, stageId, scene));

    // Keep the stage's outline snapshot canonical: replace the matching entry
    // (by stable outline id) or append the new plan entry at its order.
    const afterWrite = await store.loadDocument(stageId);
    const outlineSnapshot = afterWrite?.outline as AppDocumentOutline | undefined;
    if (afterWrite && outlineSnapshot) {
      const snapshot = outlineSnapshot.outlines ?? [];
      const rest = snapshot.filter((entry) => entry.id !== outline.id);
      const nextOutlines = [...rest, { ...outline }].sort((a, b) => a.order - b.order);
      const nextOutline: AppDocumentOutline = {
        ...outlineSnapshot,
        outlines: nextOutlines,
        updatedAt: Date.now(),
      };

      // The outline is authoritative for page order: a page regenerated after a
      // reorder takes its planned order, and no two scene rows may share one.
      const plannedOrder = new Map(nextOutlines.map((entry) => [entry.id, entry.order]));
      const used = new Set<number>();
      const scenes = afterWrite.scenes
        .map((item) => {
          const want = item.outlineId ? plannedOrder.get(item.outlineId) : undefined;
          return want !== undefined && want !== item.order ? { ...item, order: want } : item;
        })
        .sort((a, b) => a.order - b.order)
        .map((item) => {
          if (!used.has(item.order)) {
            used.add(item.order);
            return item;
          }
          let next = used.size + 1;
          while (used.has(next)) next += 1;
          used.add(next);
          return { ...item, order: next };
        });

      await store.saveDocument({
        stage: afterWrite.stage,
        scenes,
        outline: nextOutline,
      });
    }

    return ownerJson(
      { scene: { id: scene.id, order: scene.order, title: scene.title, type: scene.type } },
      200,
      responseHeaders,
    );
  });
}
