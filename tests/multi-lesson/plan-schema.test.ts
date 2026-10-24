import { describe, expect, it } from 'vitest';

import {
  MAX_LESSONS,
  normalizeMultiLessonPlan,
  reconcileLessonScenes,
} from '@/lib/server/multi-lesson/plan-schema';
import type { SceneOutline } from '@/lib/types/generation';

function slideScene(id: string, title = id): SceneOutline {
  return { id, type: 'slide', title, description: `${title} desc`, keyPoints: [], order: 0 };
}

describe('normalizeMultiLessonPlan', () => {
  it('normalizes a minimal valid plan and assigns defaults', () => {
    const result = normalizeMultiLessonPlan({
      courseTitle: '长江之歌',
      lessons: [{ title: '第1课 长江从哪里来', scenes: [slideScene('p1'), slideScene('p2')] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lessons).toHaveLength(1);
    expect(result.value.lessons[0].id).toBe('lesson-1');
    expect(result.value.lessons[0].scenes.map((s) => s.order)).toEqual([1, 2]);
  });

  it('rejects missing or blank courseTitle', () => {
    expect(normalizeMultiLessonPlan({ courseTitle: ' ', lessons: [] }).ok).toBe(false);
  });

  it('rejects empty lesson list and too many lessons', () => {
    expect(normalizeMultiLessonPlan({ courseTitle: 'x', lessons: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_LESSONS + 1 }, (_, i) => ({
      title: `L${i}`,
      scenes: [slideScene('p1')],
    }));
    expect(normalizeMultiLessonPlan({ courseTitle: 'x', lessons: many }).ok).toBe(false);
  });

  it('rejects a lesson without title or scenes', () => {
    const noTitle = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [{ scenes: [slideScene('p1')] }],
    });
    expect(noTitle.ok).toBe(false);
    const noScenes = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [{ title: 'L1' }],
    });
    expect(noScenes.ok).toBe(false);
  });

  it('defaults missing scene ids to p<position> and orders by list position', () => {
    const result = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [
        {
          title: 'L1',
          scenes: [
            { type: 'slide', title: 'A', description: 'd', keyPoints: [] },
            { id: 'custom', type: 'quiz', title: 'B', description: 'd', keyPoints: [], order: 99 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scenes = result.value.lessons[0].scenes;
    expect(scenes.map((s) => s.id)).toEqual(['p1', 'custom']);
    expect(scenes.map((s) => s.order)).toEqual([1, 2]);
  });

  it('rejects a scene without a type', () => {
    const result = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [
        { title: 'L1', scenes: [{ id: 'p1', title: 'A', description: 'd', keyPoints: [] }] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate lesson ids', () => {
    const result = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [
        { id: 'same', title: 'A', scenes: [slideScene('p1')] },
        { id: 'same', title: 'B', scenes: [slideScene('p1')] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('keeps interactive widgetType through normalization', () => {
    const result = normalizeMultiLessonPlan({
      courseTitle: 'x',
      lessons: [
        {
          title: 'L1',
          scenes: [
            {
              id: 'p1',
              type: 'interactive',
              title: '图',
              description: 'd',
              keyPoints: [],
              widgetType: 'diagram',
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lessons[0].scenes[0].widgetType).toBe('diagram');
  });
});

describe('reconcileLessonScenes', () => {
  const planned = (): SceneOutline[] => [
    slideScene('p1', '回顾'),
    { id: 'p2', type: 'quiz', title: '练习', description: 'd', keyPoints: [], order: 2 },
  ];

  it('marks all scenes planned when nothing is generated', () => {
    const diff = reconcileLessonScenes(planned(), []);
    expect(diff.planned.map((p) => p.outlineId)).toEqual(['p1', 'p2']);
    expect(diff.keep).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  it('matches generated scenes by outline id and tracks their new order', () => {
    const reordered = [...planned()].reverse();
    const diff = reconcileLessonScenes(reordered, [
      { sceneId: 'scene-p1', outlineId: 'p1', order: 1, type: 'slide', title: '回顾' },
      { sceneId: 'scene-p2', outlineId: 'p2', order: 2, type: 'quiz', title: '练习' },
    ]);
    expect(diff.keep.map((k) => [k.outlineId, k.order])).toEqual([
      ['p2', 1],
      ['p1', 2],
    ]);
    expect(diff.stale).toEqual([]);
  });

  it('flags type drift as stale', () => {
    const diff = reconcileLessonScenes(planned(), [
      { sceneId: 'scene-p2', outlineId: 'p2', order: 2, type: 'slide', title: '练习' },
    ]);
    expect(diff.stale).toEqual([{ sceneId: 'scene-p2', outlineId: 'p2', order: 2 }]);
    expect(diff.planned.map((p) => p.outlineId)).toEqual(['p1']);
  });

  it('removes generated scenes whose outline entry disappeared', () => {
    const diff = reconcileLessonScenes([slideScene('p1')], [
      { sceneId: 'scene-p2', outlineId: 'p2', order: 2, type: 'quiz', title: '旧页' },
    ]);
    expect(diff.remove).toEqual([{ sceneId: 'scene-p2', outlineId: 'p2' }]);
  });
});
