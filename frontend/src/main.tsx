import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#3f5bf6',
          colorInfo: '#3f5bf6',
          colorSuccess: '#16a34a',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          colorBgLayout: '#f4f6fb',
          colorBorderSecondary: '#edf0f6',
          colorText: '#1f2937',
          colorTextSecondary: '#6b7280',
          borderRadius: 8,
          borderRadiusLG: 12,
          controlHeight: 34,
          boxShadowTertiary: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
          fontFamily: '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Layout: { siderBg: '#ffffff', headerBg: 'rgba(255,255,255,0.85)', bodyBg: '#f4f6fb' },
          Menu: {
            itemBorderRadius: 8,
            itemHeight: 40,
            itemMarginInline: 10,
            itemSelectedBg: '#eef1ff',
            itemSelectedColor: '#3f5bf6',
            itemHoverBg: '#f5f7fc',
            groupTitleColor: '#9aa3b2',
            groupTitleFontSize: 12,
          },
          Card: { borderRadiusLG: 14 },
          Table: { headerBg: '#f8f9fc', headerColor: '#4b5563', rowHoverBg: '#f7f8ff', borderColor: '#eef0f6' },
          Button: { primaryShadow: '0 2px 6px rgba(63,91,246,0.28)', fontWeight: 500 },
          Tag: { borderRadiusSM: 6 },
          Tabs: { inkBarColor: '#3f5bf6', itemSelectedColor: '#3f5bf6' },
          Modal: { borderRadiusLG: 14 },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
