/**
 * Presentation constants for the multi-lesson feature (Chinese-first labels;
 * type colors mirror components/generation/outlines-editor.tsx TYPE_THEME).
 */
import type { SceneOutline } from '@/lib/types/generation';
import { BookOpen, Cpu, MousePointer2, PieChart, type LucideIcon } from 'lucide-react';

export type SceneType = SceneOutline['type'];

export const SCENE_TYPES: SceneType[] = ['slide', 'quiz', 'interactive', 'pbl'];

export const SCENE_TYPE_LABEL: Record<SceneType, string> = {
  slide: '幻灯片',
  quiz: '测验',
  interactive: '互动',
  pbl: '项目式',
};

export const SCENE_TYPE_COLOR: Record<SceneType, string> = {
  slide: 'bg-blue-500/10 text-blue-600 dark:text-blue-300 border-blue-500/30',
  quiz: 'bg-purple-500/10 text-purple-600 dark:text-purple-300 border-purple-500/30',
  interactive: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
  pbl: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
};

export const SCENE_TYPE_ICON: Record<SceneType, LucideIcon> = {
  slide: BookOpen,
  quiz: PieChart,
  interactive: MousePointer2,
  pbl: Cpu,
};

/** The five user-selectable widget kinds (procedural-skill is task-engine only). */
export type WidgetKind = 'simulation' | 'diagram' | 'code' | 'game' | 'visualization3d';

export const WIDGET_KINDS: WidgetKind[] = [
  'simulation',
  'diagram',
  'code',
  'game',
  'visualization3d',
];

export const WIDGET_LABEL: Record<WidgetKind, string> = {
  simulation: '仿真模拟',
  diagram: '图示/流程图',
  code: '代码挑战',
  game: '游戏',
  visualization3d: '3D 可视化',
};

export const STRUCTURE_PHASES = [
  { key: 'review', label: '回顾/导入' },
  { key: 'lecture', label: '讲解' },
  { key: 'practice', label: '练习' },
  { key: 'homework', label: '作业' },
] as const;

/** Coerce a DSL widgetType to the five user-selectable kinds. */
export function asWidgetKind(value: SceneOutline['widgetType'] | undefined): WidgetKind {
  return value && WIDGET_KINDS.includes(value as WidgetKind) ? (value as WidgetKind) : 'simulation';
}

/** Build a minimal valid widgetOutline for a kind from a concept line. */
export function buildWidgetOutline(
  kind: WidgetKind,
  concept: string,
  keyPoints: string[],
): SceneOutline['widgetOutline'] {
  const topic = concept || keyPoints[0] || '';
  switch (kind) {
    case 'simulation':
      return { concept: topic, keyVariables: keyPoints.slice(0, 4) };
    case 'diagram':
      return { diagramType: 'flowchart', concept: topic };
    case 'code':
      return { language: 'python', challengeType: concept || 'coding', concept: topic };
    case 'game':
      return { gameType: 'quiz', challenge: concept || topic, concept: topic };
    case 'visualization3d':
      return { visualizationType: 'custom', concept: topic, objects: [], interactions: [] };
  }
}
