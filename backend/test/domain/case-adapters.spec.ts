import {
  GENERIC_CASE_ADAPTER,
  listCaseAdapters,
  pickCaseAdapter,
  registerCaseAdapter,
} from '../../src/domain/case-adapters';

/** 案例导入适配器（方案 F5-01 文件导入 / F5-03 平台适配器注册点）。 */
describe('案例导入适配器', () => {
  it('两列格式：角色 + 内容', () => {
    const headers = ['角色', '内容'];
    const rows = [
      ['买家', '快递三天没更新了'],
      ['客服', '亲，我马上帮您核实～'],
    ];
    expect(GENERIC_CASE_ADAPTER.match(headers)).toBe(true);
    const result = GENERIC_CASE_ADAPTER.parse(rows, headers);
    expect(result.messages).toEqual([
      { sender: 'buyer', content: '快递三天没更新了' },
      { sender: 'agent', content: '亲，我马上帮您核实～' },
    ]);
    expect(result.failed).toEqual([]);
  });

  it('英文表头也认（role / content）', () => {
    const headers = ['role', 'content'];
    const result = GENERIC_CASE_ADAPTER.parse([['customer', '在吗'], ['agent', '在的']], headers);
    expect(result.messages.map((m) => m.sender)).toEqual(['buyer', 'agent']);
  });

  it('单列「买家:内容」走兜底解析，识别不了的行进失败清单', () => {
    const headers = ['对话内容'];
    const result = GENERIC_CASE_ADAPTER.parse(
      [['买家:什么时候发货'], ['客服:亲，今天就会发出～'], ['这行没有角色']],
      headers
    );
    expect(result.messages).toHaveLength(2);
    expect(result.failed).toEqual([{ line: 4, reason: '无法识别角色，请使用「买家:内容」或补一列角色' }]);
  });

  it('角色列写了不认识的值会被挑出来，而不是默认当买家', () => {
    const result = GENERIC_CASE_ADAPTER.parse([['机器人', '你好']], ['角色', '内容']);
    expect(result.messages).toHaveLength(0);
    expect(result.failed[0].line).toBe(2);
    expect(result.failed[0].reason).toContain('机器人');
  });

  it('自动挑选失败时回落到通用适配器；指定 code 时优先用它', () => {
    expect(pickCaseAdapter(['随便', '什么']).code).toBe('generic');
    expect(pickCaseAdapter(['role', 'content']).code).toBe('generic');
    expect(pickCaseAdapter(['role', 'content'], 'generic').code).toBe('generic');
  });

  it('平台适配器可以按同一接口注册进来（方案 F5-03 预留点）', () => {
    const before = listCaseAdapters().length;
    registerCaseAdapter({
      code: 'doudian-demo',
      name: '抖店演示格式',
      description: '示例：说明平台适配器只需实现同一接口',
      // 用一个通用适配器认不出的表头，证明「平台适配器优先于通用兜底」
      match: (headers) => headers.includes('发送时间') && headers.includes('消息内容'),
      parse: (rows) => ({
        messages: rows.map((row) => ({ sender: 'buyer' as const, content: String(row[0] ?? '') })),
        failed: [],
      }),
    });
    expect(listCaseAdapters().length).toBe(before + 1);
    expect(listCaseAdapters().map((item) => item.code)).toContain('doudian-demo');
    expect(pickCaseAdapter(['发送时间', '消息内容']).code).toBe('doudian-demo');
    // 通用适配器认得的表头仍走通用适配器
    expect(pickCaseAdapter(['发送方', '内容']).code).toBe('generic');
    // 重复注册同一个 code 是覆盖，不是追加
    registerCaseAdapter({ ...GENERIC_CASE_ADAPTER });
    expect(listCaseAdapters().filter((item) => item.code === 'generic')).toHaveLength(1);
  });
});
