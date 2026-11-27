import { stripBuyerQuestionWrapper } from '../../src/domain/adaptive-push';
import {
  buildFlexibleBuyerMessages,
  buildWaitingNudge,
  computeFlexiblePushDelayMs,
  findProactivelyAnsweredSeqs,
  shuffleFlexibleQuestions,
} from '../../src/domain/flexible-push';
import { ScriptQuestion } from '../../src/domain/types';

describe('flexible-push', () => {
  it('shuffles independent questions while preserving dependent slots and derivedFromSeq pointers', () => {
    const questions: ScriptQuestion[] = [
      { seq: 1, question: '面料是什么？', keyPoints: [], sourceType: 'core' },
      { seq: 2, question: '会缩水吗？', keyPoints: [], sourceType: 'core' },
      { seq: 3, question: '什么时候发货？', keyPoints: [], sourceType: 'core' },
      { seq: 4, question: '尺码偏大吗？', keyPoints: [], sourceType: 'core' },
      { seq: 5, question: '需要转人工核实', keyPoints: [], sourceType: 'core', needTransfer: true },
    ];

    const shuffled = shuffleFlexibleQuestions(questions, 20261127);
    expect(shuffled.map((q) => q.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(shuffled[4].question).toBe('需要转人工核实');
    expect(shuffled.map((q) => q.question).sort()).toEqual(questions.map((q) => q.question).sort());
  });

  it('strips all flexible prefixes and suffixes back to the core question for judgment accuracy', () => {
    const core = '实物和详情页图片色差大吗？';
    const styles = ['friendly', 'hesitant', 'direct', 'impatient', 'silent'];
    for (const style of styles) {
      for (let seed = 1; seed <= 20; seed += 1) {
        for (const transition of [false, true]) {
          const { primary } = buildFlexibleBuyerMessages(core, style, transition, seed * 13, true);
          const stripped = stripBuyerQuestionWrapper(primary).replace(/[？?]$/u, '');
          expect(stripped).toBe(core.replace(/[？?]$/u, ''));
        }
      }
    }
  });

  it('paces impatient buyers faster than hesitant buyers within bounded range', () => {
    let impatientSum = 0;
    let hesitantSum = 0;
    for (let i = 1; i <= 20; i += 1) {
      const imp = computeFlexiblePushDelayMs([3, 7], 'impatient', i * 17);
      const hes = computeFlexiblePushDelayMs([3, 7], 'hesitant', i * 17);
      expect(imp >= 1200 && imp <= 12000).toBe(true);
      expect(hes >= 1200 && hes <= 12000).toBe(true);
      impatientSum += imp;
      hesitantSum += hes;
    }
    expect(impatientSum).toBeLessThan(hesitantSum);
  });

  it('detects proactively answered upcoming questions without skipping transfer questions', () => {
    const questions: ScriptQuestion[] = [
      { seq: 1, question: '面料是什么？', keyPoints: [] },
      { seq: 2, question: '支持七天无理由退货吗？', keyPoints: [] },
      { seq: 3, question: '尺码偏大吗？', keyPoints: [] },
      { seq: 4, question: '需要转接专员处理退货', keyPoints: [], needTransfer: true },
    ];
    const skipped = findProactivelyAnsweredSeqs(questions, 1, [], [
      '亲，这款是棉混纺面料，标准正码不偏大不偏小，支持7天无理由退换且有运费险哦。',
    ]);
    expect(skipped).toEqual([2, 3]);
  });

  it('builds non-empty waiting nudges for all styles', () => {
    for (const style of ['friendly', 'hesitant', 'direct', 'impatient', 'silent']) {
      expect(buildWaitingNudge(style, 42).length).toBeGreaterThan(0);
    }
  });
});
