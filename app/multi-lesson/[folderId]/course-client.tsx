'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Loader2,
  Pencil,
  PlayCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

import { OutlineEditor } from '@/components/multi-lesson/outline-editor';
import {
  RegenerateDialog,
  type RegenerateRequest,
} from '@/components/multi-lesson/regenerate-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  generateScene,
  getCourse,
  MultiLessonApiError,
  saveCoursePlan,
  type CourseWithStatus,
  type PlanEditConflict,
  type GenerateSceneBody,
} from '@/lib/multi-lesson/client';
import {
  SCENE_TYPE_COLOR,
  SCENE_TYPE_ICON,
  SCENE_TYPE_LABEL,
  WIDGET_LABEL,
  asWidgetKind,
  type SceneType,
} from '@/lib/multi-lesson/ui';
import type {
  MultiLessonPlan,
  LessonGenerationStatus,
  LessonPlan,
} from '@/lib/server/multi-lesson/types';
import type { SceneOutline } from '@/lib/types/generation';

const keyOf = (lessonId: string, order: number) => `${lessonId}:${order}`;

/** Build the single-page generation body from a planned outline entry. */
function bodyFromOutline(order: number, outline: SceneOutline): GenerateSceneBody {
  return {
    order,
    type: outline.type,
    title: outline.title,
    brief: outline.description || outline.title,
    outlineId: outline.id,
    ...(outline.keyPoints?.length ? { keyPoints: outline.keyPoints } : {}),
    ...(outline.quizConfig ? { quizConfig: outline.quizConfig } : {}),
    ...(outline.widgetType
      ? { widgetType: outline.widgetType, widgetOutline: outline.widgetOutline }
      : {}),
    ...(outline.pblConfig ? { pblConfig: outline.pblConfig } : {}),
  };
}

export default function CourseClient({ folderId }: { folderId: string }) {
  const router = useRouter();
  const [data, setData] = useState<CourseWithStatus | null>(null);
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await getCourse(folderId));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [folderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [busyLesson, setBusyLesson] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    stageId: string;
    order: number;
    outline: SceneOutline;
    hasGenerated: boolean;
  } | null>(null);

  const addGenerating = (key: string) => setGenerating((current) => new Set(current).add(key));
  const removeGenerating = (key: string) =>
    setGenerating((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });

  const runGeneration = useCallback(
    async (stageId: string, lessonId: string, body: GenerateSceneBody) => {
      const key = keyOf(lessonId, body.order);
      addGenerating(key);
      setNotice(null);
      try {
        await generateScene(stageId, body);
        await refresh();
      } catch (error) {
        setNotice(
          error instanceof MultiLessonApiError
            ? `第 ${body.order} 页生成失败:${error.message}`
            : `第 ${body.order} 页生成失败`,
        );
      } finally {
        removeGenerating(key);
      }
    },
    [refresh],
  );

  const generateLesson = async (
    lesson: LessonPlan,
    status: LessonGenerationStatus,
    stageId: string,
  ) => {
    if (!stageId || busyLesson) return;
    setBusyLesson(lesson.id);
    setNotice(null);
    for (const [index, sceneStatus] of status.scenes.entries()) {
      if (sceneStatus.status === 'generated') continue;
      const outline = lesson.scenes[index];
      if (!outline) continue;
      const key = keyOf(lesson.id, index + 1);
      addGenerating(key);
      try {
        await generateScene(stageId, bodyFromOutline(index + 1, outline));
        await refresh();
      } catch (error) {
        setNotice(
          error instanceof MultiLessonApiError
            ? `《${lesson.title}》第 ${index + 1} 页生成失败:${error.message}。可稍后点该页重试。`
            : `《${lesson.title}》生成中断,可从失败页继续`,
        );
        removeGenerating(key);
        break;
      }
      removeGenerating(key);
    }
    setBusyLesson(null);
  };

  // ── Outline editing ──────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<MultiLessonPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<PlanEditConflict[] | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const openEditor = () => {
    if (!data) return;
    setDraft(structuredClone(data.record.plan));
    setConflict(null);
    setEditorOpen(true);
  };

  const saveDraft = async (allowDeleteGenerated = false) => {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const updated = await saveCoursePlan(folderId, draft, allowDeleteGenerated);
      setData(updated);
      setEditorOpen(false);
      setConflict(null);
    } catch (error) {
      if (error instanceof MultiLessonApiError && error.status === 409 && error.conflicts?.length) {
        setConflict(error.conflicts);
        editorRef.current?.scrollIntoView({ behavior: 'smooth' });
      } else {
        setNotice(error instanceof Error ? error.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const conflictSummary = useMemo(() => {
    if (!conflict) return null;
    const pages = conflict.reduce((sum, item) => sum + item.sceneIds.length, 0);
    const lessons = conflict.filter((item) => item.kind === 'lesson-delete').length;
    return lessons > 0
      ? `本次修改将删除 ${conflictsLessonPages(conflict)} 个已生成页面和 ${lessons} 个课时`
      : `本次修改将删除 ${pages} 个已生成页面`;
  }, [conflict]);

  // Poll while anything is generating (cross-tab / recovery).
  useEffect(() => {
    if (generating.size === 0 && !busyLesson) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [generating.size, busyLesson, refresh]);

  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        {loadError ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-destructive">课程加载失败或不存在</p>
            <Button variant="outline" size="sm" onClick={() => router.push('/workspace')}>
              返回工作区
            </Button>
          </div>
        ) : (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  const plan = data.record.plan;
  const stageByLesson = new Map(
    data.record.lessonStages.map((binding) => [binding.lessonId, binding.stageId]),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/workspace">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{plan.courseTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {[plan.subject, plan.grade].filter(Boolean).join(' · ')} · {plan.lessons.length} 课时
          </p>
        </div>
        <Button variant="outline" onClick={openEditor}>
          <Pencil className="mr-1 size-4" /> 编辑大纲
        </Button>
        <Button variant="outline" asChild>
          <Link href="/multi-lesson/new">
            <Sparkles className="mr-1 size-4" /> 新建单元
          </Link>
        </Button>
      </div>

      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {data.lessons.map((status, lessonIndex) => {
        const lesson = plan.lessons.find((item) => item.id === status.lessonId);
        if (!lesson) return null;
        const stageId = stageByLesson.get(lesson.id) ?? status.stageId;
        const pending = status.scenes.filter((scene) => scene.status !== 'generated').length;
        const percent = status.total ? Math.round((status.generated / status.total) * 100) : 0;
        const lessonBusy = busyLesson === lesson.id;
        return (
          <section key={lesson.id} className="rounded-xl border bg-card shadow-sm">
            <div className="space-y-2 border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  第{lessonIndex + 1}课
                </span>
                <h2 className="min-w-0 flex-1 truncate font-medium">{lesson.title}</h2>
                <span className="text-xs text-muted-foreground">
                  {status.generated}/{status.total} 页
                  {status.stale > 0 ? ` · ${status.stale} 页待更新` : ''}
                </span>
                <Button
                  size="sm"
                  disabled={pending === 0 || lessonBusy || !stageId}
                  onClick={() => void generateLesson(lesson, status, stageId)}
                >
                  {lessonBusy ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <PlayCircle className="mr-1 size-3.5" />
                  )}
                  {status.generated === 0 ? '生成本课' : '继续生成'}
                </Button>
                {stageId && (
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/classroom/${stageId}`} target="_blank">
                      <ExternalLink className="mr-1 size-3.5" /> 打开课堂
                    </Link>
                  </Button>
                )}
              </div>
              <Progress value={percent} className="h-1.5" />
              {lesson.teachingObjective && (
                <p className="text-xs text-muted-foreground">{lesson.teachingObjective}</p>
              )}
            </div>

            <div className="divide-y">
              {lesson.scenes.map((outline, sceneIndex) => {
                const order = sceneIndex + 1;
                const sceneStatus = status.scenes[sceneIndex];
                const state = sceneStatus?.status ?? 'planned';
                const isGenerating = generating.has(keyOf(lesson.id, order));
                const Icon = SCENE_TYPE_ICON[outline.type];
                return (
                  <div key={outline.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
                      {order}
                    </span>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                        SCENE_TYPE_COLOR[outline.type as SceneType],
                      )}
                    >
                      <Icon className="size-3" />
                      {SCENE_TYPE_LABEL[outline.type as SceneType]}
                    </span>
                    {outline.type === 'interactive' && outline.widgetType && (
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
                        {WIDGET_LABEL[asWidgetKind(outline.widgetType)]}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{outline.title}</span>
                    <StatusBadge state={state} spinning={isGenerating} />
                    <Button
                      size="sm"
                      variant={state === 'planned' ? 'default' : 'outline'}
                      disabled={isGenerating}
                      onClick={() =>
                        setDialog({
                          stageId,
                          order,
                          outline,
                          hasGenerated: state === 'generated' || state === 'stale',
                        })
                      }
                    >
                      {isGenerating ? (
                        <Loader2 className="mr-1 size-3.5 animate-spin" />
                      ) : state === 'planned' ? (
                        <Sparkles className="mr-1 size-3.5" />
                      ) : (
                        <RefreshCw className="mr-1 size-3.5" />
                      )}
                      {state === 'planned' ? '生成' : '重新生成'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {dialog && (
        <RegenerateDialog
          key={`${dialog.stageId}:${dialog.order}`}
          open={Boolean(dialog)}
          onOpenChange={(open) => !open && setDialog(null)}
          stageId={dialog.stageId}
          order={dialog.order}
          outline={dialog.outline}
          hasGenerated={dialog.hasGenerated}
          busy={generating.has(
            keyOf(
              data.lessons.find((lesson) => lesson.stageId === dialog.stageId)?.lessonId ?? '',
              dialog.order,
            ),
          )}
          onConfirm={(request: RegenerateRequest) => {
            const lesson = data.lessons.find((item) => item.stageId === request.stageId);
            if (!lesson) return;
            setDialog(null);
            void runGeneration(request.stageId, lesson.lessonId, request.body);
          }}
        />
      )}

      <Dialog open={editorOpen} onOpenChange={(open) => !saving && setEditorOpen(open)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑单元大纲</DialogTitle>
            <DialogDescription>
              改完保存后生效;已生成页面的类型变化会标记为「待更新」,需要重新生成该页。
            </DialogDescription>
          </DialogHeader>
          <div ref={editorRef}>{draft && <OutlineEditor plan={draft} onChange={setDraft} />}</div>
          {conflict && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <p className="font-medium">{conflictSummary}</p>
              <p className="mt-1 text-xs">删除后不可恢复。确认要继续吗?</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </Button>
            {conflict ? (
              <Button variant="destructive" onClick={() => void saveDraft(true)} disabled={saving}>
                {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                确认删除并保存
              </Button>
            ) : (
              <Button onClick={() => void saveDraft(false)} disabled={saving}>
                {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                保存大纲
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function conflictsLessonPages(conflicts: PlanEditConflict[]): number {
  // Lesson-delete conflicts already carry every generated page id.
  return conflicts.reduce((sum, item) => sum + item.sceneIds.length, 0);
}

function StatusBadge({
  state,
  spinning,
}: {
  state: 'planned' | 'generated' | 'stale';
  spinning: boolean;
}) {
  if (spinning) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> 生成中
      </span>
    );
  }
  if (state === 'generated') {
    return (
      <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-300">
        已生成
      </span>
    );
  }
  if (state === 'stale') {
    return (
      <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
        待更新
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      未生成
    </span>
  );
}
