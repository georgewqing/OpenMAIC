'use client';

/**
 * Type-specific generate / regenerate dialog.
 *
 * Common fields (title / brief / key points) plus per-type extras:
 *   slide       — optional edit instruction (partial regeneration)
 *   quiz        — question count / difficulty / question types
 *   interactive — widget kind + concept
 *   pbl         — project topic / target skills / issue count / role-play
 * On confirm it hands a ready-to-send GenerateSceneBody to the page.
 */
import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import type { GenerateSceneBody } from '@/lib/multi-lesson/client';
import {
  SCENE_TYPE_LABEL,
  WIDGET_KINDS,
  WIDGET_LABEL,
  asWidgetKind,
  buildWidgetOutline,
  type SceneType,
  type WidgetKind,
} from '@/lib/multi-lesson/ui';
import type { SceneOutline } from '@/lib/types/generation';

export interface RegenerateRequest {
  stageId: string;
  order: number;
  body: GenerateSceneBody;
}

export function RegenerateDialog({
  open,
  onOpenChange,
  stageId,
  order,
  outline,
  hasGenerated,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stageId: string;
  order: number;
  outline: SceneOutline;
  hasGenerated: boolean;
  busy?: boolean;
  onConfirm: (request: RegenerateRequest) => void;
}) {
  const [type, setType] = useState<SceneType>(outline.type);
  const [title, setTitle] = useState(outline.title);
  const [brief, setBrief] = useState(outline.description);
  const [keyPointsText, setKeyPointsText] = useState((outline.keyPoints ?? []).join('\n'));
  const [instruction, setInstruction] = useState('');
  const [widgetKind, setWidgetKind] = useState<WidgetKind>(
    outline.type === 'interactive' ? asWidgetKind(outline.widgetType) : 'simulation',
  );
  const [concept, setConcept] = useState(
    outline.type === 'interactive' ? String(outline.widgetOutline?.concept ?? outline.title) : '',
  );
  const [questionCount, setQuestionCount] = useState(outline.quizConfig?.questionCount ?? 3);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>(
    outline.quizConfig?.difficulty ?? 'medium',
  );
  const [questionTypes, setQuestionTypes] = useState<string[]>(
    outline.quizConfig?.questionTypes ?? ['single'],
  );
  const [targetSkillsText, setTargetSkillsText] = useState(
    (outline.pblConfig?.targetSkills ?? outline.keyPoints ?? []).join('\n'),
  );
  const [issueCount, setIssueCount] = useState(outline.pblConfig?.issueCount ?? 3);
  const [roleplay, setRoleplay] = useState(Boolean(outline.pblConfig?.scenarioRoleplay));
  const [scenarioBrief, setScenarioBrief] = useState(outline.pblConfig?.scenarioBrief ?? '');

  // State seeds from props at mount; the parent remounts the dialog per
  // page via a key, so no re-sync effect is needed.
  const keyPoints = keyPointsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const targetSkills = targetSkillsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const canSubmit = title.trim().length > 0 && brief.trim().length > 0 && !busy;

  const submit = () => {
    const body: GenerateSceneBody = {
      order,
      type,
      title: title.trim(),
      brief: brief.trim(),
      outlineId: outline.id,
      ...(keyPoints.length ? { keyPoints } : {}),
    };
    if (type === 'slide' && hasGenerated && instruction.trim()) {
      body.instruction = instruction.trim();
    }
    if (type === 'quiz') {
      body.quizConfig = {
        questionCount,
        difficulty,
        questionTypes: (questionTypes.length ? questionTypes : ['single']) as (
          | 'single'
          | 'multiple'
          | 'text'
        )[],
      };
    }
    if (type === 'interactive') {
      body.widgetType = widgetKind;
      body.widgetOutline = buildWidgetOutline(
        widgetKind,
        concept.trim() || title.trim(),
        keyPoints,
      );
    }
    if (type === 'pbl') {
      body.pblConfig = {
        projectTopic: title.trim(),
        projectDescription: brief.trim(),
        targetSkills,
        issueCount,
        ...(roleplay && scenarioBrief.trim()
          ? { scenarioRoleplay: true, scenarioBrief: scenarioBrief.trim() }
          : {}),
      };
    }
    onConfirm({ stageId, order, body });
  };

  const toggleQuestionType = (value: string, checked: boolean) => {
    setQuestionTypes((current) =>
      checked ? [...new Set([...current, value])] : current.filter((item) => item !== value),
    );
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {hasGenerated ? '重新生成' : '生成'}第 {order} 页 · {SCENE_TYPE_LABEL[type]}
          </DialogTitle>
          <DialogDescription>
            {hasGenerated
              ? '重新生成会整页替换当前内容,耗时可能数分钟。'
              : '按下面的设定生成这一页,耗时可能数分钟。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>页面类型</Label>
            <Select value={type} onValueChange={(value) => setType(value as SceneType)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SCENE_TYPE_LABEL) as SceneType[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {SCENE_TYPE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasGenerated && outline.type !== 'pbl' && type === 'pbl' && (
              <p className="text-xs text-destructive">PBL 页不能从其他类型转换,请先删除原页。</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>标题</Label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>教学意图(brief)</Label>
            <Textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={3}
              placeholder="这一页让学生学会什么、如何达成"
            />
          </div>

          <div className="space-y-1.5">
            <Label>内容要点(每行一条)</Label>
            <Textarea
              value={keyPointsText}
              onChange={(e) => setKeyPointsText(e.target.value)}
              rows={4}
            />
          </div>

          {type === 'slide' && hasGenerated && (
            <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
              <Label className="flex items-center gap-2">
                <Sparkles className="size-3.5" /> 局部修改指令(可选)
              </Label>
              <Textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                rows={2}
                placeholder="填写后只按指令在现有页面上改,不填则整页重新生成"
              />
            </div>
          )}

          {type === 'quiz' && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="space-y-1.5">
                <Label>题目数量</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={questionCount}
                  onChange={(event) => setQuestionCount(Number(event.target.value) || 1)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>难度</Label>
                <Select
                  value={difficulty}
                  onValueChange={(v) => setDifficulty(v as typeof difficulty)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">容易</SelectItem>
                    <SelectItem value="medium">中等</SelectItem>
                    <SelectItem value="hard">较难</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-2">
                <Label>题型</Label>
                <div className="flex gap-4">
                  {[
                    ['single', '单选'],
                    ['multiple', '多选'],
                    ['text', '简答'],
                  ].map(([value, label]) => (
                    <label key={value} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={questionTypes.includes(value)}
                        onCheckedChange={(checked) => toggleQuestionType(value, Boolean(checked))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {type === 'interactive' && (
            <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
              <div className="space-y-1.5">
                <Label>互动件形式</Label>
                <Select value={widgetKind} onValueChange={(v) => setWidgetKind(v as WidgetKind)}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WIDGET_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {WIDGET_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>核心概念</Label>
                <Input value={concept} onChange={(event) => setConcept(event.target.value)} />
              </div>
            </div>
          )}

          {type === 'pbl' && (
            <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>议题数</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={issueCount}
                    onChange={(event) => setIssueCount(Number(event.target.value) || 1)}
                  />
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <Checkbox checked={roleplay} onCheckedChange={(c) => setRoleplay(Boolean(c))} />
                  情景扮演
                </label>
              </div>
              {roleplay && (
                <div className="space-y-1.5">
                  <Label>情景简述</Label>
                  <Textarea
                    value={scenarioBrief}
                    onChange={(event) => setScenarioBrief(event.target.value)}
                    rows={2}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>目标技能(每行一条)</Label>
                <Textarea
                  value={targetSkillsText}
                  onChange={(event) => setTargetSkillsText(event.target.value)}
                  rows={3}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-4" />
            )}
            {hasGenerated ? '重新生成' : '开始生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
