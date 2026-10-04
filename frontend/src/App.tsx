import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './store/auth';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Reception from './pages/Reception';
import Records from './pages/Records';
import RecordDetail from './pages/RecordDetail';
import Scripts from './pages/Scripts';
import Products from './pages/Products';
import Backgrounds from './pages/Backgrounds';
import Cases from './pages/Cases';
import Tasks from './pages/Tasks';
import Styles from './pages/Styles';
import Phrases from './pages/Phrases';
import Dictionary from './pages/Dictionary';
import Accounts from './pages/Accounts';
import Settings from './pages/Settings';

export default function App() {
  const { profile, load } = useAuth();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    load().finally(() => setBooting(false));
  }, [load, setBooting]);

  if (booting) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="正在加载..." />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {!profile ? (
          <Route path="*" element={<Navigate to="/login" replace />} />
        ) : (
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/reception" element={<Reception />} />
            <Route path="/records" element={<Records />} />
            <Route path="/records/:id" element={<RecordDetail />} />
            <Route path="/scripts" element={<Scripts />} />
            <Route path="/products" element={<Products />} />
            <Route path="/library" element={<Backgrounds />} />
            <Route path="/cases" element={<Cases />} />
            <Route path="/phrases" element={<Phrases />} />
            <Route path="/dictionary" element={<Dictionary />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/styles" element={<Styles />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        )}
      </Routes>
    </BrowserRouter>
  );
}
