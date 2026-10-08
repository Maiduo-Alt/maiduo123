import {
  deepFindProduct,
  detectPlatform,
  extractDouyinProduct,
  extractTitleFromShareText,
  extractUrl,
  importFromShareLink,
} from '../../src/common/share-link';

/** 构造一段带 RENDER_DATA 的抖音商品页 HTML（真实结构的仿真）。 */
function pageWithRenderData(product: object): string {
  const payload = encodeURIComponent(
    JSON.stringify({ app: { loaderData: { 'item2/(id)': { productInfo: { product: product } } } } })
  );
  return `<!DOCTYPE html><html><head><title>商品</title></head><body>
    <script id="RENDER_DATA" type="application/json">${payload}</script>
  </body></html>`;
}

const PRODUCT = {
  productId: '3612345678901234567',
  title: '秋冬新款加厚保暖羽绒服女中长款过膝白鸭绒外套',
  minPrice: 39900,
  maxPrice: 59900,
  imgs: [
    '//p3-aio.ecombdimg.com/obj/ecom-shop-material/a_main.jpg',
    'https://p3-aio.ecombdimg.com/obj/ecom-shop-material/a_2.jpg',
  ],
  detailImgs: [{ url: '//p3-aio.ecombdimg.com/obj/ecom-shop-material/d_1.jpg' }],
};

describe('分享链接识别（一键添加商品）', () => {
  it('从分享文案里抽出链接，忽略前后中文与尾部标点', () => {
    expect(extractUrl('【抖音商城】https://v.douyin.com/iFR3AbCd/ 点击链接打开')).toBe('https://v.douyin.com/iFR3AbCd/');
    expect(extractUrl('复制这段话 39.9 https://haohuo.jinritemai.com/views/product/item2?id=36123 去购买')).toBe(
      'https://haohuo.jinritemai.com/views/product/item2?id=36123'
    );
    expect(() => extractUrl('没有链接的纯文本')).toThrow(/没有从内容里找到链接/);
  });

  it('识别各平台，未支持的平台报 unknown', () => {
    expect(detectPlatform('https://v.douyin.com/iFR3AbCd/')).toBe('douyin');
    expect(detectPlatform('https://haohuo.jinritemai.com/views/product/item2?id=1')).toBe('douyin');
    expect(detectPlatform('https://item.taobao.com/item.htm?id=1')).toBe('taobao');
    expect(detectPlatform('https://mobile.yangkeduo.com/goods.html?goods_id=1')).toBe('unknown');
  });

  it('deepFindProduct 按「标题+价格+图片」找到商品节点', () => {
    const tree = { a: { b: [{ noise: 1 }, { title: '假商品', minPrice: 100 }] }, c: { title: 'x', list: [{ product: PRODUCT }] } };
    expect(deepFindProduct(tree)).toEqual(PRODUCT);
    expect(deepFindProduct({ nothing: true })).toBeNull();
  });

  it('从 RENDER_DATA 提取标题/价格(分转元)/主图/详情图', () => {
    const data = extractDouyinProduct(pageWithRenderData(PRODUCT));
    expect(data).toEqual({
      title: '秋冬新款加厚保暖羽绒服女中长款过膝白鸭绒外套',
      price: 399,
      originPrice: 599,
      coverUrl: 'https://p3-aio.ecombdimg.com/obj/ecom-shop-material/a_main.jpg',
      detailImages: [
        'https://p3-aio.ecombdimg.com/obj/ecom-shop-material/a_2.jpg',
        'https://p3-aio.ecombdimg.com/obj/ecom-shop-material/d_1.jpg',
      ],
    });
  });

  it('售价=最高价时不给划线价', () => {
    const html = pageWithRenderData({ ...PRODUCT, minPrice: 39900, maxPrice: 39900 });
    const data = extractDouyinProduct(html);
    expect(data?.price).toBe(399);
    expect(data?.originPrice).toBeUndefined();
  });

  it('_SSR_DATA 与 og:meta 兜底', () => {
    const ssr = `<html><script>window._SSR_DATA = ${JSON.stringify({ detail: { title: PRODUCT.title, price: 29900, imgs: PRODUCT.imgs } })};</script></html>`;
    expect(extractDouyinProduct(ssr)?.price).toBe(299);
    const og = `<html><head><meta property="og:title" content="兜底标题"><meta property="og:image" content="//img.example.com/a.jpg"></head></html>`;
    expect(extractDouyinProduct(og)).toEqual({ title: '兜底标题', coverUrl: 'https://img.example.com/a.jpg' });
  });

  it('importFromShareLink：短链跳转后解析商品页（注入假 fetch，不联网）', async () => {
    const html = pageWithRenderData(PRODUCT);
    const calls: string[] = [];
    const fakeFetch = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('v.douyin.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://haohuo.jinritemai.com/views/product/item2?id=3612345678901234567' } });
      }
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const preview = await importFromShareLink('看看这个 https://v.douyin.com/iFR3AbCd/ 不错', fakeFetch);
    expect(calls[0]).toContain('v.douyin.com');
    expect(calls[1]).toContain('jinritemai.com');
    expect(preview.platform).toBe('douyin');
    expect(preview.title).toContain('羽绒服');
    expect(preview.price).toBe(399);
  });

  it('页面与文案都识别不出时给明确报错', async () => {
    const fakeFetch = (async () => new Response('<html><body>滑块验证</body></html>', { status: 200 })) as unknown as typeof fetch;
    await expect(importFromShareLink('https://haohuo.jinritemai.com/views/product/item2?id=1', fakeFetch)).rejects.toThrow(
      /未能识别出商品信息/
    );
  });

  it('从分享文案提取标题：去掉店铺名标签、引导语与口令尾缀', () => {
    const text = '2.33 02/11 M@W.Mw QKw:/ 【抖音商城】https://v.douyin.com/j5sqPp7x6lE/ 【棉屿T恤】步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女\n长按复制此条消息，打开抖音搜索，查看商品详情！:6pm';
    expect(extractTitleFromShareText(text)).toBe('步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女');
    expect(extractTitleFromShareText('https://v.douyin.com/abc/ 查看商品详情')).toBeNull();
  });

  it('页面有访问验证时降级：用分享文案标题预填并给出提示', async () => {
    const fakeFetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('v.douyin.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=1' } });
      }
      // 纯 JS 渲染的空壳页面（没有任何商品数据）
      return new Response('<html><head><title></title></head><body><script>window.__PIA_MONITOR__={}</script></body></html>', { status: 200 });
    }) as unknown as typeof fetch;
    const text = '【抖音商城】https://v.douyin.com/j5sqPp7x6lE/ 【棉屿T恤】步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女\n长按复制此条消息，打开抖音搜索，查看商品详情！:6pm';
    const preview = await importFromShareLink(text, fakeFetch);
    expect(preview.platform).toBe('douyin');
    expect(preview.title).toBe('步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女');
    expect(preview.price).toBeUndefined();
    expect(preview.coverUrl).toBeUndefined();
    expect(preview.notice).toContain('抖音');
  });

  it('完整解析成功时不带降级提示', async () => {
    const html = pageWithRenderData(PRODUCT);
    const fakeFetch = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const preview = await importFromShareLink('【抖音商城】https://haohuo.jinritemai.com/views/product/item2?id=1 【店】秋冬新款加厚保暖羽绒服女中长款过膝白鸭绒外套', fakeFetch);
    expect(preview.price).toBe(399);
    expect(preview.notice).toBeUndefined();
  });

  it('识别淘宝/京东平台链接', () => {
    expect(detectPlatform('https://m.tb.cn/h.g2qXyZ')).toBe('taobao');
    expect(detectPlatform('https://item.taobao.com/item.htm?id=123')).toBe('taobao');
    expect(detectPlatform('https://detail.tmall.com/item.htm?id=123')).toBe('taobao');
    expect(detectPlatform('https://item.jd.com/100012043978.html')).toBe('jd');
    expect(detectPlatform('https://3.cn/1A2b3C')).toBe('jd');
  });

  it('淘宝/京东分享文案标题在「」里（含「「店名」标题」嵌套格式）', () => {
    expect(extractTitleFromShareText('【京东】https://3.cn/1A2b3C 「步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女」\n点击链接直接打开')).toBe(
      '步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女'
    );
    expect(extractTitleFromShareText('28￥ HU9046 abc￥ https://m.tb.cn/h.g2qXyZ CZ8901 「棉屿T恤女圆领短袖2024新款」\n复制打开淘宝')).toBe(
      '棉屿T恤女圆领短袖2024新款'
    );
    // 店铺名用内层引号、标题裸在外层引号里（真实淘宝分享格式）
    expect(extractTitleFromShareText('【淘宝】7天无理由 https://e.tb.cn/h.x CZ028 「「来信」步履不停 翻领A版中长款风衣廓形文艺复古轻盈秋款21090」\n点击链接直接打开')).toBe(
      '步履不停 翻领A版中长款风衣廓形文艺复古轻盈秋款21090'
    );
  });

  it('京东商品页：标题 + skuId + 价格接口（注入假 fetch，不联网）', async () => {
    const jdHtml = `<html><head><title>棉屿T恤女圆领短袖上衣 【棉屿旗舰店】 - 京东</title></head>
      <body><div class="sku-name">棉屿T恤女圆领短袖上衣 白色 M</div>
      <img id="spec-img" src="//img10.360buyimg.com/n1/s123.jpg" /></body></html>`;
    const fakeFetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('p.3.cn')) {
        return new Response(JSON.stringify([{ p: '89.00', op: '129.00' }]), { status: 200 });
      }
      return new Response(jdHtml, { status: 200 });
    }) as unknown as typeof fetch;
    const preview = await importFromShareLink('https://item.jd.com/100012043978.html', fakeFetch);
    expect(preview.platform).toBe('jd');
    expect(preview.title).toContain('棉屿T恤');
    expect(preview.price).toBe(89);
    expect(preview.originPrice).toBe(129);
    expect(preview.coverUrl).toBe('https://img10.360buyimg.com/n1/s123.jpg');
    // 标题+价格都有，只是没有详情图，不算降级
    expect(preview.notice).toBeUndefined();
  });

  it('淘宝被登录页拦截时：用「」文案标题兜底并给出提示', async () => {
    const loginHtml = '<html><head><title>淘宝网 - 淘！我喜欢</title></head><body>亲，请登录</body></html>';
    const fakeFetch = (async () => new Response(loginHtml, { status: 200 })) as unknown as typeof fetch;
    const text = '28￥ HU9046 abc￥ https://m.tb.cn/h.g2qXyZ CZ8901 「棉屿T恤女圆领短袖2024新款」\n复制打开淘宝';
    const preview = await importFromShareLink(text, fakeFetch);
    expect(preview.platform).toBe('taobao');
    expect(preview.title).toBe('棉屿T恤女圆领短袖2024新款');
    expect(preview.notice).toContain('淘宝');
  });

  it('京东被软拦截到门户首页时：拒绝门户标题，走「」文案兜底', async () => {
    const portalHtml = '<html><head><title>京东(JD.COM)-正品低价、品质保障、配送及时、轻松购物！</title></head><body>portal</body></html>';
    const fakeFetch = (async () => new Response(portalHtml, { status: 200 })) as unknown as typeof fetch;
    const text = '【京东】https://3.cn/1A2b3C 「棉屿T恤女圆领短袖2024新款」\n点击链接直接打开';
    const preview = await importFromShareLink(text, fakeFetch);
    expect(preview.platform).toBe('jd');
    expect(preview.title).toBe('棉屿T恤女圆领短袖2024新款');
    expect(preview.price).toBeUndefined();
  });

  it('无头浏览器抓取（scrapeImpl）优先：拿到完整数据直接返回，不再走 HTTP', async () => {
    const fakeFetch = (async () => {
      throw new Error('HTTP 不应该被调用');
    }) as unknown as typeof fetch;
    const fakeScrape = async (url: string) => {
      expect(url).toContain('v.douyin.com');
      return {
        title: '步履不停 休闲宽松多色廓形基础T恤圆领短袖上衣女',
        price: 99.9,
        originPrice: 129,
        coverUrl: 'https://example.com/cover.jpg',
        detailImages: ['https://example.com/d1.jpg'],
        sourceUrl: 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=1',
      };
    };
    const preview = await importFromShareLink('【抖音商城】https://v.douyin.com/j5sqPp7x6lE/ 【棉屿T恤】步履不停', fakeFetch, fakeScrape);
    expect(preview.platform).toBe('douyin');
    expect(preview.price).toBe(99.9);
    expect(preview.coverUrl).toContain('cover.jpg');
    expect(preview.notice).toBeUndefined();
  });

  it('scrapeImpl 返回 null 或抛错时：回退到纯 HTTP 解析', async () => {
    const html = pageWithRenderData(PRODUCT);
    const fakeFetch = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const preview = await importFromShareLink('https://haohuo.jinritemai.com/views/product/item2?id=1', fakeFetch, async () => null);
    expect(preview.title).toContain('羽绒服');
    expect(preview.price).toBe(399);
  });
});
