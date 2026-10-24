'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Save, Sparkles } from 'lucide-react';

import { OutlineEditor } from '@/components/multi-lesson/outline-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createCourse, generatePlan, MultiLessonApiError } from '@/lib/multi-lesson/client';
import { STRUCTURE_PHASES } from '@/lib/multi-lesson/ui';
import type { MultiLessonPlan } from '@/lib/server/multi-lesson/types';

export default function NewMultiLessonClient() {
  const router = useRouter();
  const [requirement, setRequirement] = useState('');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [lessonCount, setLessonCount] = useState(3);
  const [duration, setDuration] = useState(50);
  const [structure, setStructure] = useState<string[]>(STRUCTURE_PHASES.map((phase) => phase.key));
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MultiLessonPlan | null>(null);

  const toggleStructure = (key: string, checked: boolean) =>
    setStructure((current) =>
      checked ? [...current, key] : current.filter((item) => item !== key),
    );

  const handleGenerate = async () => {
    if (!requirement.trim()) {
      setError('请先填写教学需求');
      return;
    }
    setPlanning(true);
    setError(null);
    try {
      const { plan: generated } = await generatePlan({
        requirement,
        lessonCount,
        durationMinutes: duration,
        subject: subject.trim() || undefined,
        grade: grade.trim() || undefined,
        structure,
      });
      setPlan(generated);
    } catch (caught) {
      setError(
        caught instanceof MultiLessonApiError
          ? `大纲生成失败:${caught.message}`
          : '大纲生成失败,请重试',
      );
    } finally {
      setPlanning(false);
    }
  };

  const handleSave = async () => {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      const { course } = await createCourse(plan);
      router.push(`/multi-lesson/${course.folderId}`);
    } catch (caught) {
      setSaving(false);
      setError(caught instanceof Error ? caught.message : '保存失败');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/workspace')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">新建多课大纲</h1>
          <p className="text-sm text-muted-foreground">
            一次生成整个单元的课时大纲,确认后再逐课、逐页选择性生成课件
          </p>
        </div>
      </div>

      {!plan ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">教学需求</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              rows={6}
              placeholder={
                '例如:初中地理,围绕长江做一个 2 课时单元。学生要能在地图上指出源头、流经省区与入海口,理解上游/中游/下游的水文差异,完成一块流域科普展板。'
              }
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="学科(如:初中地理)"
              />
              <Input
                value={grade}
                onChange={(event) => setGrade(event.target.value)}
                placeholder="年级/学情(如:八年级)"
              />
            </div>
            <div className="flex flex-wrap items-end gap-6">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">课时数</span>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={lessonCount}
                  onChange={(event) =>
                    setLessonCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))
                  }
                  className="w-28"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">每课时长(分钟)</span>
                <Input
                  type="number"
                  min={20}
                  max={180}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value) || 50)}
                  className="w-28"
                />
              </label>
              <div className="space-y-1.5">
                <span className="text-sm text-muted-foreground">课堂环节</span>
                <div className="flex gap-3">
                  {STRUCTURE_PHASES.map((phase) => (
                    <label key={phase.key} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={structure.includes(phase.key)}
                        onCheckedChange={(checked) => toggleStructure(phase.key, Boolean(checked))}
                      />
                      {phase.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button onClick={handleGenerate} disabled={planning} className="w-full sm:w-auto">
              {planning ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 size-4" />
              )}
              {planning ? '正在生成大纲…' : '生成多课大纲'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <OutlineEditor plan={plan} onChange={setPlan} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setPlan(null)} disabled={saving}>
              返回修改需求
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Save className="mr-1 size-4" />
              )}
              保存大纲并开始选课
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
