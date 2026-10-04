import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../store/auth';

export default function Login() {
  const { login, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const onFinish = async (values: { username: string; password: string }) => {
    setError(null);
    try {
      const result = await login(values.username, values.password);
      navigate('/');
      if (result.mustChangePassword) {
        message.warning(result.notice || '请先修改密码');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #eef4ff 0%, #f7f9fc 60%, #eaf0fb 100%)',
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 8px 32px rgba(31,56,100,0.12)' }} bordered={false}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto 12px',
              borderRadius: 14,
              background: 'linear-gradient(135deg,#2e5c9a,#4c8bf5)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
            }}
          >
            接待
          </div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            在线模拟接待训练系统
          </Typography.Title>
          <Typography.Text type="secondary">面向新入职客服的并发接待模拟训练</Typography.Text>
        </div>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish} initialValues={{ username: 'agent', password: 'Agent@123' }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={loading}>
            登录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          演示账号：管理员 admin / Admin@123；带教 leader / Leader@123；客服 agent / Agent@123
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
