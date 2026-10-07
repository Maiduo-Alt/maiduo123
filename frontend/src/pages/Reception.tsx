import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Switch,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  AudioOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FormOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  ScissorOutlined,
  SendOutlined,
  ShoppingOutlined,
  SmileOutlined,
  StarOutlined,
  SwapOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  TranslationOutlined,
  VideoCameraOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { connectRealtime, sendClientAck } from '../realtime';
import { useAuth } from '../store/auth';
import OrderCard from '../components/OrderCard';
import ProductSpecModal from '../components/ProductSpecModal';
import dayjs from 'dayjs';

interface SessionDto {
  sessionId: number;
  buyerName: string;
  styleCode: string;
  state: string;
  seq: number;
  totalQuestions: number;
  questions: { seq: number; question: string; keyPoints: string[]; stage?: 'presale' | 'aftersale' }[];
  product: any;
  order: any;
  emotionValue: number;
  timeoutCount: number;
  score: number | null;
  waitedSec: number;
  timeoutLimitSec: number;
  remainSec: number;
  /** 会话接入时间，用于对话区首条咨询商品卡的时间戳 */
  joinAt?: string;
}

interface MessageDto {
  id: number;
  sessionId: number;
  sender: 'buyer' | 'agent' | 'system';
  content: string;
  seq: number;
  createdAt: string;
  responseSec: number | null;
  isTimeout: boolean;
  ruleResult?: any;
}

const STATE_LABEL: Record<string, string> = {
  pending: '待接入',
  wait: '等待接入',
  serving: '接待中',
  waiting_buyer: '等待买家',
  timeout: '已超时',
  finished: '已结束',
  transferred: '已转交',
  aborted: '异常中止',
};

/**
 * 飞鸽式商品卡（客户 2026-10-03：会话页对齐飞鸽）：
 * 买家发来的商品卡与客服插入的商品卡共用这一套渲染——图片 + 标题 + 价格 + 库存
 * + 服务承诺标签 + 底部动作按钮（… / 计算价格 / 邀请下单 / 规格·属性）。
 * 卡片上的每一项都来自《商品库》里那份真实商品数据。
 */
function FeigeProductCard({
  product,
  onSpec,
  onQuote,
  onInvite,
}: {
  product?: any;
  onSpec: () => void;
  onQuote: () => void;
  onInvite: () => void;
}) {
  const services: string[] = product?.services || [];
  return (
    <div className="feige-product-card">
      <div className="feige-product-thumb">
        {product?.coverUrl ? <img src={product.coverUrl} alt="" /> : <ShoppingOutlined />}
      </div>
      <div className="feige-product-info">
        <div className="feige-product-title">{product?.title || '关联商品'}</div>
        <div className="feige-product-price">
          ¥{Number(product?.price ?? 0).toFixed(2)}
          {product?.stock !== undefined && product?.stock !== null ? (
            <span className="feige-product-stock">库存 {product.stock}</span>
          ) : null}
        </div>
        <div className="feige-product-tags">
          {services.map((item) => (
            <Tag key={item} style={{ marginInlineEnd: 4 }}>
              {item}
            </Tag>
          ))}
          {services.some((item) => item.includes('发货')) ? (
            <span className="feige-product-ship">现货 · 按承诺时效发货</span>
          ) : null}
        </div>
      </div>
      <div className="feige-product-actions">
        <Button size="small" onClick={onQuote}>
          计算价格
        </Button>
        <Button size="small" onClick={onInvite}>
          邀请下单
        </Button>
        <Button size="small" onClick={onSpec}>
          规格/属性
        </Button>
      </div>
    </div>
  );
}

const STYLE_LABEL: Record<string, string> = {
  friendly: '友善随和型',
  impatient: '急躁易怒型',
  direct: '直爽高效型',
  hesitant: '纠结谨慎型',
  silent: '沉默寡言型',
};

export default function Reception() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  /** 批注属带教能力（方案 2.2），客服仅可查看与回复批注 */
  const canAnnotate = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  /** 客户新增需求：自由练习只给管理员/主管，客服只做任务训练 */
  const canFreePractice = profile?.roleCode === 'admin' || profile?.roleCode === 'leader';
  const [params, setParams] = useSearchParams();
  const attemptIdFromUrl = Number(params.get('attemptId')) || null;
  /** 任务训练入口：/reception?taskId=12 由《回复模拟任务》带过来（方案 F6-05） */
  const taskIdFromUrl = Number(params.get('taskId')) || null;
  const [task, setTask] = useState<any>(null);
  /** 提示模式参数（方案 F1-15）：带教开启后，长时间未回复会给话术思路 */
  const [systemParams, setSystemParams] = useState<any>(null);

  const [levels, setLevels] = useState<any[]>([]);
  /**
   * C5：管理员/主管在开局时当场指定本局人数（接入数 / 合计接待数）。
   * 不填就走系统参数里该档位的配置；只在开局界面为自由练习（管理员/主管）显示。
   */
  const [runCounts, setRunCounts] = useState<Record<string, { concurrent?: number; total?: number }>>({});
  /** 进行中的接待：离开页面回来后能继续，而不是只能等断线宽限期（方案 F1-13） */
  const [runningAttempt, setRunningAttempt] = useState<any>(null);
  const [attempt, setAttempt] = useState<any>(null);
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [phrases, setPhrases] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  /** 业务动作请求进行中（订单卡片上的催付/改价等，避免连点重复记录） */
  const [actionPending, setActionPending] = useState(false);
  /**
   * 商品「规格 / 属性」弹窗（客户 2026-10-03）：点开后看到的是**管理员在《商品库》里配的真实信息**
   * （规格 SKU、售价与划线价、库存、分类、服务承诺、适用场景、详情图），数据来自会话快照里的商品。
   */
  const [specOpen, setSpecOpen] = useState(false);
  /**
   * 客户 2026-10-03：「商品」页签要展示**商品库里的商品**（不是当前会话的咨询宝贝），
   * 所以接待页会把商品库拉一份下来供带教/客服选发；弹「规格/属性」时用被点击的那件商品。
   */
  const [libraryProducts, setLibraryProducts] = useState<any[]>([]);
  const [libraryKeyword, setLibraryKeyword] = useState('');
  const [libraryCategory, setLibraryCategory] = useState<string | undefined>(undefined);
  const [specProduct, setSpecProduct] = useState<any>(null);
  /** 右栏「会话搜索」页签的关键词（飞鸽右栏第三个页签） */
  const [messageSearch, setMessageSearch] = useState('');
  const [result, setResult] = useState<any>(null);
  /** 深链：/reception?attemptId=1&tab=order 直接落在右栏某个页签（截图与分享用） */
  const [rightTab, setRightTab] = useState(['order', 'product', 'phrase'].includes(params.get('tab') || '') ? (params.get('tab') as string) : 'product');
  // 会话队列的排序与分组（方案 F1-04）
  const [queueSort, setQueueSort] = useState<'default' | 'urgent' | 'progress'>('default');
  const [queueGrouped, setQueueGrouped] = useState(false);
  // 飞鸽式会话队列：搜索、页签（正在接待 / 待接入 / 接待结束）、未读红点
  const [queueSearch, setQueueSearch] = useState('');
  /**
   * 页签口径（客户 2026-10-03）：「正在接待」里不出现待接入的买家——
   * 排队中的买家单独进「待接入」页签，不与正在接待的混在一起。
   */
  const [queueTab, setQueueTab] = useState<'serving' | 'pending' | 'closed'>('serving');
  const [unread, setUnread] = useState<Set<number>>(() => new Set());
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [remarkText, setRemarkText] = useState('');
  const activeIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const activeSession = useMemo(() => sessions.find((s) => s.sessionId === activeId) || null, [sessions, activeId]);
  const activeMessages = useMemo(() => messages.filter((m) => m.sessionId === activeId), [messages, activeId]);

  /** 超时提醒音（方案 F1-10：接近超时与已超时用颜色与提示音区分）。用 Web Audio 合成，免音频资源。 */
  const beep = useCallback((urgent: boolean) => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = urgent ? 880 : 620;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (urgent ? 0.35 : 0.18));
    } catch {
      /* 浏览器未授权音频等情况忽略，不影响接待 */
    }
  }, []);

  /** 正在接待中（已进线、未结束） */
  const isRunning = useCallback((s: SessionDto) => !['finished', 'transferred', 'aborted', 'pending'].includes(s.state), []);
  /** 待接入（C5：本次模拟总接待人数 > 同时在线人数时，排在后面的买家） */
  const isPending = useCallback((s: SessionDto) => s.state === 'pending', []);
  /** 还没结束（含待接入），用于左侧「正在接待 / 接待结束」两个页签的划分 */
  const isOpen = useCallback((s: SessionDto) => !['finished', 'transferred', 'aborted'].includes(s.state), []);

  /** 待接入（排队等下一轮）的买家数量：单独一个页签，不混进「正在接待」 */
  const pendingCount = useMemo(() => sessions.filter(isPending).length, [sessions, isPending]);

  /** 待接入都进线后这个页签会消失，此时把页签落回「正在接待」，避免停在空页签上 */
  useEffect(() => {
    if (queueTab === 'pending' && pendingCount === 0) setQueueTab('serving');
  }, [queueTab, pendingCount]);

  /** 会话编号固定按原始顺序，排序后不重新编号。 */
  const queueNumber = useMemo(() => {
    const map = new Map<number, number>();
    sessions.forEach((s, i) => map.set(s.sessionId, i + 1));
    return map;
  }, [sessions]);

  /**
   * 飞鸽式会话列表：每项要显示「最后一条消息 + 时间」。
   * 快照接口一次返回本局所有会话的消息，所以这里按会话取最后一条即可（不用额外请求）。
   */
  const lastMessageBySession = useMemo(() => {
    const map = new Map<number, { content: string; createdAt: string; sender: string }>();
    messages.forEach((m) => map.set(m.sessionId, { content: m.content, createdAt: m.createdAt, sender: m.sender }));
    return map;
  }, [messages]);

  /** 按排序方式与是否分组整理左侧队列。 */
  /** 按页签（正在接待 / 待接入 / 接待结束）与搜索词过滤队列。 */
  const visibleSessions = useMemo(() => {
    const keyword = queueSearch.trim().toLowerCase();
    return sessions.filter((s) => {
      if (queueTab === 'serving' && !isRunning(s)) return false;
      if (queueTab === 'pending' && !isPending(s)) return false;
      if (queueTab === 'closed' && isOpen(s)) return false;
      if (!keyword) return true;
      return (
        s.buyerName.toLowerCase().includes(keyword) ||
        String(s.product?.title || '').toLowerCase().includes(keyword) ||
        String(s.product?.productNo || '').includes(keyword)
      );
    });
  }, [sessions, queueSearch, queueTab, isOpen, isRunning, isPending]);

  const queueGroups = useMemo(() => {
    const list = [...visibleSessions];
    if (queueSort === 'urgent') {
      list.sort((a, b) => (isRunning(a) ? a.remainSec : Number.MAX_SAFE_INTEGER) - (isRunning(b) ? b.remainSec : Number.MAX_SAFE_INTEGER));
    } else if (queueSort === 'progress') {
      list.sort((a, b) => b.seq / Math.max(1, b.totalQuestions) - a.seq / Math.max(1, a.totalQuestions));
    }
    if (!queueGrouped) return [{ label: '', items: list }];
    return [
      { label: '待接入', items: list.filter((s) => isPending(s)) },
      { label: '即将超时', items: list.filter((s) => isRunning(s) && s.remainSec <= 30) },
      { label: '接待中', items: list.filter((s) => isRunning(s) && s.remainSec > 30) },
      { label: '已结束 / 已转交', items: list.filter((s) => !isOpen(s)) },
    ].filter((group) => group.items.length);
  }, [visibleSessions, queueSort, queueGrouped, isRunning, isPending, isOpen]);

  /** 选中会话时清掉未读红点（方案 3.1.5）。 */
  const selectSession = useCallback((sessionId: number) => {
    setActiveId(sessionId);
    setUnread((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const loadSnapshot = useCallback(
    async (id: number, silent = true) => {
      try {
        const data = await api<any>(`/receptions/${id}/snapshot`);
        setAttempt(data.attempt);
        setSessions(data.sessions);
        setMessages(data.messages);
        // 客户 2026-10-03：待接入的买家不在「正在接待」里展示，默认选中的也应该是已进线的那个
        setActiveId((prev) => prev ?? data.sessions.find((s: any) => s.state !== 'pending')?.sessionId ?? null);
      } catch (e) {
        if (!silent) message.error((e as Error).message);
      }
    },
    []
  );

  useEffect(() => {
    api('/receptions/levels').then(setLevels);
    api<any>('/phrases').then((data) => setPhrases(data.list || []));
  }, []);

  useEffect(() => {
    if (attemptIdFromUrl) return;
    api<any>('/receptions/current')
      .then(setRunningAttempt)
      .catch(() => setRunningAttempt(null));
  }, [attemptIdFromUrl]);

  useEffect(() => {
    if (!taskIdFromUrl || attemptIdFromUrl) return;
    api<any[]>('/tasks')
      .then((rows) => setTask((rows || []).find((row) => row.id === taskIdFromUrl) || null))
      .catch(() => setTask(null));
  }, [taskIdFromUrl, attemptIdFromUrl]);

  useEffect(() => {
    if (!attemptIdFromUrl) return;
    api<any>('/settings')
      .then(setSystemParams)
      .catch(() => setSystemParams(null));
  }, [attemptIdFromUrl]);

  useEffect(() => {
    if (!attemptIdFromUrl) return;
    loadSnapshot(attemptIdFromUrl, false);
    const disconnect = connectRealtime((event, payload) => {
      if (event === 'timeout.warning') beep(true);
      // C6 实时预警：回复被判无效 / 敷衍时当场提醒（该条消息随后会被打标）
      if (event === 'agent.message.ack' && payload?.invalid) {
        message.warning({
          content: `该条回复被判为无效回复：${payload.invalidReason || '命中无效判定规则'}`,
          duration: 6,
        });
      }
      // 方案 3.1.5：买家消息到达且不在当前会话时，队列项显示未读红点并播放轻提示音
      if (event === 'buyer.message' && payload?.sessionId) {
        const sessionId = Number(payload.sessionId);
        if (sessionId !== activeIdRef.current) {
          setUnread((prev) => (prev.has(sessionId) ? prev : new Set(prev).add(sessionId)));
          beep(false);
        }
      }
      // 计时以服务端 timer.tick 为准（方案 5.5）：只更新各会话的等待与剩余秒数，
      // 其余事件（买家消息、评分结束等）再回源拉取快照。
      if (event === 'timer.tick' && Array.isArray(payload?.sessions)) {
        const byId = new Map<number, any>(payload.sessions.map((s: any) => [s.sessionId, s]));
        setSessions((prev) =>
          prev.map((s) => {
            const next = byId.get(s.sessionId);
            return next
              ? {
                  ...s,
                  waitedSec: next.waitedSec,
                  remainSec: next.remainSec,
                  timeoutLimitSec: next.timeoutLimitSec,
                  state: next.state ?? s.state,
                }
              : s;
          })
        );
        return;
      }
      loadSnapshot(attemptIdFromUrl);
    });
    const poll = window.setInterval(() => loadSnapshot(attemptIdFromUrl), 2000);
    return () => {
      disconnect();
      window.clearInterval(poll);
    };
  }, [attemptIdFromUrl, loadSnapshot, beep]);

  useEffect(() => {
    if (!attemptIdFromUrl) return;
    // 每秒心跳（client.ack）：上报当前焦点会话，服务端据此回传计时与连接健康。
    sendClientAck({ sessionId: activeId ?? undefined });
    const beat = window.setInterval(() => sendClientAck({ sessionId: activeId ?? undefined }), 1000);
    return () => window.clearInterval(beat);
  }, [attemptIdFromUrl, activeId]);

  const start = async (
    level: string,
    source: 'free' | 'task' = 'free',
    counts?: { concurrentCount?: number; totalCount?: number }
  ) => {
    try {
      const data = await api<any>('/receptions', {
        method: 'POST',
        body: {
          level,
          source,
          taskId: source === 'task' ? taskIdFromUrl ?? undefined : undefined,
          ...(counts || {}),
        },
      });
      setParams({ attemptId: String(data.attemptId) });
      message.success(`已开始 ${level} ${source === 'task' ? '任务训练' : '接待'}，请准备`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const send = async () => {
    if (!attempt || !activeSession || !input.trim()) return;
    setSending(true);
    try {
      const data = await api<any>(`/receptions/${attempt.id}/sessions/${activeSession.sessionId}/messages`, {
        method: 'POST',
        body: { content: input.trim() },
      });
      setInput('');
      if (data.isTimeout) message.warning(`本条回复超过时限（${data.responseSec} 秒），已记录一次超时`);
      await loadSnapshot(attempt.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const transfer = async () => {
    if (!attempt || !activeSession) return;
    try {
      await api(`/receptions/${attempt.id}/sessions/${activeSession.sessionId}/transfer`, { method: 'POST' });
      message.success('已转交该会话');
      await loadSnapshot(attempt.id);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const finishSession = async () => {
    if (!attempt || !activeSession) return;
    try {
      await api(`/receptions/${attempt.id}/sessions/${activeSession.sessionId}/finish`, { method: 'POST' });
      await loadSnapshot(attempt.id);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const finishAll = async () => {
    if (!attempt) return;
    try {
      const data = await api<any>(`/receptions/${attempt.id}/finish`, { method: 'POST' });
      setResult(data);
      await loadSnapshot(attempt.id);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const insertPhrase = (content: string) => {
    const product = activeSession?.product;
    const rendered = content
      .replace(/{商品名}/g, product?.title || '该商品')
      .replace(/{价格}/g, product?.price ? `¥${product.price}` : '以页面为准')
      .replace(/{订单号}/g, activeSession?.order?.orderNo || '下单后生成');
    setInput((prev) => (prev ? `${prev}${rendered}` : rendered));
  };

  /** 插入短语并累加使用次数（方案 3.8 F8-08：短语列表展示使用次数）。 */
  const usePhrase = (item: any) => {
    insertPhrase(item.content);
    api(`/phrases/${item.id}/use`, { method: 'POST' }).catch(() => {
      /* 计数失败不影响插入 */
    });
  };

  const sendProductCard = () => {
    const product = activeSession?.product;
    if (!product) return;
    setInput((prev) => `${prev}【商品卡片】${product.title} 商品ID：${product.productNo} 价格：¥${product.price}`);
  };

  /** 商品库（右栏「商品」页签用）：进页面拉一次，搜索/分类在前端做（最多 200 件，足够） */
  useEffect(() => {
    api<any>('/products', { query: { pageSize: 200, status: '1' } })
      .then((res) => setLibraryProducts(res?.list || []))
      .catch(() => setLibraryProducts([]));
  }, []);

  const libraryCategories = useMemo(
    () => Array.from(new Set(libraryProducts.map((p: any) => String(p.category || '未分类')))),
    [libraryProducts]
  );
  const visibleLibraryProducts = useMemo(() => {
    const keyword = libraryKeyword.trim().toLowerCase();
    return libraryProducts
      .filter((p: any) => !libraryCategory || String(p.category || '未分类') === libraryCategory)
      .filter((p: any) => {
        if (!keyword) return true;
        return (
          String(p.title || '').toLowerCase().includes(keyword) || String(p.productNo || '').includes(keyword)
        );
      })
      .slice(0, 60);
  }, [libraryProducts, libraryKeyword, libraryCategory]);

  /**
   * 打开「规格 / 属性」：展示管理员在《商品库》里维护的真实商品信息。
   * 不传参数时用当前会话的咨询宝贝；商品页签里点的是哪件商品就传哪件。
   */
  const openSpecOf = (product?: any) => {
    const target = product ?? activeSession?.product;
    if (!target) {
      message.warning('请选择一件商品');
      return;
    }
    setSpecProduct(target);
    setSpecOpen(true);
  };
  const openSpec = () => openSpecOf(activeSession?.product);

  /** 把指定商品作为卡片发到对话里（商品页签里可以选商品库里任意一件） */
  const sendProductCardOf = (product: any) => {
    if (!product) return;
    setInput((prev) => `${prev}【商品卡片】${product.title} 商品ID：${product.productNo} 价格：¥${product.price}`);
  };

  /**
   * 客户 2026-10-03：订单卡片上的平台侧操作「点击后记为一次业务动作」。
   * 后端会落一条动作记录，同时按动作给买家发一句标准话术（响应时长/要点命中照常算，
   * 但不参与「无效/敷衍」判定）。这里只负责调用与提示。
   */
  const runBusinessAction = async (code: string, name: string) => {
    if (!attempt || !activeSession) return;
    setActionPending(true);
    try {
      await api(`/receptions/${attempt.id}/sessions/${activeSession.sessionId}/actions`, {
        method: 'POST',
        body: { action: code },
      });
      message.success(`已记为一次业务动作：${name}，标准话术已发给买家`);
      await loadSnapshot(attempt.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActionPending(false);
    }
  };

  /** 参考图 1：对话区顶部买家昵称后提供复制入口 */
  const copyBuyerName = () => {
    const name = activeSession?.buyerName;
    if (!name) return;
    if (!navigator.clipboard) {
      message.warning('当前浏览器未开放剪贴板权限');
      return;
    }
    navigator.clipboard.writeText(name).then(
      () => message.success('已复制买家昵称'),
      () => message.warning('当前浏览器未开放剪贴板权限')
    );
  };

  /** 会话备注：写入该接待的批注（方案 3.1.5 对话区顶部的备注入口）。 */
  const saveRemark = async () => {
    if (!attempt || !remarkText.trim()) return;
    try {
      await api(`/records/${attempt.id}/annotations`, {
        method: 'POST',
        body: { sessionId: activeSession?.sessionId, content: remarkText.trim() },
      });
      message.success('备注已保存');
      setRemarkOpen(false);
      setRemarkText('');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (!attemptIdFromUrl) {
    // 客服（无任务上下文）：不开放自由练习，直接引导去《我的任务》
    if (!task && !canFreePractice) {
      return (
        <div className="page-card">
          {runningAttempt ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`你有一次进行中的接待：${runningAttempt.level} · ${runningAttempt.attemptNo}`}
              description="可以直接继续这次训练。"
              action={
                <Button type="primary" size="small" onClick={() => setParams({ attemptId: String(runningAttempt.attemptId) })}>
                  继续接待
                </Button>
              }
            />
          ) : null}
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            从《我的任务》进入训练
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            模拟训练只对带教/管理员开放；你的训练由带教通过《回复模拟任务》下发，进入任务后即可开始接待。
          </Typography.Paragraph>
          <Alert
            type="info"
            showIcon
            message="没有看到任务？"
            description="可能是带教还没下发，或者任务已过截止时间。可以先去《我的任务》看看待办与截止倒计时，也可以联系带教确认。"
            action={
              <Button type="primary" size="small" onClick={() => navigate('/tasks')}>
                去我的任务
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="page-card">
        {runningAttempt && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`你有一次进行中的接待：${runningAttempt.level} · ${runningAttempt.attemptNo}`}
            description="离开接待页不会丢数据，可以直接继续；也可以先结束它再开新的一局。"
            action={
              <Space direction="vertical">
                <Button
                  type="primary"
                  size="small"
                  onClick={() => setParams({ attemptId: String(runningAttempt.attemptId) })}
                >
                  继续接待
                </Button>
                <Button
                  size="small"
                  onClick={async () => {
                    await api(`/receptions/${runningAttempt.attemptId}/finish`, { method: 'POST' }).catch(() => null);
                    setRunningAttempt(null);
                    api('/receptions/levels').then(setLevels);
                    message.success('已结束上一次接待');
                  }}
                >
                  结束这次接待
                </Button>
              </Space>
            }
          />
        )}
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {task ? `任务训练：${task.name}` : '模拟训练（管理员 / 带教）'}
        </Typography.Title>
        {/* 任务卡（方案 F6-05：接待前就能看到目标、进度与截止倒计时） */}
        {task && (
          <Alert
            type={dayjs(task.deadline).isBefore(dayjs()) ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <Space size={16} wrap>
                <span>
                  任务编号 <b>{task.taskNo}</b>
                </span>
                <span>
                  允许难度 <b>{(task.levels || []).join(' / ')}</b>
                </span>
                <span>
                  需达成 <b>{task.targetCount}</b> 次，当前 <b>{task.doneCount}</b> 次
                </span>
                <span>
                  截止 <b>{dayjs(task.deadline).format('YYYY-MM-DD HH:mm')}</b>
                  {dayjs(task.deadline).isBefore(dayjs())
                    ? '（已过截止时间）'
                    : `（还剩 ${Math.max(0, Math.ceil(dayjs(task.deadline).diff(dayjs(), 'hour', true)))} 小时）`}
                </span>
              </Space>
            }
            description={
              (task.targets || []).length
                ? `达标条件：${task.targets
                    .map(
                      (t: any) =>
                        `${
                          t.metric === 'total_score' ? '总分' : t.metric === 'first_response' ? '首次响应' : '超时次数'
                        } ${t.operator === 'gte' ? '≥' : '≤'} ${t.threshold}`
                    )
                    .join('，')}`
                : '本任务未设置达标条件'
            }
          />
        )}
        <Typography.Paragraph type="secondary">
          {task
            ? '选择任务允许的难度开始训练；结束后系统会自动判定本次是否达成任务目标。'
            : '选择难度后进入接待席。系统会按难度同时接入 1～4 名模拟买家，每个会话独立计时并按抖店客服工作台的考核口径评分。'}
        </Typography.Paragraph>
        <Row gutter={16} style={{ marginTop: 8 }}>
          {levels.map((level) => (
            <Col span={6} key={level.code}>
              <Card
                size="small"
                title={
                  <span>
                    {level.code} {level.name}
                  </span>
                }
                extra={
                  // 方案 4.4：未解锁的档位优先提示（即使是任务允许的难度，也不能跳过解锁）
                  !level.unlocked ? (
                    <Tag color="orange">未解锁</Tag>
                  ) : task ? (
                    (task.levels || []).includes(level.code) ? (
                      <Tag color="blue">任务允许</Tag>
                    ) : (
                      <Tag>任务不允许</Tag>
                    )
                  ) : (
                    <Tag color="blue">已开放</Tag>
                  )
                }
              >
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                  并发客户 {level.concurrent} 名 · 每会话 6～10 轮
                  <br />
                  响应等待口径：{level.waitTolerance > 1 ? '宽松（×1.5）' : '标准'}
                </Typography.Paragraph>
                {!level.unlocked ? (
                  <Typography.Paragraph type="warning" style={{ fontSize: 12, marginBottom: 8 }}>
                    未解锁：先在上一档达标 {level.requiredStreak ?? 1} 次，或让带教/管理员在《账号》里为你开放这个难度。
                  </Typography.Paragraph>
                ) : null}
                {/* C5：管理员/主管可当场指定本局人数（只在自由练习的开局界面出现，任务训练不给入口） */}
                {!task ? (
                  <Space size={6} style={{ marginBottom: 10 }} wrap>
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>本局接入</span>
                    <InputNumber
                      size="small"
                      min={1}
                      max={4}
                      style={{ width: 58 }}
                      value={runCounts[level.code]?.concurrent ?? level.concurrent}
                      onChange={(value) =>
                        setRunCounts((prev) => ({ ...prev, [level.code]: { ...prev[level.code], concurrent: value ?? undefined } }))
                      }
                    />
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>人 · 合计</span>
                    <InputNumber
                      size="small"
                      min={1}
                      max={20}
                      style={{ width: 64 }}
                      value={runCounts[level.code]?.total ?? level.total ?? level.concurrent}
                      onChange={(value) =>
                        setRunCounts((prev) => ({ ...prev, [level.code]: { ...prev[level.code], total: value ?? undefined } }))
                      }
                    />
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>人</span>
                  </Space>
                ) : null}
                <Button
                  type="primary"
                  block
                  disabled={!level.unlocked || (!!task && !(task.levels || []).includes(level.code))}
                  onClick={() =>
                    // 任务训练由客服发起，不能带「本局覆盖」（后端只允许管理员/主管指定）
                    start(
                      level.code,
                      task ? 'task' : 'free',
                      task
                        ? undefined
                        : {
                            concurrentCount: runCounts[level.code]?.concurrent ?? level.concurrent,
                            totalCount: runCounts[level.code]?.total ?? level.total ?? level.concurrent,
                          }
                    )
                  }
                >
                  {task ? '开始任务训练' : '开始接待'}
                </Button>
              </Card>
            </Col>
          ))}
        </Row>
        <Alert type="info" showIcon style={{ marginTop: 16 }} message="接待过程中请留意每个会话的倒计时，超过时限会被记为一次超时并扣分。" />
      </div>
    );
  }

  const running = attempt?.status === 'running';
  /** C5：已排好剧本但还没接入的买家 */
  const pendingSessions = sessions.filter((s) => s.state === 'pending');
  const runningSessions = sessions.filter((s) => isRunning(s));
  const waited = activeSession ? Math.max(0, activeSession.waitedSec) : 0;
  const remain = activeSession ? Math.max(0, activeSession.timeoutLimitSec - waited) : 0;
  const urgent = activeSession ? remain <= 30 : false;

  const elapsedSec = attempt?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(attempt.startedAt)) / 1000)) : 0;
  const formatDuration = (sec: number) => {
    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;
    return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
  };

  return (
    <div className="reception-page">
      {/* 顶部模拟客户端标题栏（严格参考图 1：抖店客服工作台标题栏） */}
      <div className="reception-titlebar">
        <div className="titlebar-tabs">
          <span className="titlebar-tab">
            <span className="titlebar-tab-dot" />
            在线模拟接待
            <CloseOutlined className="titlebar-tab-close" />
          </span>
          <span className="titlebar-tab-add">
            <PlusOutlined />
          </span>
        </div>
        <div className="titlebar-right">
          <Tag color="blue" className="titlebar-tag">
            {attempt?.level} {attempt?.levelName}
          </Tag>
          <span>
            剩余会话 <b>{pendingSessions.length}</b>
          </span>
          <span>
            已用时长 <b>{formatDuration(elapsedSec)}</b>
          </span>
          <span>
            任务 <b>{attempt?.task?.name || (attempt?.source === 'task' ? '任务训练' : '模拟训练')}</b>
          </span>
          <span className="titlebar-no">{attempt?.attemptNo}</span>
        </div>
      </div>

      <div className="reception-shell">
      <div className="reception-left">
        {/**
         * 客户 2026-10-03：左栏顶部按飞鸽改成**一条横幅**（飞鸽是「您今日暂无接待数据」），
         * 把原来的 2×2 计数搬进这一行里。计数口径不变（C5/C11）：
         * 接待买家 = 累计已进线（不含排队），恒等式 接待买家 = 正在接待 + 已结束 + 转交 成立。
         */}
        <div className="reception-banner">
          <div className="reception-banner-text">
            接待买家 <b>{sessions.length - pendingSessions.length}</b> · 正在接待{' '}
            <b>{runningSessions.length}</b> · 剩余会话 <b>{pendingSessions.length}</b> · 已结束{' '}
            <b>{sessions.filter((s) => s.state === 'finished').length}</b> · 转交{' '}
            <b>{sessions.filter((s) => s.state === 'transferred').length}</b>
          </div>
          <span className="reception-banner-link" onClick={() => navigate('/records')}>
            查看接待明细
          </span>
        </div>
        {/* 搜索（方案 3.1.5：支持按买家昵称 / 商品检索） */}
        <div className="reception-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
            placeholder="用户昵称 / 商品ID / 商品标题"
            value={queueSearch}
            onChange={(e) => setQueueSearch(e.target.value)}
          />
        </div>

        {/* 客户 2026-10-03：页签名对齐飞鸽——「当前会话 / 最近联系」；
            「待接入」是 C5 明确要求的排队页签，保留在中间，不混进当前会话。 */}
        <div className="reception-queue-tabs">
          <div className={`queue-tab ${queueTab === 'serving' ? 'active' : ''}`} onClick={() => setQueueTab('serving')}>
            当前会话（{sessions.filter(isRunning).length}）
          </div>
          {pendingCount > 0 ? (
            <div className={`queue-tab ${queueTab === 'pending' ? 'active' : ''}`} onClick={() => setQueueTab('pending')}>
              待接入（{pendingCount}）
            </div>
          ) : null}
          <div className={`queue-tab ${queueTab === 'closed' ? 'active' : ''}`} onClick={() => setQueueTab('closed')}>
            最近联系（{sessions.filter((s) => !isOpen(s)).length}）
          </div>
        </div>

        {/* 列表设置：排序与分组（参考图 1：列表设置 / 等待时长↑ / 已分组） */}
        <div className="reception-queue-bar">
          <span className="queue-bar-label">列表设置</span>
          <Select
            size="small"
            variant="borderless"
            value={queueSort}
            onChange={setQueueSort}
            style={{ width: 108 }}
            options={[
              { value: 'default', label: '默认顺序' },
              { value: 'urgent', label: '等待时长' },
              { value: 'progress', label: '对话进度' },
            ]}
          />
          <span className="queue-bar-grouped" onClick={() => setQueueGrouped((v) => !v)}>
            {queueGrouped ? '已分组' : '未分组'} <RightOutlined rotate={90} />
          </span>
        </div>

        <div className="reception-queue">
          {queueGroups.map((group) => (
            <div key={group.label || 'all'}>
              {group.label ? (
                <div className="queue-group-label">
                  {group.label}（{group.items.length}）
                </div>
              ) : null}
              {group.items.map((session) => {
                const runningSession = isRunning(session);
                const isUnread = unread.has(session.sessionId);
                // 方案 3.1.5：超过 30 秒未处理橙色，超过 180 秒红色
                const waitColor = !runningSession
                  ? '#8c8c8c'
                  : session.waitedSec > 180
                    ? '#cf1322'
                    : session.waitedSec > 30
                      ? '#d46b08'
                      : '#8c8c8c';
                return (
                  <div
                    key={session.sessionId}
                    className={`conversation-item ${session.sessionId === activeId ? 'active' : ''}`}
                    onClick={() => selectSession(session.sessionId)}
                  >
                    {/* 飞鸽：左边是圆形头像（这里用会话编号生成，保持训练需要的序号），未读时右上角红点 */}
                    <div className="conversation-avatar">
                      {String(queueNumber.get(session.sessionId) ?? 0).padStart(2, '0')}
                      {isUnread ? <span className="unread-dot" /> : null}
                    </div>
                    <div className="conversation-body">
                      <div className="conversation-top">
                        <span className={`conversation-name ${isUnread ? 'unread' : ''}`}>{session.buyerName}</span>
                        {/* 飞鸽右上角是最后一条消息的时间 */}
                        <span className="conversation-time">
                          {lastMessageBySession.get(session.sessionId)
                            ? new Date(lastMessageBySession.get(session.sessionId)!.createdAt).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : ''}
                        </span>
                      </div>
                      {/* 飞鸽第二行是最后一条消息预览 */}
                      <div className="conversation-sub">
                        <span className="conversation-preview">
                          {(() => {
                            const last = lastMessageBySession.get(session.sessionId);
                            if (!last) return session.product ? `咨询商品：${session.product.title}` : '暂无消息';
                            const text = last.content.startsWith('【商品卡片】')
                              ? `[商品卡片] ${last.content.replace('【商品卡片】', '').split(' 商品ID：')[0]}`
                              : last.content;
                            return last.sender === 'agent' ? `我：${text}` : text;
                          })()}
                        </span>
                        {/* 训练需要的等待计时 / 状态标签保留在预览行右侧 */}
                        {runningSession ? (
                          <span className="conversation-timer" style={{ color: waitColor }}>
                            {session.waitedSec}s
                          </span>
                        ) : session.state === 'pending' ? (
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                            {STATE_LABEL.pending}
                          </Tag>
                        ) : (
                          <Tag color={session.state === 'transferred' ? 'orange' : 'default'} style={{ marginInlineEnd: 0 }}>
                            {STATE_LABEL[session.state]}
                          </Tag>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="reception-left-footer">
          <Button danger block disabled={!running} onClick={finishAll}>
            结束本次接待并生成评分
          </Button>
        </div>
      </div>

      <div className="reception-center">
        {/* 对话区顶部：买家身份 + 备注入口（参考图 1） */}
        <div className="reception-center-header">
          <div className="center-header-left">
            {activeSession ? (
              <span className="center-index">
                {String(queueNumber.get(activeSession.sessionId) ?? 0).padStart(2, '0')}
              </span>
            ) : null}
            <div className="center-header-info">
              <div className="center-header-line">
                <span className="center-buyer-name">{activeSession?.buyerName || '请选择会话'}</span>
                {activeSession && (
                  <Tooltip title="复制买家昵称">
                    <CopyOutlined className="center-header-copy" onClick={copyBuyerName} />
                  </Tooltip>
                )}
                {activeSession && <Tag color="purple">{STYLE_LABEL[activeSession.styleCode]}</Tag>}
                {activeSession && (
                  <Tag
                    color={activeSession.emotionValue >= 80 ? 'red' : activeSession.emotionValue >= 50 ? 'orange' : 'green'}
                  >
                    情绪值 {activeSession.emotionValue}
                  </Tag>
                )}
              </div>
              {activeSession && canAnnotate && (
                <span className="center-header-remark" onClick={() => setRemarkOpen(true)}>
                  <EditOutlined /> 添加备注
                </span>
              )}
              {/* 飞鸽会话页顶部在昵称下方有一行信息标签（来源/风格/商品），这里用我们自己的真实数据渲染 */}
              {activeSession && (
                <div className="center-header-tags">
                  <Tag style={{ marginInlineEnd: 4 }}>
                    {attempt?.source === 'task' ? `任务训练：${attempt?.task?.name || '任务'}` : '模拟训练'}
                  </Tag>
                  <Tag style={{ marginInlineEnd: 4 }}>商品ID：{activeSession.product?.productNo || '—'}</Tag>
                  <span className="center-header-tags-more">
                    更多 <DownOutlined style={{ fontSize: 10 }} />
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="center-header-right">
            {activeSession && (
              <Tooltip title="距离超时的剩余时间">
                <span className={`session-countdown ${urgent ? 'urgent' : ''}`}>
                  <ClockCircleOutlined /> 剩余 {remain}s
                  <span className="session-countdown-limit"> / 时限 {activeSession.timeoutLimitSec}s</span>
                </span>
              </Tooltip>
            )}
            {activeSession && (
              <div className="center-header-actions">
                {/* 参考图 1：会话头右侧的备注 / 收藏 / @ / 转交 / 更多 图标组 */}
                <Tooltip title="添加备注">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    disabled={!canAnnotate}
                    onClick={() => setRemarkOpen(true)}
                  />
                </Tooltip>
                <Tooltip title="收藏会话（训练环境暂未开放）">
                  <Button type="text" size="small" icon={<StarOutlined />} disabled />
                </Tooltip>
                <Tooltip title="@ 提醒同事（训练环境暂未开放）">
                  <Button type="text" size="small" className="center-header-at" disabled>
                    @
                  </Button>
                </Tooltip>
                <Tooltip title="转交主管">
                  <Button type="text" size="small" icon={<SwapOutlined />} disabled={!running} onClick={transfer} />
                </Tooltip>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'card', icon: <ShoppingOutlined />, label: '插入商品卡片', disabled: !running || !activeSession.product },
                      { key: 'transfer', icon: <SwapOutlined />, label: '转交主管', disabled: !running },
                      { key: 'finish', icon: <RightOutlined />, label: '结束当前会话', disabled: !running },
                      { key: 'finishAll', icon: <CloseOutlined />, label: '结束本次接待', disabled: !running },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'card') sendProductCard();
                      if (key === 'transfer') transfer();
                      if (key === 'finish') finishSession();
                      if (key === 'finishAll') finishAll();
                    },
                  }}
                >
                  <Button type="text" size="small" icon={<MoreOutlined />} />
                </Dropdown>
              </div>
            )}
          </div>
        </div>

        <div className="message-list">
          {!activeSession && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择左侧会话" />}
          {/* 参考图 1：买家从商品页发起咨询，对话区首条固定为「咨询宝贝」商品卡 */}
          {activeSession?.product && (
            <div className="message-row">
              <div className="message-avatar">
                {String(queueNumber.get(activeSession.sessionId) ?? 0).padStart(2, '0')}
              </div>
              <div className="message-main">
                <div className="message-head">
                  <span className="message-sender">{activeSession.buyerName}</span>
                  <span className="message-time">
                    {activeSession.joinAt ? new Date(activeSession.joinAt).toLocaleTimeString('zh-CN') : ''}
                  </span>
                </div>
                {/* 客户 2026-10-03：买家首条「咨询宝贝」也按飞鸽的商品卡样式渲染（图片/价格/保障/动作按钮） */}
                <div className="message-bubble message-bubble-card">
                  <FeigeProductCard
                    product={activeSession.product}
                    onSpec={openSpec}
                    onQuote={() => insertPhrase('亲，这款到手价 {价格}，用券后更划算，我帮您算一下～')}
                    onInvite={() => insertPhrase('亲，这款现在有活动价，喜欢可以先拍下，我帮您留意发货～')}
                  />
                </div>
              </div>
            </div>
          )}
          {/* 飞鸽在买家商品卡下面会有一条系统提示；这里用我们自己的说法还原这一行 */}
          {activeSession?.product ? (
            <div className="message-row">
              <div className="message-avatar system">系统</div>
              <div className="message-main">
                <div className="message-bubble" style={{ background: '#fafafa', borderColor: '#f0f0f0', color: '#8c8c8c' }}>
                  买家正在浏览该商品（来自商品详情页），可以直接用卡片上的「规格/属性」「计算价格」回应
                </div>
              </div>
            </div>
          ) : null}
          {activeMessages.map((m) => (
            <div key={m.id} className={`message-row ${m.sender === 'agent' ? 'agent' : ''}`}>
              {/* 参考图 1：头像 + 昵称 + 时间 + 气泡 */}
              <div className={`message-avatar ${m.sender}`}>
                {m.sender === 'buyer'
                  ? String(queueNumber.get(m.sessionId) ?? 0).padStart(2, '0')
                  : m.sender === 'agent'
                    ? (profile?.displayName || '客服').slice(0, 1)
                    : '系统'}
              </div>
              <div className="message-main">
                <div className="message-head">
                  <span className="message-sender">
                    {m.sender === 'buyer' ? activeSession?.buyerName || '买家' : m.sender === 'agent' ? '我' : '系统消息'}
                  </span>
                  {/* 客户 2026-10-03：推送的问题要能区分售前/售后；售后问题系统会自动生成订单 */}
                  {m.sender === 'buyer' &&
                  activeSession?.questions?.find((q: any) => q.seq === m.seq)?.stage ? (
                    <Tag
                      color={
                        activeSession.questions.find((q: any) => q.seq === m.seq)?.stage === 'aftersale'
                          ? 'orange'
                          : 'default'
                      }
                      style={{ marginInlineEnd: 0 }}
                    >
                      {activeSession.questions.find((q: any) => q.seq === m.seq)?.stage === 'aftersale' ? '售后' : '售前'}
                    </Tag>
                  ) : null}
                  <span className="message-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN')}</span>
                </div>
                <div
                  className="message-bubble"
                  style={
                    m.sender === 'system'
                      ? { background: '#fff7e6', borderColor: '#ffe7ba', color: '#ad6800' }
                      : undefined
                  }
                >
                  {m.content.startsWith('【商品卡片】') ? (
                    /**
                     * 客户 2026-10-03：对齐飞鸽会话页的商品卡——图片 + 标题 + 价格 + 保障标签
                     * + 库存/物流 + 底部动作按钮组（… / 计算价格 / 邀请下单 / 规格·属性）。
                     * 卡片内容全部来自会话快照里的商品（也就是管理员在《商品库》维护的那份数据）。
                     */
                    (() => {
                      /**
                       * 卡片里带的是商品ID，优先按它在商品库里找那条真实商品——
                       * 这样从「商品」页签发别的商品时，图片/价格/服务承诺也是那件商品的，不会串。
                       */
                      const cardNo = (m.content.split(' 商品ID：')[1] || '').trim().split(' ')[0];
                      const cardProduct =
                        libraryProducts.find((item: any) => String(item.productNo) === cardNo) || activeSession?.product;
                      return (
                        <FeigeProductCard
                          product={cardProduct}
                          onSpec={() => openSpecOf(cardProduct)}
                          onQuote={() =>
                            insertPhrase(
                              `亲，这款到手价 ¥${cardProduct?.price ?? ''}${
                                cardProduct?.originPrice ? `，划线价 ¥${cardProduct.originPrice}` : ''
                              }，我帮您算一下用券后的价格～`
                            )
                          }
                          onInvite={() => insertPhrase('亲，这款现在有活动价，喜欢可以先拍下，我帮您留意发货～')}
                        />
                      );
                    })()
                  ) : (
                    m.content
                  )}
                </div>
                {((m.sender === 'agent' && m.responseSec !== null) ||
                  m.isTimeout ||
                  m.ruleResult?.businessAction ||
                  m.ruleResult?.invalid ||
                  m.ruleResult?.hitPoints?.length > 0) && (
                  <div className="message-meta">
                    {/* 飞鸽：客服消息右侧有「已读」回执（训练环境按"买家已看到"处理） */}
                    {m.sender === 'agent' ? <span className="message-read">已读</span> : null}
                    {/* 客户 2026-10-03：订单卡片上的平台侧操作记为业务动作，对话里留痕 */}
                    {m.ruleResult?.businessAction && (
                      <Tag color="blue" style={{ marginInlineEnd: 6 }}>
                        业务动作 · {m.ruleResult.businessAction.name}
                      </Tag>
                    )}
                    {m.ruleResult?.invalid && (
                      <Tooltip title={m.ruleResult?.invalidReason || '命中无效回复判定规则'}>
                        <Tag color="red" style={{ marginInlineEnd: 6 }}>
                          被判无效回复
                        </Tag>
                      </Tooltip>
                    )}
                    {m.sender === 'agent' && m.responseSec !== null && `响应 ${m.responseSec}s`}
                    {m.isTimeout && <span style={{ color: '#cf1322' }}> · 超时</span>}
                    {m.ruleResult?.hitPoints?.length > 0 && (
                      <span style={{ color: '#389e0d' }}> · 命中要点 {m.ruleResult.hitPoints.length} 项</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="reception-input">
          {/* 提示模式（方案 F1-15）：仅教学用，不计入评分 */}
          {systemParams?.hintMode &&
          activeSession &&
          running &&
          activeSession.waitedSec >= (systemParams.hintDelaySec ?? 60) &&
          !activeMessages.some((m) => m.sender === 'agent') ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={`买家已等待 ${activeSession.waitedSec} 秒，还没收到回复`}
              description={
                <span>
                  话术思路：先回应买家当前这一问 —— 「
                  {activeSession.questions?.find((q) => q.seq === activeSession.seq)?.question || '买家的问题'}」，
                  要点覆盖：
                  {(
                    activeSession.questions?.find((q) => q.seq === activeSession.seq)?.keyPoints || ['先回应再解释']
                  ).join('、')}
                  。<span style={{ color: '#8c8c8c' }}>（提示模式仅用于教学，不影响本次评分）</span>
                </span>
              }
            />
          ) : null}
          {/* 工具栏（严格参考图 1：左组「内容类」图标 + 右组「媒体类」图标；方案 3.1.5 的六项能力均在此） */}
          <div className="reception-toolbar">
            <div className="reception-toolbar-group">
              <Tooltip title="表情（训练环境暂未开放）">
                <Button type="text" size="small" icon={<SmileOutlined />} disabled />
              </Tooltip>
              <Tooltip title="图片（训练环境暂未开放）">
                <Button type="text" size="small" icon={<PictureOutlined />} disabled />
              </Tooltip>
              <Tooltip title="订单卡片（F1-09 属二期，一期不接入真实订单）">
                <Button type="text" size="small" icon={<FormOutlined />} disabled />
              </Tooltip>
              <Tooltip title="素材库（训练环境暂未开放）">
                <Button type="text" size="small" icon={<FolderOpenOutlined />} disabled />
              </Tooltip>
              <Tooltip title="常用语：打开右栏快捷短语">
                <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => setRightTab('phrase')} />
              </Tooltip>
              <Tooltip title="话术拆分（训练环境暂未开放）">
                <Button type="text" size="small" icon={<ScissorOutlined />} disabled />
              </Tooltip>
            </div>
            <div className="reception-toolbar-group">
              <Tooltip title="视频（训练环境暂未开放）">
                <Button type="text" size="small" icon={<VideoCameraOutlined />} disabled />
              </Tooltip>
              <Tooltip title="语音（训练环境暂未开放）">
                <Button type="text" size="small" icon={<AudioOutlined />} disabled />
              </Tooltip>
              <Tooltip title="发送位置（训练环境暂未开放）">
                <Button type="text" size="small" icon={<EnvironmentOutlined />} disabled />
              </Tooltip>
              <Tooltip title="转译（训练环境暂未开放）">
                <Button type="text" size="small" icon={<TranslationOutlined />} disabled />
              </Tooltip>
              <span className="reception-toolbar-divider" />
              <Tooltip title="快捷短语：插入话术模板（含变量会按当前会话替换）">
                <Button type="text" size="small" icon={<ThunderboltOutlined />} onClick={() => setRightTab('phrase')} />
              </Tooltip>
              <Tooltip title="把当前咨询商品卡片插入对话">
                <Button
                  type="text"
                  size="small"
                  icon={<ShoppingOutlined />}
                  disabled={!activeSession?.product}
                  onClick={sendProductCard}
                />
              </Tooltip>
              <span className="reception-toolbar-divider" />
              <Tooltip title="转交主管（该问题需主管介入时使用）">
                <Button type="text" size="small" icon={<SwapOutlined />} disabled={!running} onClick={transfer} />
              </Tooltip>
              <Tooltip title="结束当前会话">
                <Button type="text" size="small" icon={<CloseOutlined />} disabled={!running} onClick={finishSession} />
              </Tooltip>
            </div>
          </div>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="请输入回复内容…"
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={!running || !activeSession}
            onPressEnter={(e) => {
              if (!e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {/* 参考图 1：输入区底行的「发送快捷键提示（左）+ 发送按钮（右）」 */}
          <div className="reception-send-row">
            {/* 飞鸽：提示里带买家昵称，右下角还有字数计数 */}
            <span className="reception-input-hint">
              发送给 {activeSession?.buyerName || '买家'}，使用 Enter 发送消息，使用 Ctrl + Enter 换行
            </span>
            <span className="reception-input-count">
              {input.length}/{systemParams?.messageMaxLength ?? 800}
            </span>
            <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={send} disabled={!running}>
              发送
            </Button>
          </div>
        </div>
      </div>

      <div className="reception-right">
        {activeSession && activeSession.remainSec <= 30 && running && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ marginBottom: 12 }}
            message={`${activeSession.buyerName} 即将超时，请优先回复`}
          />
        )}
        {/* 任务卡（方案 F6-06）：只在任务训练时常驻右栏，一期自由练习不展示 */}
        {attempt?.task && (
          <div className="task-card">
            <div className="task-card-head">
              <Tag color="blue">任务训练</Tag>
              <span className="task-card-name">{attempt.task.name}</span>
            </div>
            <div className="task-card-line">
              需完成 <b>{attempt.task.targetCount}</b> 次，当前 <b>{attempt.task.doneCount}</b> 次
            </div>
            {(attempt.task.targets || []).map((target: any, index: number) => (
              <div className="task-card-line" key={index}>
                <span className="task-card-dot" />
                {target.metric === 'total_score' ? '总分' : target.metric === 'first_response' ? '首次响应' : '超时次数'}{' '}
                {target.operator === 'gte' ? '≥' : '≤'} {target.threshold}
                {target.metric === 'total_score' ? ' 分' : target.metric === 'first_response' ? ' 秒' : ' 次'}
              </div>
            ))}
            <div className="task-card-line">
              截止 {dayjs(attempt.task.deadline).format('MM-DD HH:mm')}
              {dayjs(attempt.task.deadline).isBefore(dayjs()) ? (
                <Tag color="red" style={{ marginLeft: 6 }}>
                  已截止
                </Tag>
              ) : (
                <Tag color="blue" style={{ marginLeft: 6 }}>
                  还剩 {dayjs(attempt.task.deadline).diff(dayjs(), 'hour')} 小时
                </Tag>
              )}
            </div>
          </div>
        )}
        <Tabs
          activeKey={rightTab}
          onChange={setRightTab}
          items={[
            {
              key: 'order',
              label: '订单',
              children: (
                <div>
                  {/* 客户 2026-10-03：对齐飞鸽——「订单」页签顶部也有「咨询宝贝」块与商品动作按钮 */}
                  {activeSession?.product ? (
                    <>
                      <div className="right-section-title">
                        <span>咨询宝贝</span>
                        <span className="right-section-links">浏览足迹 · 爆品推荐</span>
                      </div>
                      <div className="consult-product">
                        <div className="consult-product-thumb">
                          {activeSession.product.coverUrl ? (
                            <img src={activeSession.product.coverUrl} alt="" />
                          ) : (
                            <ShoppingOutlined />
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="consult-product-title">{activeSession.product.title}</div>
                          <div className="consult-product-price">
                            ¥{activeSession.product.price}
                            {activeSession.product.stock !== undefined ? (
                              <span className="consult-product-stock">库存 {activeSession.product.stock}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="consult-actions" style={{ marginBottom: 12 }}>
                        <Button size="small" onClick={() => insertPhrase('亲，这款现在有活动价，喜欢可以先拍下，我帮您留意发货～')}>
                          邀请下单
                        </Button>
                        <Button size="small" onClick={() => insertPhrase('亲，这款到手价 {价格}，用券后更划算，我帮您算一下～')}>
                          计算价格
                        </Button>
                        <Button size="small" onClick={openSpec}>
                          规格属性
                        </Button>
                        <Button size="small" onClick={() => insertPhrase('亲，这款有实拍视频，我发给您参考一下～')}>
                          商品视频
                        </Button>
                      </div>
                    </>
                  ) : null}
                  {/* 订单状态页签（参考图 1：全部 / 未完结 / 售后中 / 已完结 / 已关闭） */}
                  <div className="order-status-tabs">
                    {['全部', '未完结', '售后中', '已完结', '已关闭'].map((label, index) => (
                      <span key={label} className={`order-status-tab ${index === 0 ? 'active' : ''}`}>
                        {label}
                      </span>
                    ))}
                    <span className="order-status-actions">
                      <ReloadOutlined />
                      <SearchOutlined />
                    </span>
                  </div>
                  {activeSession?.order ? (
                    /* 客户 2026-10-03：按三张参考图还原抖店工作台订单卡片（三态字段/操作不同） */
                    <OrderCard
                      order={activeSession.order}
                      product={activeSession.product}
                      onSend={(text) => setInput((prev) => (prev ? `${prev}${text}` : text))}
                      onAction={runBusinessAction}
                      actionPending={actionPending}
                    />
                  ) : (
                    <div className="reception-empty">
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无订单" />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'product',
              label: '商品',
              children: (
                <div>
                  {/**
                   * 客户 2026-10-03：「商品」页签不放「咨询宝贝」（那是订单页签的事），
                   * 这里展示**《商品库》里的商品**——可搜索、可按分类筛，直接发送商品卡片或看规格属性。
                   */}
                  <div className="right-section-title">
                    <span>商品库</span>
                    <span className="right-section-links">共 {libraryProducts.length} 件</span>
                  </div>
                  <Input
                    size="small"
                    allowClear
                    prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                    placeholder="搜索商品名称 / 商品ID"
                    value={libraryKeyword}
                    onChange={(e) => setLibraryKeyword(e.target.value)}
                  />
                  <Select
                    size="small"
                    allowClear
                    placeholder="全部分类"
                    style={{ width: '100%', marginTop: 8 }}
                    value={libraryCategory}
                    onChange={setLibraryCategory}
                    options={libraryCategories.map((name) => ({ value: name, label: name }))}
                  />
                  <div className="right-product-list">
                    {visibleLibraryProducts.length ? (
                      visibleLibraryProducts.map((item: any) => (
                        <div className="right-product-item" key={item.id}>
                          <div className="consult-product-thumb">
                            {item.coverUrl ? <img src={item.coverUrl} alt="" /> : <ShoppingOutlined />}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="consult-product-title">{item.title}</div>
                            <div className="consult-product-meta">
                              {item.category || '未分类'} · 商品ID：{item.productNo}
                            </div>
                            <div className="consult-product-price">
                              ¥{item.price}
                              <span className="consult-product-stock">库存 {item.stock ?? '—'}</span>
                            </div>
                            <div className="consult-actions" style={{ marginTop: 6 }}>
                              <Button size="small" onClick={() => sendProductCardOf(item)}>
                                发送卡片
                              </Button>
                              <Button size="small" onClick={() => openSpecOf(item)}>
                                规格属性
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="reception-empty">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="商品库里没有匹配的商品" />
                      </div>
                    )}
                  </div>
                </div>
              ),
            },
            {
              /** 飞鸽右栏第 3 个页签是「会话搜索」：在当前会话的聊天记录里搜关键词 */
              key: 'search',
              label: '会话搜索',
              children: (
                <div>
                  <Input
                    allowClear
                    prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                    placeholder="搜索本会话的聊天记录"
                    value={messageSearch}
                    onChange={(e) => setMessageSearch(e.target.value)}
                  />
                  <div style={{ marginTop: 10 }}>
                    {!activeSession ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择会话" />
                    ) : !messageSearch.trim() ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        输入关键词后，这里列出当前会话里命中的消息（共 {activeMessages.length} 条记录）。
                      </Typography.Text>
                    ) : (
                      <List
                        size="small"
                        dataSource={activeMessages.filter((m) =>
                          m.content.toLowerCase().includes(messageSearch.trim().toLowerCase())
                        )}
                        locale={{ emptyText: '没有命中的聊天记录' }}
                        renderItem={(m: any) => (
                          <List.Item>
                            <div style={{ fontSize: 12, lineHeight: '18px' }}>
                              <span style={{ color: '#8c8c8c', marginRight: 6 }}>
                                {m.sender === 'buyer' ? '买家' : m.sender === 'agent' ? '我' : '系统'} ·{' '}
                                {new Date(m.createdAt).toLocaleTimeString('zh-CN')}
                              </span>
                              <span>{m.content}</span>
                            </div>
                          </List.Item>
                        )}
                      />
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: 'phrase',
              label: '快捷短语',
              children: (
                <List
                  size="small"
                  dataSource={phrases}
                  renderItem={(item: any) => (
                    <List.Item
                      style={{ cursor: 'pointer' }}
                      onClick={() => usePhrase(item)}
                      actions={[
                        <Tag key="c">{item.category}</Tag>,
                        <span key="u" style={{ fontSize: 12, color: '#bfbfbf' }}>
                          用过 {item.usedCount ?? 0} 次
                        </span>,
                      ]}
                    >
                      <List.Item.Meta title={item.title} description={<span style={{ fontSize: 12 }}>{item.content}</span>} />
                    </List.Item>
                  )}
                />
              ),
            },
          ]}
        />
      </div>

      <Modal
        open={!!result}
        title="本次接待结果"
        footer={[
          <Button key="close" type="primary" onClick={() => setResult(null)}>
            知道了
          </Button>,
        ]}
        width={720}
        onCancel={() => setResult(null)}
      >
        {result && (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Statistic title="接待总分" value={result.totalScore} precision={1} suffix="分" />
              </Col>
              <Col span={8}>
                <Statistic
                  title="结论"
                  value={result.conclusion === 'pass' ? '达标' : '未达标'}
                  valueStyle={{ color: result.conclusion === 'pass' ? '#389e0d' : '#cf1322' }}
                />
              </Col>
              <Col span={8}>
                <Statistic title="会话数" value={result.sessions?.length || 0} />
              </Col>
            </Row>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={result.sessions || []}
              columns={[
                { title: '买家', dataIndex: 'buyerName' },
                { title: '剧本', dataIndex: 'scriptName', render: (v: string) => v || '已删除剧本' },
                { title: '响应时效', dataIndex: 'responseScore', render: (v) => `${v ?? '-'}` },
                { title: '问题解决', dataIndex: 'solvingScore', render: (v) => `${v ?? '-'}` },
                { title: '话术规范', dataIndex: 'wordingScore', render: (v) => `${v ?? '-'}` },
                { title: '情绪安抚', dataIndex: 'emotionScore', render: (v) => `${v ?? '-'}` },
                { title: '会话得分', dataIndex: 'totalScore', render: (v) => `${v ?? '-'}` },
              ]}
            />
            <div style={{ marginTop: 16 }}>
              <Button type="link" onClick={() => (window.location.href = `/records/${result.attemptId}`)}>
                查看明细与逐条复盘
              </Button>
              <Button
                type="link"
                onClick={() => {
                  setResult(null);
                  setParams({});
                }}
              >
                再来一次
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* 会话备注（方案 3.1.5：对话区顶部提供备注入口） */}
      <Modal
        open={remarkOpen}
        title={`给 ${activeSession?.buyerName || '当前会话'} 添加备注`}
        onCancel={() => setRemarkOpen(false)}
        onOk={saveRemark}
        okText="保存备注"
        width={520}
      >
        <Input.TextArea
          rows={4}
          value={remarkText}
          onChange={(e) => setRemarkText(e.target.value)}
          placeholder="例如：该买家对发货时效特别敏感，回复时先给明确时间点"
        />
      </Modal>
      {/* 商品「规格 / 属性」：展示管理员在《商品库》里维护的真实商品信息 */}
      <ProductSpecModal
        open={specOpen}
        product={specProduct || activeSession?.product}
        onClose={() => {
          setSpecOpen(false);
          setSpecProduct(null);
        }}
      />
      </div>
    </div>
  );
}
