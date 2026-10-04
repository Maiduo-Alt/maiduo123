import { Empty, Typography } from 'antd';

export interface TrendPoint {
  date: string;
  [key: string]: any;
}

interface Props {
  points: TrendPoint[];
  valueKey: string;
  label: string;
  color?: string;
  unit?: string;
  height?: number;
  /** 统计口径单位：按天='天'、按局='次'（只影响图内提示文案） */
  noun?: string;
  /** 横轴标签格式化。默认取 date 的 MM-DD；按局口径传 HH:mm */
  xLabel?: (point: TrendPoint) => string;
}

/**
 * 极简折线图：直接画 SVG，不引第三方图表库（离线环境装不了依赖）。
 * 只需要「按天看趋势 + 悬停看数值」两个能力，够个人成长曲线用。
 */
export default function TrendChart({
  points,
  valueKey,
  label,
  color = '#2f6fe4',
  unit = '',
  height = 180,
  noun = '天',
  xLabel,
}: Props) {
  const data = points.filter((point) => point[valueKey] !== null && point[valueKey] !== undefined);
  // 按天口径的 date 是 YYYY-MM-DD（取 MM-DD）；按局口径是 HH:mm，直接用
  const formatX = xLabel || ((point: TrendPoint) => String(point.date).slice(5));
  if (!data.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`最近还没有已结束的接待，练几次之后这里会画出${label}走势`}
      />
    );
  }

  const width = 760;
  const padding = { top: 16, right: 16, bottom: 26, left: 44 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const values = data.map((point) => Number(point[valueKey]));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  // 只有一天数据时也把点画出来（落在左侧），并提示再练几天就能看出走势
  const stepX = data.length > 1 ? innerWidth / (data.length - 1) : 0;
  const toY = (value: number) => padding.top + innerHeight - ((value - min) / span) * innerHeight;
  const toX = (index: number) => padding.left + index * stepX;
  const polyline = data.map((point, index) => `${toX(index)},${toY(Number(point[valueKey]))}`).join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={`${label}走势`}>
        {[0, 0.5, 1].map((ratio) => {
          const value = min + span * (1 - ratio);
          const y = padding.top + innerHeight * ratio;
          return (
            <g key={ratio}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#eef1f7" strokeWidth="1" />
              <text x={padding.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#9aa7bb">
                {Math.round(value * 10) / 10}
                {unit}
              </text>
            </g>
          );
        })}
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {data.map((point, index) => (
          <circle
            // 按局口径下同分钟的两局 date 相同，key 要带上下标，否则 React 会报重复 key
            key={`${point.date}-${index}`}
            cx={toX(index)}
            cy={toY(Number(point[valueKey]))}
            r="3"
            fill="#fff"
            stroke={color}
            strokeWidth="2"
          >
            <title>{`${point.date}：${point[valueKey]}${unit}`}</title>
          </circle>
        ))}
        {[...new Set([0, Math.floor(data.length / 2), data.length - 1])].map((index) => (
          <text key={index} x={toX(index)} y={height - 8} textAnchor="middle" fontSize="10" fill="#9aa7bb">
            {formatX(data[index])}
          </text>
        ))}
      </svg>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}：最新 {data[data.length - 1][valueKey]}
        {unit}　·　区间 {Math.round(min * 10) / 10}
        {unit} ~ {Math.round(max * 10) / 10}
        {unit}　·　共 {data.length} {noun}有数据
        {data.length < 2 ? `（再练几${noun}就能看出走势）` : ''}
      </Typography.Text>
    </div>
  );
}
