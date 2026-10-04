/**
 * 案例导入适配器（方案 F5-01 文件导入 / F5-03 平台导出适配器）。
 *
 * 方案里写明：抖店 / 千牛等平台的导出文件「预留解析适配器接口，按需实现」。
 * 这里把「表头识别 + 行解析」抽成接口，内置一个通用适配器（角色 / 内容两列，
 * 或形如「买家:内容」的单列文本），平台适配器按同一接口注册即可接进来。
 */

export type CaseSender = 'buyer' | 'agent';
export interface CaseMessage {
  sender: CaseSender;
  content: string;
}
export interface CaseParseResult {
  messages: CaseMessage[];
  failed: { line: number; reason: string }[];
}
export interface CaseImportAdapter {
  code: string;
  name: string;
  description: string;
  /** 表头是否像这个格式（用于自动挑选适配器） */
  match(headers: string[]): boolean;
  parse(rows: string[][], headers: string[]): CaseParseResult;
}

const ROLE_ALIASES: Record<string, CaseSender> = {
  买家: 'buyer',
  客户: 'buyer',
  用户: 'buyer',
  对方: 'buyer',
  顾客: 'buyer',
  客服: 'agent',
  我方: 'agent',
  卖家: 'agent',
  我: 'agent',
  buyer: 'buyer',
  customer: 'buyer',
  user: 'buyer',
  agent: 'agent',
  seller: 'agent',
  service: 'agent',
};

const normalizeRole = (value: string): CaseSender | null => {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  return ROLE_ALIASES[key] || ROLE_ALIASES[String(value || '').trim()] || null;
};

const ROLE_HEADERS = ['角色', '发送方', '发送者', '消息角色', 'role', 'sender', 'from'];
const CONTENT_HEADERS = ['内容', '消息内容', '消息', '内容正文', '对话内容', 'content', 'message', 'text'];

const findColumn = (headers: string[], candidates: string[]) =>
  headers.findIndex((header) => candidates.includes(String(header || '').trim().toLowerCase()) || candidates.includes(String(header || '').trim()));

/** 通用适配器：两列（角色 + 内容），或一列「角色:内容」。 */
export const GENERIC_CASE_ADAPTER: CaseImportAdapter = {
  code: 'generic',
  name: '通用格式',
  description: '两列：角色（买家/客服）+ 内容；也支持单列「买家:内容」的行文本。',
  match: (headers) => {
    const role = findColumn(headers, ROLE_HEADERS);
    const content = findColumn(headers, CONTENT_HEADERS);
    return role >= 0 && content >= 0;
  },
  parse: (rows, headers) => {
    const roleIndex = findColumn(headers, ROLE_HEADERS);
    const contentIndex = findColumn(headers, CONTENT_HEADERS);
    const messages: CaseMessage[] = [];
    const failed: { line: number; reason: string }[] = [];

    rows.forEach((row, index) => {
      const lineNumber = index + 2; // 表头占第 1 行
      const rawRole = roleIndex >= 0 ? row[roleIndex] : '';
      const rawContent = String((contentIndex >= 0 ? row[contentIndex] : row[0]) ?? '').trim();
      if (!rawContent) return;

      // 单列形态：整行是「买家:内容」
      if (roleIndex < 0 || !String(rawRole || '').trim()) {
        const matched = /^(买家|客户|用户|对方|顾客|客服|我方|卖家|我|buyer|customer|agent|seller)\s*[:：]\s*(.+)$/i.exec(rawContent);
        if (!matched) {
          failed.push({ line: lineNumber, reason: '无法识别角色，请使用「买家:内容」或补一列角色' });
          return;
        }
        messages.push({
          sender: normalizeRole(matched[1]) || 'buyer',
          content: matched[2].trim(),
        });
        return;
      }

      const sender = normalizeRole(String(rawRole));
      if (!sender) {
        failed.push({ line: lineNumber, reason: `无法识别的角色「${String(rawRole).trim()}」` });
        return;
      }
      messages.push({ sender, content: rawContent });
    });

    return { messages, failed };
  },
};

/**
 * 平台适配器注册点（方案 F5-03）。
 * 拿到抖店/千牛的导出样例后，实现同一个 `CaseImportAdapter` 接口并注册进来即可，
 * 页面上的「导入格式」下拉会自动多出一项。
 */
const adapters: CaseImportAdapter[] = [GENERIC_CASE_ADAPTER];

export function registerCaseAdapter(adapter: CaseImportAdapter): void {
  const index = adapters.findIndex((item) => item.code === adapter.code);
  if (index >= 0) adapters[index] = adapter;
  else adapters.push(adapter);
}

export function listCaseAdapters() {
  return adapters.map(({ code, name, description }) => ({ code, name, description }));
}

/** 按表头自动挑适配器；挑不到就用通用适配器（它会走单列文本兜底）。 */
export function pickCaseAdapter(headers: string[], code?: string): CaseImportAdapter {
  if (code) {
    const found = adapters.find((item) => item.code === code);
    if (found) return found;
  }
  return adapters.find((item) => item.match(headers)) || GENERIC_CASE_ADAPTER;
}

/** 导入模板（CSV）：两列角色 + 内容，与通用适配器对齐。 */
export const CASE_IMPORT_TEMPLATE = 'role,content\n买家,快递三天没有更新了！\n客服,亲，非常抱歉，我马上帮您核实物流进度～\n买家,什么时候能给我答复？';
