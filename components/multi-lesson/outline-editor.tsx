'use client';

/**
 * Editable tree of a multi-lesson plan: course fields on top, then one card
 * per lesson, each listing its planned pages. Pure controlled component —
 * persistence and generation are the page's concern.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Layers, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { changeOutlineType } from '@/lib/multi-lesson/outline-type';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { MultiLessonPlan, LessonPlan } from '@/lib/server/multi-lesson/types';
import type { SceneOutline } from '@/lib/types/generation';
import {
  SCENE_TYPES,
  SCENE_TYPE_LABEL,
  SCENE_TYPE_COLOR,
  SCENE_TYPE_ICON,
  WIDGET_KINDS,
  WIDGET_LABEL,
  asWidgetKind,
  buildWidgetOutline,
  type SceneType,
  type WidgetKind,
} from '@/lib/multi-lesson/ui';

function newScene(type: SceneType = 'slide', order: number): SceneOutline {
  const base: SceneOutline = {
    id: `p-${nanoid(8)}`,
    type,
    title: type === 'slide' ? '新页面' : SCENE_TYPE_LABEL[type] + '页',
    description: '',
    keyPoints: [],
    order,
  };
  if (type === 'interactive') {
    base.widgetType = 'simulation';
    base.widgetOutline = { concept: base.title };
  }
  if (type === 'quiz') {
    base.quizConfig = { questionCount: 3, difficulty: 'medium', questionTypes: ['single'] };
  }
  return base;
}

function newLesson(index: number): LessonPlan {
  return {
    id: `lesson-${nanoid(8)}`,
    title: `第${index + 1}课 新课时`,
    estimatedDuration: 50,
    scenes: [newScene('slide', 1)],
  };
}

export interface OutlineEditorProps {
  plan: MultiLessonPlan;
  onChange: (plan: MultiLessonPlan) => void;
  /** Hide course-level fields when the course already exists. */
  lockCourseTitle?: boolean;
  compact?: boolean;
}

export function OutlineEditor({ plan, onChange, lockCourseTitle, compact }: OutlineEditorProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openLessons, setOpenLessons] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(plan.lessons.map((lesson) => [lesson.id, true])),
  );

  const patchPlan = (patch: Partial<MultiLessonPlan>) => onChange({ ...plan, ...patch });

  const updateLesson = (lessonId: string, patch: Partial<LessonPlan>) =>
    patchPlan({
      lessons: plan.lessons.map((lesson) =>
        lesson.id === lessonId ? { ...lesson, ...patch } : lesson,
      ),
    });

  const moveLesson = (index: number, delta: number) => {
    const next = [...plan.lessons];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    patchPlan({ lessons: next });
  };

  const addLesson = () => patchPlan({ lessons: [...plan.lessons, newLesson(plan.lessons.length)] });

  const removeLesson = (lessonId: string) =>
    patchPlan({ lessons: plan.lessons.filter((lesson) => lesson.id !== lessonId) });

  const updateScene = (lessonId: string, sceneId: string, patch: Partial<SceneOutline>) =>
    updateLesson(lessonId, {
      scenes: plan.lessons
        .find((lesson) => lesson.id === lessonId)!
        .scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)),
    });

  const changeType = (
    lessonId: string,
    scene: SceneOutline,
    type: SceneType,
    widget?: WidgetKind,
  ) => {
    let next = changeOutlineType(scene, type);
    if (type === 'interactive') {
      const kind: WidgetKind = widget ?? asWidgetKind(scene.widgetType);
      next = {
        ...next,
        widgetType: kind,
        widgetOutline:
          scene.widgetType === kind
            ? scene.widgetOutline
            : buildWidgetOutline(kind, scene.title, scene.keyPoints),
      };
    }
    updateScene(lessonId, scene.id, next);
  };

  const changeWidget = (lessonId: string, scene: SceneOutline, widget: WidgetKind) =>
    changeType(lessonId, scene, 'interactive', widget);

  const addScene = (lessonId: string) =>
    updateLesson(lessonId, {
      scenes: [
        ...plan.lessons.find((lesson) => lesson.id === lessonId)!.scenes,
        newScene('slide', plan.lessons.find((lesson) => lesson.id === lessonId)!.scenes.length + 1),
      ],
    });

  const removeScene = (lessonId: string, sceneId: string) =>
    updateLesson(lessonId, {
      scenes: plan.lessons
        .find((lesson) => lesson.id === lessonId)!
        .scenes.filter((scene) => scene.id !== sceneId)
        .map((scene, index) => ({ ...scene, order: index + 1 })),
    });

  const moveScene = (lessonId: string, index: number, delta: number) => {
    const lesson = plan.lessons.find((item) => item.id === lessonId)!;
    const target = index + delta;
    if (target < 0 || target >= lesson.scenes.length) return;
    const scenes = [...lesson.scenes];
    [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
    updateLesson(lessonId, { scenes: scenes.map((scene, i) => ({ ...scene, order: i + 1 })) });
  };

  const courseHeader = useMemo(
    () => (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Layers className="size-4" />
          单元课程
        </div>
        <Input
          value={plan.courseTitle}
          disabled={lockCourseTitle}
          onChange={(event) => patchPlan({ courseTitle: event.target.value })}
          placeholder="单元标题,如:长江之歌"
          className="h-10 text-base font-medium"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            value={plan.subject ?? ''}
            onChange={(event) => patchPlan({ subject: event.target.value })}
            placeholder="学科(如:初中地理)"
          />
          <Input
            value={plan.grade ?? ''}
            onChange={(event) => patchPlan({ grade: event.target.value })}
            placeholder="年级/学情"
          />
        </div>
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, lockCourseTitle],
  );

  return (
    <div className="space-y-5">
      {courseHeader}

      {plan.lessons.map((lesson, lessonIndex) => {
        const open = openLessons[lesson.id] ?? true;
        return (
          <div key={lesson.id} className="rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <button
                type="button"
                onClick={() => setOpenLessons((s) => ({ ...s, [lesson.id]: !open }))}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                aria-label="toggle lesson"
              >
                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
              <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                第{lessonIndex + 1}课
              </span>
              <Input
                value={lesson.title}
                onChange={(event) => updateLesson(lesson.id, { title: event.target.value })}
                className="h-8 flex-1 border-transparent bg-transparent font-medium hover:border-input focus:border-input"
              />
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {lesson.scenes.length} 页
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={lessonIndex === 0}
                  onClick={() => moveLesson(lessonIndex, -1)}
                  title="上移"
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={lessonIndex === plan.lessons.length - 1}
                  onClick={() => moveLesson(lessonIndex, 1)}
                  title="下移"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive"
                  onClick={() => removeLesson(lesson.id)}
                  title="删除本课"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            {open && (
              <div className="space-y-3 px-4 py-3">
                <Input
                  value={lesson.teachingObjective ?? ''}
                  onChange={(event) =>
                    updateLesson(lesson.id, { teachingObjective: event.target.value })
                  }
                  placeholder="本课教学目标(可选)"
                  className="h-8 text-sm"
                />
                <div className="space-y-2">
                  {lesson.scenes.map((scene, sceneIndex) => {
                    const isExpanded = expanded[scene.id] ?? false;
                    const Icon = SCENE_TYPE_ICON[scene.type];
                    return (
                      <div key={scene.id} className="rounded-lg border bg-background/60 p-2.5">
                        <div className="flex items-center gap-2">
                          <TypeMenu
                            scene={scene}
                            onType={(type) => changeType(lesson.id, scene, type)}
                            onWidget={(widget) => changeWidget(lesson.id, scene, widget)}
                            icon={Icon}
                          />
                          <Input
                            value={scene.title}
                            onChange={(event) =>
                              updateScene(lesson.id, scene.id, { title: event.target.value })
                            }
                            className="h-8 flex-1 border-transparent bg-transparent hover:border-input focus:border-input"
                          />
                          {scene.type === 'interactive' && scene.widgetType && (
                            <span className="hidden shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 md:inline dark:text-emerald-300">
                              {WIDGET_LABEL[asWidgetKind(scene.widgetType)]}
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => setExpanded((s) => ({ ...s, [scene.id]: !isExpanded }))}
                            title="详情"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={sceneIndex === 0}
                            onClick={() => moveScene(lesson.id, sceneIndex, -1)}
                            title="上移"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={sceneIndex === lesson.scenes.length - 1}
                            onClick={() => moveScene(lesson.id, sceneIndex, 1)}
                            title="下移"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive"
                            onClick={() => removeScene(lesson.id, scene.id)}
                            title="删除本页"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                        {isExpanded && (
                          <div className="mt-2 space-y-2 pl-1">
                            <Textarea
                              value={scene.description}
                              onChange={(event) =>
                                updateScene(lesson.id, scene.id, {
                                  description: event.target.value,
                                })
                              }
                              placeholder="本页教学意图(brief):这一页要让学生学会什么、如何达成"
                              rows={2}
                              className="text-sm"
                            />
                            <Textarea
                              value={(scene.keyPoints ?? []).join('\n')}
                              onChange={(event) =>
                                updateScene(lesson.id, scene.id, {
                                  keyPoints: event.target.value
                                    .split('\n')
                                    .map((line) => line.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="内容要点,每行一条(3-5 条)"
                              rows={3}
                              className="text-sm"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Button variant="outline" size="sm" onClick={() => addScene(lesson.id)}>
                  <Plus className="mr-1 size-3.5" /> 添加页面
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {!compact && (
        <Button variant="outline" onClick={addLesson} className="w-full border-dashed">
          <Plus className="mr-1 size-4" /> 添加一课
        </Button>
      )}
    </div>
  );
}

function TypeMenu({
  scene,
  onType,
  onWidget,
  icon: Icon,
}: {
  scene: SceneOutline;
  onType: (type: SceneType) => void;
  onWidget: (widget: WidgetKind) => void;
  icon: (typeof SCENE_TYPE_ICON)[SceneType];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
            SCENE_TYPE_COLOR[scene.type],
          )}
        >
          <Icon className="size-3.5" />
          {SCENE_TYPE_LABEL[scene.type]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>页面类型</DropdownMenuLabel>
        {SCENE_TYPES.map((type) => {
          const TypeIcon = SCENE_TYPE_ICON[type];
          return (
            <DropdownMenuItem key={type} onSelect={() => onType(type)}>
              <TypeIcon className="mr-2 size-3.5" />
              {SCENE_TYPE_LABEL[type]}
            </DropdownMenuItem>
          );
        })}
        {scene.type === 'interactive' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>互动件形式</DropdownMenuLabel>
            {WIDGET_KINDS.map((widget) => (
              <DropdownMenuItem key={widget} onSelect={() => onWidget(widget)}>
                {WIDGET_LABEL[widget]}
                {scene.widgetType === widget ? ' ✓' : ''}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
