import { describe, expect, it } from 'vitest';
import { semanticQuestionsToRows, semanticRowsToGoalsBySeq } from './SemanticGoalBuilder';

describe('semantic goal form conversion', () => {
  it('converts plain form fields into backend targets and generates ids', () => {
    const bySeq = semanticRowsToGoalsBySeq([{
      seq: 2,
      name: '说明尺码正常',
      points: [{
        label: '尺码不偏大',
        matchAny: ['标准尺码', ' 尺码正常 '],
        mustIncludeAny: ['尺码', 'M码'],
        mustExclude: ['偏大很多'],
      }],
      riskRules: [{ label: '承诺无条件退货', matchAny: ['肯定可以退'], penalty: 20 }],
    }]);

    expect(bySeq['2']).toHaveLength(1);
    expect(bySeq['2'][0]).toMatchObject({
      id: 'goal-2-1',
      name: '说明尺码正常',
      requiredPoints: [{
        id: 'point-2-1-1',
        label: '尺码不偏大',
        matchAny: ['标准尺码', '尺码正常'],
        businessRules: { mustIncludeAny: ['尺码', 'M码'], mustExclude: ['偏大很多'] },
      }],
      riskRules: [{ id: 'risk-2-1-1', label: '承诺无条件退货', matchAny: ['肯定可以退'], penalty: 20 }],
    });
  });

  it('loads existing goals into editable fields and reports missing required expressions', () => {
    const rows = semanticQuestionsToRows([{
      seq: 1,
      semanticGoals: [{
        id: 'old-id',
        name: '说明尺码',
        requiredPoints: [{
          id: 'old-point',
          label: '说明不偏大',
          matchAny: ['正常尺码'],
          businessRules: { mustIncludeAll: ['尺码'] },
        }],
        riskRules: [{ id: 'old-risk', label: '错误承诺', matchAny: ['一定退款'], penalty: 10 }],
      }],
    }]);
    expect(rows[0]).toMatchObject({
      seq: 1,
      name: '说明尺码',
      points: [{ label: '说明不偏大', matchAny: ['正常尺码'], mustIncludeAll: ['尺码'] }],
      riskRules: [{ label: '错误承诺', matchAny: ['一定退款'], penalty: 10 }],
    });
    expect(() => semanticRowsToGoalsBySeq([{
      seq: 1,
      name: '说明尺码',
      points: [{ label: '说明不偏大', matchAny: [] }],
    }])).toThrow('至少添加一种认可说法');
  });
});
