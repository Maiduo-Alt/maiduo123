import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Slider,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { DeleteOutlined, DownloadOutlined, ImportOutlined, PlusOutlined, QuestionCircleOutlined, ReloadOutlined, AppstoreOutlined, ScissorOutlined, UploadOutlined } from '@ant-design/icons';
import { api, download, uploadImage } from '../api/client';

/**
 * 长截图智能切分（2026-10-09 客户新增）：把商品详情页长截图按空白/纯色间隙切成详情图分段。
 * range 为框选区域（百分比），只切框选范围；每段最短 80px、最长 1600px，
 * 切点取空白间隙带的中点（间隙里不留白边）。
 */
const sliceLongScreenshot = async (file: File, range: [number, number]): Promise<Blob[]> => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片加载失败'));
    el.src = dataUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片尺寸异常');
  const startY = Math.max(0, Math.min(h - 1, Math.round((h * range[0]) / 100)));
  const endY = Math.max(startY + 1, Math.min(h, Math.round((h * range[1]) / 100)));
  const MAX_H = 1600;
  const MIN_SEG = 80;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持画布');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const blankRow = (y: number): boolean => {
    const off = y * w * 4;
    const r0 = data[off];
    const g0 = data[off + 1];
    const b0 = data[off + 2];
    let same = 0;
    let total = 0;
    for (let x = 0; x < w; x += 4) {
      const i = off + x * 4;
      if (Math.abs(data[i] - r0) < 12 && Math.abs(data[i + 1] - g0) < 12 && Math.abs(data[i + 2] - b0) < 12) same++;
      total++;
    }
    return same / total > 0.97;
  };
  // 整幅 sharp 横边界（相邻行大面积突变）= 图片拼接边：详情图无缝并排时靠它找切点
  const boundaryRow = (y: number): boolean => {
    const off = y * w * 4;
    const prev = off - w * 4;
    let strong = 0;
    let total = 0;
    for (let x = 0; x < w; x += 4) {
      const i = off + x * 4;
      const j = prev + x * 4;
      const d =
        Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      if (d > 90) strong++;
      total++;
    }
    return strong / total > 0.5;
  };
  interface Cut {
    at: number;
    next: number;
  }
  const cuts: Cut[] = [];
  let segStart = startY;
  while (segStart < endY - MIN_SEG) {
    const limit = Math.min(segStart + MAX_H, endY);
    let found: Cut | null = null;
    for (let y = segStart + MIN_SEG; y < limit; y++) {
      if (blankRow(y)) {
        let ge = y;
        while (ge < limit && ge - y < 60 && blankRow(ge)) ge++;
        found = { at: y, next: ge }; // 段在空白带前结束，下一段从空白带后开始
        break;
      }
      // 距段首 ≥150px 才认 sharp 边界，避免照片顶部的门框/腰线等整幅横线造成碎段
      if (y - segStart >= 150 && boundaryRow(y)) {
        found = { at: y, next: y }; // 边界行归入下一段（照片顶边完整保留）
        break;
      }
    }
    if (!found) {
      if (endY - segStart > MAX_H) found = { at: segStart + MAX_H, next: segStart + MAX_H };
      else break;
    }
    cuts.push(found);
    segStart = found.next;
  }
  const toBlob = (c: HTMLCanvasElement) =>
    new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), 'image/png')
    );
  // 过碎段（<180px，多为照片顶部门框/腰线误切出的细条）并入其后一段
  const segs: { from: number; to: number }[] = [];
  let prev = startY;
  for (const c of cuts) {
    segs.push({ from: prev, to: c.at });
    prev = c.next;
  }
  segs.push({ from: prev, to: endY });
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].to - segs[i].from < 180) {
      segs[i + 1].from = segs[i].from;
      segs.splice(i, 1);
      i--;
    }
  }
  const parts: Blob[] = [];
  const pushSegment = async (from: number, to: number) => {
    if (to - from <= 4) return;
    const seg = document.createElement('canvas');
    seg.width = w;
    seg.height = to - from;
    const sctx = seg.getContext('2d');
    if (!sctx) throw new Error('浏览器不支持画布');
    sctx.drawImage(canvas, 0, from, w, to - from, 0, 0, w, to - from);
    parts.push(await toBlob(seg));
  };
  for (const s of segs) await pushSegment(s.from, s.to);
  return parts;
};

export default function Products() {
  const [list, setList] = useState<any[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 10 });
  const [modal, setModal] = useState<{ open: boolean; record?: any }>({ open: false });
  /** 表格勾选的商品 id（批量删除用） */
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [xlsxBase64, setXlsxBase64] = useState('');
  const [xlsxName, setXlsxName] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  /** 一键添加商品：分享链接识别（2026-10-07 客户新增） */
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  /** 使用说明：一键添加商品操作说明卡（2026-10-08 客户新增） */
  const [guideOpen, setGuideOpen] = useState(false);
  /** 分类管理（2026-10-09 客户新增）：商品分类字典的增删改，复用 /api/categories?type=product */
  const [dictCategories, setDictCategories] = useState<string[]>([]);
  const [catOpen, setCatOpen] = useState(false);
  const [catRows, setCatRows] = useState<any[]>([]);
  const [catEditing, setCatEditing] = useState<any>(null);
  const [catForm] = Form.useForm();
  /**
   * 预填数据暂存（2026-10-09 修复）：新建商品弹窗开启 destroyOnClose，
   * 表单字段在弹窗动画期间才挂载，同步 setFieldsValue 会丢失图片类字段
   * （插件采集与链接识别都中过招），改为弹窗完全打开后（afterOpenChange）再填值。
   */
  const [pendingPrefill, setPendingPrefill] = useState<any>(null);
  /** 长截图切分（2026-10-09 客户新增）：上传详情页长截图，框选商品详情区域后自动切分填入 */
  const [longshotOpen, setLongshotOpen] = useState(false);
  const [longshotUrl, setLongshotUrl] = useState('');
  const [longshotRange, setLongshotRange] = useState<[number, number]>([0, 100]);
  const [longshotDoing, setLongshotDoing] = useState(false);
  const longshotFileRef = useRef<File | null>(null);
  const longshotInputRef = useRef<HTMLInputElement>(null);

  const openLongshotPicker = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (longshotUrl) URL.revokeObjectURL(longshotUrl);
    longshotFileRef.current = f;
    setLongshotUrl(URL.createObjectURL(f));
    setLongshotRange([0, 100]);
    setLongshotOpen(true);
  };

  const applyLongshot = async () => {
    const f = longshotFileRef.current;
    if (!f) return;
    setLongshotDoing(true);
    try {
      const parts = await sliceLongScreenshot(f, longshotRange);
      if (!parts.length) throw new Error('框选范围内没有可切分的内容');
      const room = Math.max(0, 10 - detailImages.length);
      const hide = message.loading('正在上传切分结果…', 0);
      const urls: string[] = [];
      for (const p of parts.slice(0, room)) {
        urls.push(await uploadImage(new File([p], 'detail.png', { type: 'image/png' })));
      }
      hide();
      const next = [...(form.getFieldValue('detailImages') || []), ...urls];
      form.setFieldValue('detailImages', next);
      setDetailImages(next);
      setLongshotOpen(false);
      message.success(
        `长截图已切分 ${parts.length} 段，填入 ${urls.length} 张详情图` +
          (parts.length > room ? `（超出 10 张上限，${parts.length - room} 段未填入）` : '')
      );
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLongshotDoing(false);
    }
  };

  const applyPrefill = (data: any) => {
    setPendingPrefill(data);
    setModal({ open: true });
  };

  const fillFormAfterOpen = () => {
    if (!pendingPrefill) return;
    const data = pendingPrefill;
    setPendingPrefill(null);
    form.resetFields();
    form.setFieldsValue({
      title: data.title || '',
      price: data.price ?? undefined,
      originPrice: data.originPrice ?? undefined,
      coverUrl: data.coverUrl || '',
      detailImages: data.detailImages || [],
      // 插件采集的 SKU 规格（2026-10-09）：名称/尺码自动填入，价格/库存页面不直接暴露，留空由用户核对
      skus: (data.skus || [])
        .map((s: any) => {
          let name = String(s.name || '').trim();
          let size = String(s.size || '').trim();
          // 兼容插件旧格式「颜色/尺码」合并名：拆成 名称 + 尺码；只有尺码时名称兜底用尺码
          if (!size && name.includes('/')) {
            const i = name.indexOf('/');
            size = name.slice(i + 1).trim();
            name = name.slice(0, i).trim();
          }
          if (!name && size) {
            name = size;
            size = '';
          }
          return {
            name,
            size,
            price: typeof s.price === 'number' ? s.price : undefined,
            stock: typeof s.stock === 'number' ? s.stock : undefined,
          };
        })
        .filter((s: any) => s.name || s.size),
      services: [],
      scenes: [],
    });
    setCoverUrl(data.coverUrl || '');
    setDetailImages(data.detailImages || []);
  };

  /** 分类下拉 = 商品分类字典 ∪ 商品上已在用的分类（兼容历史未登记的数据） */
  const categoryOptions = Array.from(new Set([...dictCategories, ...categories]));

  const loadDictCategories = async () => {
    try {
      const rows = await api<any[]>('/categories', { query: { type: 'product' } });
      setDictCategories((Array.isArray(rows) ? rows : []).map((r: any) => r.name));
    } catch {
      /* 字典不可用时退回商品上已有的分类 */
    }
  };

  const loadCatRows = async () => {
    try {
      const rows = await api<any[]>('/categories', { query: { type: 'product' } });
      setCatRows(Array.isArray(rows) ? rows : []);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openCatManage = () => {
    setCatOpen(true);
    setCatEditing(null);
    void loadCatRows();
  };

  const saveCat = async () => {
    const values = await catForm.validateFields();
    try {
      if (catEditing?.id) {
        const res = await api<any>(`/categories/${catEditing.id}`, { method: 'PUT', body: { name: values.name } });
        message.success(res.renamed ? `已改名，并同步更新了 ${res.renamed} 个商品的分类` : '已改名');
      } else {
        await api('/categories', { method: 'POST', body: { type: 'product', name: values.name } });
        message.success('已新增分类');
      }
      setCatEditing(null);
      await loadCatRows();
      await loadDictCategories();
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const removeCat = async (row: any) => {
    try {
      await api(`/categories/${row.id}`, { method: 'DELETE' });
      message.success('已删除分类');
      await loadCatRows();
      await loadDictCategories();
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const [form] = Form.useForm();
  // 筛选条（方案 F4-05：标题 / 商品ID、分类、价格区间、状态）
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | undefined>();
  const [filterMinPrice, setFilterMinPrice] = useState<number | null>(null);
  const [filterMaxPrice, setFilterMaxPrice] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<number | undefined>();
  // 2026-10-09 修复：coverUrl/detailImages 是未注册字段（Form.Item 无 name），
  // setFieldsValue 写入后 Form.useWatch 不会触发重渲染，导致预填的图片不显示。
  // 改为受控 state + form store 双写：渲染读 state，保存时 validateFields 仍从 store 取值。
  const [coverUrl, setCoverUrl] = useState('');
  const [detailImages, setDetailImages] = useState<string[]>([]);

  const applyFilter = () =>
    load({
      keyword: filterKeyword || undefined,
      category: filterCategory,
      minPrice: filterMinPrice ?? undefined,
      maxPrice: filterMaxPrice ?? undefined,
      status: filterStatus,
      page: 1,
    });

  const resetFilter = () => {
    setFilterKeyword('');
    setFilterCategory(undefined);
    setFilterMinPrice(null);
    setFilterMaxPrice(null);
    setFilterStatus(undefined);
    load({ keyword: undefined, category: undefined, minPrice: undefined, maxPrice: undefined, status: undefined, page: 1 });
  };

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setSelectedIds([]);
    setLoading(true);
    try {
      const res = await api<any>('/products', { query: next });
      setList(res.list || []);
      setTotal(res.total || 0);
      setCategories(res.categories || []);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 一键添加商品（2026-10-07 客户新增）：识别分享链接 → 预填新建表单（不落库）。
   * 识别失败（链接无效/平台不支持/页面有验证）时提示原因，由用户手动新建。
   */
  const importFromLink = async () => {
    if (!linkText.trim()) {
      message.warning('请先粘贴商品分享链接');
      return;
    }
    setLinkLoading(true);
    try {
      const data = await api<any>('/products/import-from-link', { method: 'POST', body: { url: linkText.trim() } });
      setLinkOpen(false);
      setLinkText('');
      applyPrefill(data);
      message.success('已识别商品信息，请核对后保存（商品ID 需手动填写）');
      if (data.notice) message.warning(data.notice, 6);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLinkLoading(false);
    }
  };

  useEffect(() => {
    load({ page: 1 });
    loadDictCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 浏览器插件「一键采集」预填（2026-10-09 客户新增）：
   * 插件把商品页采集结果写入 localStorage 并派发事件，这里消费后打开新建表单。
   * 挂载时读一次（兜底），事件再兜一次（插件注入晚于 React 挂载的场景）。
   */
  const consumeQuickAdd = () => {
    try {
      const err = window.localStorage.getItem('cs-training-quickadd-error');
      if (err) {
        window.localStorage.removeItem('cs-training-quickadd-error');
        message.warning(err, 6);
        return;
      }
      const raw = window.localStorage.getItem('cs-training-quickadd');
      if (!raw) return;
      window.localStorage.removeItem('cs-training-quickadd');
      const data = JSON.parse(raw);
      applyPrefill(data);
      message.success(
        `已${data.platform ? `从${data.platform}` : ''}采集商品信息（插件 v${data.extensionVersion || '?'}：价格${data.price ?? '未获取'}，图片${(data.detailImages || []).length + (data.coverUrl ? 1 : 0)}张${(data.skus || []).length ? `，规格${(data.skus || []).length}个` : ''}），请核对后保存（商品ID 需手动填写）`,
        6
      );
      if (!data.price || !data.coverUrl) message.warning('价格或主图未采集完整，请手动补充', 6);
    } catch {
      /* 忽略坏数据 */
    }
  };

  useEffect(() => {
    consumeQuickAdd();
    window.addEventListener('cs-training-quickadd', consumeQuickAdd);
    return () => window.removeEventListener('cs-training-quickadd', consumeQuickAdd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 批量删除商品（2026-10-07 客户新增）：未被剧本引用的软删除；
   * 被剧本引用的逐个跳过并提示——先在《客户问题剧本》删掉相关剧本，再回来删商品。
   */
  const removeProducts = async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const res = await api<any>('/products/batch-delete', { method: 'POST', body: { ids } });
      setSelectedIds([]);
      if (res.blocked?.length) {
        const names = res.blocked
          .slice(0, 3)
          .map((b: any) => `${b.title}（被 ${b.scriptCount} 个剧本引用）`)
          .join('、');
        message.warning(
          `已删除 ${res.deleted} 个商品；${res.blocked.length} 个被剧本引用未删除：${names}` +
            (res.blocked.length > 3 ? ` 等 ${res.blocked.length} 个` : '') +
            '。可先在《客户问题剧本》删除相关剧本，再回来删除商品'
        );
      } else {
        message.success(`已删除 ${res.deleted} 个商品`);
      }
      load({ page: 1 });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    const body = {
      productNo: values.productNo,
      title: values.title,
      price: values.price,
      originPrice: values.originPrice,
      stock: values.stock,
      category: values.category,
      coverUrl: values.coverUrl || '',
      detailImages: values.detailImages || [],
      services: values.services || [],
      scenes: values.scenes || [],
      // 客户 2026-10-03：规格（SKU）交给管理员维护，接待页「规格/属性」读的就是这份数据
      skus: (values.skus || []).filter(
        (item: any) => item && (String(item.name || '').trim() || String(item.size || '').trim())
      ),
    };
    try {
      if (modal.record) await api(`/products/${modal.record.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      message.success('已保存');
      setModal({ open: false });
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doImport = async () => {
    try {
      const res = await api<any>('/products/import', {
        method: 'POST',
        body: xlsxBase64 ? { xlsxBase64 } : { csv },
      });
      setImportResult(res);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card
      className="page-card"
      bordered={false}
      title="商品库"
      extra={
        <Space>
          <Button icon={<AppstoreOutlined />} onClick={openCatManage}>
            分类管理
          </Button>
          <Button
            icon={<UploadOutlined />}
            onClick={() => {
              setImportResult(null);
              setXlsxBase64('');
              setXlsxName('');
              setImportOpen(true);
            }}
          >
            批量导入
          </Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                // 导出当前筛选条件下的商品清单，可直接改完再导入
                await download('/products/export', {
                  keyword: filterKeyword || undefined,
                  category: filterCategory,
                  minPrice: filterMinPrice ?? undefined,
                  maxPrice: filterMaxPrice ?? undefined,
                  status: filterStatus,
                });
                message.success('已开始下载商品清单 Excel');
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            导出 Excel
          </Button>
          <Popconfirm
            title={`确认删除选中的 ${selectedIds.length} 个商品？`}
            description="被剧本引用的商品会被自动跳过"
            onConfirm={() => removeProducts(selectedIds)}
            disabled={!selectedIds.length}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedIds.length}>
              批量删除{selectedIds.length ? `（${selectedIds.length}）` : ''}
            </Button>
          </Popconfirm>
          <Button icon={<ImportOutlined />} onClick={() => setLinkOpen(true)}>
            一键添加
          </Button>
          <Button icon={<QuestionCircleOutlined />} onClick={() => setGuideOpen(true)}>
            使用说明
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setModal({ open: true });
              form.resetFields();
              setCoverUrl('');
              setDetailImages([]);
            }}
          >
            新建商品
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
        </Space>
      }
    >
      {/* 筛选条（方案 F4-05：按标题 / 商品ID、分类、价格区间、状态筛选） */}
      <div className="library-filter" style={{ padding: 0, marginBottom: 12 }}>
        <Input.Search
          placeholder="商品标题 / 商品ID"
          allowClear
          style={{ width: 240 }}
          value={filterKeyword}
          onChange={(e) => setFilterKeyword(e.target.value)}
          onSearch={applyFilter}
        />
        <Select
          allowClear
          placeholder="分类"
          style={{ width: 140 }}
          value={filterCategory}
          onChange={(v) => setFilterCategory(v)}
          options={categoryOptions.map((c) => ({ value: c, label: c }))}
        />
        <Space size={4}>
          <InputNumber
            min={0}
            placeholder="最低价"
            style={{ width: 110 }}
            value={filterMinPrice}
            onChange={(v) => setFilterMinPrice(v as number | null)}
          />
          <span style={{ color: '#bfbfbf' }}>~</span>
          <InputNumber
            min={0}
            placeholder="最高价"
            style={{ width: 110 }}
            value={filterMaxPrice}
            onChange={(v) => setFilterMaxPrice(v as number | null)}
          />
        </Space>
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={filterStatus}
          onChange={(v) => setFilterStatus(v)}
          options={[
            { value: 1, label: '在售' },
            { value: 0, label: '已下架' },
          ]}
        />
        <Button type="primary" onClick={applyFilter}>
          查询
        </Button>
        <Button onClick={resetFilter}>重置</Button>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(Number)),
        }}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 个商品`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          {
            title: '主图',
            dataIndex: 'coverUrl',
            width: 80,
            render: (v) =>
              v ? <img src={v} alt="" style={{ width: 44, height: 44, borderRadius: 6 }} /> : <div style={{ width: 44, height: 44, borderRadius: 6, background: '#f0f2f5' }} />,
          },
          { title: '商品标题', dataIndex: 'title', ellipsis: true },
          { title: '商品ID', dataIndex: 'productNo', width: 200 },
          { title: '价格', dataIndex: 'price', width: 100, render: (v) => `¥${Number(v).toFixed(2)}` },
          { title: '库存', dataIndex: 'stock', width: 80 },
          { title: '分类', dataIndex: 'category', width: 100, render: (v) => <Tag>{v}</Tag> },
          { title: '关联剧本', dataIndex: 'scriptCount', width: 90 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v) => (v === 1 ? <Tag color="blue">上架</Tag> : <Tag>下架</Tag>),
          },
          {
            title: '操作',
            width: 150,
            render: (_, row: any) => (
              <Space>
                <Button
                  type="link"
                  onClick={() => {
                    setModal({ open: true, record: row });
                    form.setFieldsValue(row);
                    setCoverUrl(row.coverUrl || '');
                    setDetailImages(row.detailImages || []);
                    // 列表不返回详情图，编辑时补拉一次，避免保存时把已有详情图覆盖掉
                    api<any>(`/products/${row.id}`)
                      .then((detail) => {
                        form.setFieldsValue({
                          coverUrl: detail.coverUrl || '',
                          detailImages: detail.detailImages || [],
                          // 列表接口不返回规格，编辑时一并补上，避免保存时把已有规格覆盖成空
                          skus: detail.skus || [],
                        });
                        setCoverUrl(detail.coverUrl || '');
                        setDetailImages(detail.detailImages || []);
                      })
                      .catch(() => undefined);
                  }}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除该商品？"
                  onConfirm={async () => {
                    try {
                      await api(`/products/${row.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      load();
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  <Button type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={modal.open}
        title={modal.record ? '编辑商品' : '新建商品'}
        onCancel={() => setModal({ open: false })}
        onOk={save}
        width={680}
        destroyOnClose
        afterOpenChange={(open) => {
          if (open) fillFormAfterOpen();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productNo" label="商品ID" rules={[{ required: true, message: '请输入商品ID' }]}>
            <Input placeholder="例如 3781182303640879201" disabled={!!modal.record} />
          </Form.Item>
          <Form.Item name="title" label="商品标题" rules={[{ required: true, message: '请输入商品标题' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="商品主图">
            <Space align="start">
              <Upload
                listType="picture-card"
                accept="image/*"
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }: any) => {
                  try {
                    const url = await uploadImage(file as File);
                    form.setFieldValue('coverUrl', url);
                    setCoverUrl(url);
                    onSuccess?.({});
                  } catch (e) {
                    message.error((e as Error).message);
                    onError?.(e as Error);
                  }
                }}
              >
                {coverUrl ? (
                  <img src={coverUrl} alt="主图" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div>
                    <PlusOutlined />
                    <div style={{ marginTop: 8 }}>上传主图</div>
                  </div>
                )}
              </Upload>
              <Space direction="vertical" size={4}>
                <Input
                  value={coverUrl}
                  onChange={(e) => {
                    form.setFieldValue('coverUrl', e.target.value);
                    setCoverUrl(e.target.value);
                  }}
                  placeholder="也可直接填写图片地址"
                  style={{ width: 320 }}
                />
                {coverUrl ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      form.setFieldValue('coverUrl', '');
                      setCoverUrl('');
                    }}
                  >
                    清除主图
                  </Button>
                ) : null}
              </Space>
            </Space>
          </Form.Item>
          <Form.Item label="商品详情图" tooltip="最多 10 张，用于接待页商品卡片与详情展示">
            <Space direction="vertical" size={8}>
              <Upload
                listType="picture-card"
                accept="image/*"
                fileList={(detailImages || []).map((url, index) => ({
                  uid: `detail-${index}`,
                  name: `详情图${index + 1}`,
                  status: 'done',
                  url,
                })) as any}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                try {
                  const url = await uploadImage(file as File);
                  const next = [...(form.getFieldValue('detailImages') || []), url];
                  form.setFieldValue('detailImages', next);
                  setDetailImages(next);
                  onSuccess?.({});
                } catch (e) {
                  message.error((e as Error).message);
                  onError?.(e as Error);
                }
              }}
              onRemove={(file) => {
                const filtered = (form.getFieldValue('detailImages') || []).filter(
                  (url: string) => url !== (file as any).url
                );
                form.setFieldValue('detailImages', filtered);
                setDetailImages(filtered);
              }}
            >
              {(detailImages || []).length >= 10 ? null : (
                <div>
                  <PlusOutlined />
                  <div style={{ marginTop: 8 }}>上传详情图</div>
                </div>
              )}
              </Upload>
              <Button icon={<ScissorOutlined />} onClick={() => longshotInputRef.current?.click()}>
                长截图切分填入
              </Button>
              <input ref={longshotInputRef} type="file" accept="image/*" hidden onChange={openLongshotPicker} />
            </Space>
          </Form.Item>
          <Space size={16}>
            <Form.Item name="price" label="销售价" rules={[{ required: true, message: '请输入价格' }]}>
              <InputNumber min={0.01} precision={2} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="originPrice" label="划线价">
              <InputNumber min={0} precision={2} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="stock" label="库存">
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Form.Item name="category" label="商品分类">
            <Select
              options={categoryOptions.map((c) => ({ value: c, label: c }))}
              style={{ width: 200 }}
              placeholder="选择或输入分类"
              showSearch
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <div style={{ padding: '4px 8px', borderTop: '1px solid #f0f0f0' }}>
                    <Button type="link" size="small" onClick={openCatManage}>
                      管理分类…
                    </Button>
                  </div>
                </>
              )}
            />
          </Form.Item>
          <Form.Item name="services" label="服务承诺">
            <Select
              mode="tags"
              placeholder="七天无理由 / 运费险 / 正品保障 ..."
              options={['七天无理由', '运费险', '正品保障', '48小时发货', '一年质保'].map((v) => ({ value: v, label: v }))}
            />
          </Form.Item>
          <Form.Item name="scenes" label="适用场景">
            <Select
              mode="tags"
              placeholder="出差/旅行/外出 / 节日送礼 ..."
              options={['出差/旅行/外出', '节日送礼', '日常通勤', '运动健身'].map((v) => ({ value: v, label: v }))}
            />
          </Form.Item>
          {/**
           * 客户 2026-10-03：接待页点「规格/属性」要能看到管理员在这里配的真实商品信息，
           * 所以商品库补上「规格（SKU）」的维护入口（2026-10-09 调整为：规格名 / 尺码 / 价格 / 库存），接待页弹窗直接读它。
           */}
          <Form.Item label="规格（SKU）" tooltip="接待页点「规格/属性」看到的就是这里维护的内容；留空表示该商品没有细分规格">
            <Form.List name="skus">
              {(fields, { add, remove }) => (
                <div>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ marginBottom: 8 }}>
                      <Form.Item name={[field.name, 'name']} rules={[{ required: true, message: '请输入规格名' }]}>
                        <Input placeholder="规格名，如 黑色" style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'size']}>
                        <Input placeholder="尺码，如 S" style={{ width: 90 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'price']}>
                        <InputNumber min={0} precision={2} placeholder="价格" style={{ width: 110 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'stock']}>
                        <InputNumber min={0} placeholder="库存" style={{ width: 90 }} />
                      </Form.Item>
                      <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                    </Space>
                  ))}
                  <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ name: '', size: '', price: undefined, stock: undefined })}>
                    添加规格
                  </Button>
                </div>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={importOpen}
        title="批量导入商品（Excel / CSV）"
        onCancel={() => {
          setImportOpen(false);
          setXlsxBase64('');
        }}
        onOk={doImport}
        width={680}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Upload
              accept=".xlsx,.csv,.txt"
              showUploadList={false}
              beforeUpload={(file) => {
                const name = (file.name || '').toLowerCase();
                const reader = new FileReader();
                if (name.endsWith('.xlsx')) {
                  setXlsxName(file.name);
                  reader.onload = () => {
                    setXlsxBase64(String(reader.result || ''));
                    setCsv('');
                  };
                  reader.readAsDataURL(file);
                } else {
                  setXlsxBase64('');
                  setXlsxName('');
                  reader.onload = () => setCsv(String(reader.result || ''));
                  reader.readAsText(file, 'utf-8');
                }
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>选择 Excel / CSV 文件</Button>
            </Upload>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const header = 'product_no,title,price,stock,category,services,scenes\n';
                const sample = '3781182303640999001,示例商品标题,99.00,100,家居,七天无理由;运费险,日常通勤\n';
                const blob = new Blob(['\uFEFF' + header + sample], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'product-import-template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              下载模板
            </Button>
          </Space>
          {xlsxBase64 ? (
            <Alert type="info" showIcon message={`已选择 Excel 文件：${xlsxName}，点击确定开始导入`} />
          ) : (
            <Input.TextArea
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder="粘贴 CSV 内容，首行为表头：product_no,title,price,stock,category,services,scenes；Excel 请直接用上方按钮选择 .xlsx 文件"
            />
          )}
          {importResult && (
            <Card size="small">
              <div>
                导入完成：成功 <Tag color="green">{importResult.success}</Tag> 条，失败{' '}
                <Tag color="red">{importResult.failed?.length || 0}</Tag> 条（共 {importResult.total} 条）
              </div>
              {!!importResult.failed?.length && (
                <ul style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', paddingLeft: 18 }}>
                  {importResult.failed.map((f: any) => (
                    <li key={f.row} style={{ fontSize: 12, color: '#8c8c8c' }}>
                      第 {f.row} 行：{f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </Space>
      </Modal>

      {/* 一键添加商品（2026-10-07 客户新增）：粘贴分享链接识别商品信息并预填表单 */}
      <Modal
        open={linkOpen}
        title="一键添加商品"
        onCancel={() => {
          setLinkOpen(false);
          setLinkText('');
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setLinkOpen(false);
              setLinkText('');
            }}
          >
            取消
          </Button>,
          <Button key="ok" type="primary" loading={linkLoading} onClick={importFromLink}>
            识别并填入表单
          </Button>,
        ]}
        width={520}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          粘贴<strong>抖音、淘宝、京东</strong>的商品分享链接或整段分享文案，系统会自动识别商品信息并填入新建表单（商品ID
          需手动填写）。各平台识别能力：抖音标题/价格/图片全自动；淘宝标题/价格自动、图片需手补；京东标题/图片自动、价格需手填（平台对未登录访问隐藏价格）。识别失败时会自动提取分享文案中的标题兜底，也可改用「新建商品」手动录入。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={linkText}
          onChange={(e) => setLinkText(e.target.value)}
          placeholder={'例如：https://v.douyin.com/xxxxxx/\n或直接粘贴整段分享文案'}
        />
      </Modal>

      {/* 分类管理（2026-10-09 客户新增）：商品分类字典，复用 /api/categories?type=product */}
      <Modal open={catOpen} title="商品分类管理" onCancel={() => setCatOpen(false)} footer={null} width={520} destroyOnClose>
        <Space style={{ marginBottom: 12 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              catForm.resetFields();
              setCatEditing({ type: 'product' });
            }}
          >
            新增分类
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            改名会同步更新已归类商品；删除前会检查是否还有商品在用。
          </Typography.Text>
        </Space>
        <Table
          rowKey="id"
          size="small"
          dataSource={catRows}
          pagination={false}
          locale={{ emptyText: '还没有分类，点击「新增分类」创建' }}
          columns={[
            { title: '分类名称', dataIndex: 'name' },
            {
              title: '商品数',
              dataIndex: 'count',
              width: 90,
              render: (value: number) =>
                value ? <Tag color="blue">{value}</Tag> : <Typography.Text type="secondary">0</Typography.Text>,
            },
            {
              title: '操作',
              width: 140,
              render: (_, row: any) => (
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      catForm.setFieldsValue({ name: row.name });
                      setCatEditing(row);
                    }}
                  >
                    改名
                  </Button>
                  <Popconfirm title={`确认删除分类「${row.name}」？`} onConfirm={() => removeCat(row)}>
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Modal
          open={!!catEditing}
          title={catEditing?.id ? '修改分类' : '新增分类'}
          onCancel={() => setCatEditing(null)}
          onOk={saveCat}
          okText="保存"
          width={400}
          destroyOnClose
        >
          <Form form={catForm} layout="vertical">
            <Form.Item
              name="name"
              label="分类名称"
              rules={[{ required: true, message: '请输入分类名称' }, { max: 64, message: '不超过 64 个字' }]}
            >
              <Input placeholder="如：女装上衣" maxLength={64} />
            </Form.Item>
            {catEditing?.id ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                改名会同步更新已引用该分类的商品，改完不需要再去逐条修改。
              </Typography.Text>
            ) : null}
          </Form>
        </Modal>
      </Modal>

      {/* 使用说明（2026-10-08 客户新增）：一键添加商品操作说明卡 */}
      <Modal
        open={guideOpen}
        title="一键添加商品 · 使用说明"
        onCancel={() => setGuideOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <div style={{ maxHeight: '70vh', overflow: 'auto', textAlign: 'center' }}>
          <img src="/guide/product-add-guide.png" alt="一键添加商品使用说明" style={{ width: '100%', maxWidth: 460 }} />
        </div>
      </Modal>

      {/* 长截图切分（2026-10-09 客户新增）：框选商品详情区域后按空白间隙切分填入详情图 */}
      <Modal
        open={longshotOpen}
        title="长截图切分详情图"
        onCancel={() => setLongshotOpen(false)}
        onOk={applyLongshot}
        okText="切分填入"
        cancelText="取消"
        confirmLoading={longshotDoing}
        width={560}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {longshotUrl ? (
            <img
              src={longshotUrl}
              alt="长截图预览"
              style={{ width: '100%', maxHeight: 380, objectFit: 'contain', background: '#f5f5f5', borderRadius: 4 }}
            />
          ) : null}
          <Slider
            range
            value={longshotRange}
            onChange={(v) => setLongshotRange(v as [number, number])}
            tipFormatter={(v) => `${v}%`}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            拖动两端手柄框选「商品详情」区域（从详情标题到结尾，排除评价/推荐/保障等无关区块），越精准切分越干净；切分后多余的段可在表单里删除。
          </Typography.Text>
        </Space>
      </Modal>
    </Card>
  );
}
