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
          colorPrimary: '#1e6fff',
          colorInfo: '#1e6fff',
          colorSuccess: '#12b76a',
          colorWarning: '#f79009',
          colorError: '#f04438',
          colorLink: '#1e6fff',
          colorBgLayout: '#f2f4f7',
          colorBorder: '#e4e7ec',
          colorBorderSecondary: '#eaecf0',
          colorText: '#1d2939',
          colorTextSecondary: '#667085',
          colorTextTertiary: '#98a2b3',
          borderRadius: 8,
          borderRadiusLG: 12,
          controlHeight: 34,
          fontSize: 14,
          boxShadowTertiary: '0 1px 2px rgba(16,24,40,0.04), 0 2px 8px rgba(16,24,40,0.05)',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif',
        },
        components: {
          Layout: { headerBg: '#ffffff', bodyBg: '#f2f4f7', headerHeight: 60, headerPadding: '0 24px' },
          Menu: {
            horizontalItemSelectedColor: '#1e6fff',
            horizontalItemHoverColor: '#1e6fff',
            horizontalLineHeight: '60px',
            itemColor: '#344054',
            itemSelectedBg: '#eef4ff',
            itemSelectedColor: '#1e6fff',
            itemHoverBg: '#f5f8ff',
            itemBorderRadius: 8,
            activeBarHeight: 3,
          },
          Card: { borderRadiusLG: 12, headerFontSize: 15 },
          Table: {
            headerBg: '#f9fafb',
            headerColor: '#475467',
            headerSplitColor: 'transparent',
            rowHoverBg: '#f5f8ff',
            borderColor: '#eaecf0',
            cellPaddingBlock: 12,
          },
          Button: { primaryShadow: '0 1px 2px rgba(30,111,255,0.24)', fontWeight: 500 },
          Tabs: { inkBarColor: '#1e6fff', itemSelectedColor: '#1e6fff', itemHoverColor: '#1e6fff' },
          Segmented: { itemSelectedColor: '#1e6fff' },
          Modal: { borderRadiusLG: 14 },
          Tag: { defaultBg: '#f2f4f7', defaultColor: '#475467' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
