import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Button,
  Descriptions,
  Dropdown,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CustomerServiceOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MessageOutlined,
  PlusOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShoppingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, uploadImage } from '../api/client';
import { useAuth } from '../store/auth';

const { Header, Sider, Content } = Layout;

export default function AppLayout() {
  const { profile, logout, load, passwordNotice, clearPasswordNotice } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [pwdForm] = Form.useForm();
  const [profileForm] = Form.useForm();
  /** 方案 F8-10：密码过期 / 管理员重置后强制改密 */
  const [forcePwdOpen, setForcePwdOpen] = useState(false);
  const [forcePwdForm] = Form.useForm();
  const avatarUrl = Form.useWatch('avatarUrl', profileForm);

  useEffect(() => {
    if (passwordNotice) {
      forcePwdForm.resetFields();
      setForcePwdOpen(true);
    }
  }, [passwordNotice, forcePwdForm]);

  const submitForcedPassword = async () => {
    const values = await forcePwdForm.validateFields();
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的新密码不一致');
      return;
    }
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { oldPassword: values.oldPassword, newPassword: values.newPassword },
      });
      message.success('密码已修改');
      clearPasswordNotice();
      setForcePwdOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const openProfile = () => {
    profileForm.setFieldsValue({
      displayName: profile?.displayName || '',
      mobile: profile?.mobile || '',
      avatarUrl: profile?.avatarUrl || '',
    });
    pwdForm.resetFields();
    setProfileOpen(true);
  };

  const saveProfile = async () => {
    const values = await profileForm.validateFields();
    await api('/auth/profile', {
      method: 'PUT',
      body: {
        displayName: values.displayName,
        mobile: values.mobile,
        preference: { ...(profile?.preference || {}), avatarUrl: values.avatarUrl || '' },
      },
    });
    await load();
    message.success('个人资料已保存');
    setProfileOpen(false);
  };

  const savePassword = async () => {
    const values = await pwdForm.validateFields();
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的新密码不一致');
      return;
    }
    await api('/auth/change-password', {
      method: 'POST',
      body: { oldPassword: values.oldPassword, newPassword: values.newPassword },
    });
    message.success('密码已修改');
    pwdForm.resetFields();
  };

  const items = useMemo(() => {
    const role = profile?.roleCode;
    const canManage = role === 'admin' || role === 'leader';
    const list: any[] = [
      { key: 'training', label: '训练中心', type: 'group', children: [
        { key: '/', icon: <AppstoreOutlined />, label: <Link to="/">我的训练</Link> },
        { key: '/records', icon: <BarChartOutlined />, label: <Link to="/records">模拟接待明细</Link> },
      ] },
    ];
    // 客户新增需求：客服不开放自由练习，所以「在线模拟接待」（自由练习入口）只给管理员/主管
    if (canManage) {
      list[0].children.splice(1, 0, {
        key: '/reception',
        icon: <CustomerServiceOutlined />,
        label: <Link to="/reception">在线模拟接待</Link>,
      });
    }
    // 客服只接收与执行任务（方案 2.2），给一个「我的任务」入口看待办与倒计时（F6-05）
    if (role === 'agent') {
      list[0].children.push({ key: '/tasks', icon: <TeamOutlined />, label: <Link to="/tasks">我的任务</Link> });
    }
    if (canManage) {
      list.push({
        key: 'content',
        label: '内容管理',
        type: 'group',
        children: [
          { key: '/library', icon: <FolderOpenOutlined />, label: <Link to="/library">客户问题剧本</Link> },
          { key: '/scripts', icon: <FileTextOutlined />, label: <Link to="/scripts">剧本列表</Link> },
          { key: '/products', icon: <ShoppingOutlined />, label: <Link to="/products">商品库</Link> },
          { key: '/cases', icon: <MessageOutlined />, label: <Link to="/cases">案例收藏</Link> },
          { key: '/phrases', icon: <ThunderboltOutlined />, label: <Link to="/phrases">快捷短语</Link> },
        ],
      });
      list.push({
        key: 'manage',
        label: '训练管理',
        type: 'group',
        children: [{ key: '/tasks', icon: <TeamOutlined />, label: <Link to="/tasks">回复模拟任务</Link> }],
      });
    }
    if (role === 'admin') {
      list.push({
        key: 'system',
        label: '系统管理',
        type: 'group',
        children: [
          { key: '/styles', icon: <AppstoreOutlined />, label: <Link to="/styles">沟通风格</Link> },
          { key: '/dictionary', icon: <ProfileOutlined />, label: <Link to="/dictionary">数据字典</Link> },
          { key: '/accounts', icon: <UserOutlined />, label: <Link to="/accounts">账号</Link> },
          { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">系统参数</Link> },
        ],
      });
    }
    return list;
  }, [profile?.roleCode]);

  const roleName = { admin: '管理员', leader: '主管/带教', agent: '客服' }[profile?.roleCode || 'agent'];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="light" style={{ borderRight: '1px solid #eef0f5' }}>
        <div className="app-logo">
          <span className="app-logo-mark">接待</span>
          <div>
            <div className="app-logo-title">模拟接待训练</div>
            <div className="app-logo-sub">客服培训系统</div>
          </div>
        </div>
        <Menu mode="inline" selectedKeys={[location.pathname]} items={items} style={{ borderInlineEnd: 'none' }} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Typography.Text type="secondary">面向新入职客服的并发接待模拟训练平台</Typography.Text>
          <Dropdown
            menu={{
              items: [
                { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
              ],
              onClick: ({ key }) => {
                if (key === 'profile') {
                  openProfile();
                  return;
                }
                logout();
                navigate('/login');
              },
            }}
          >
            <div className="app-user">
              <Avatar size={28} src={profile?.avatarUrl || undefined} style={{ backgroundColor: '#2e5c9a' }}>
                {profile?.avatarUrl ? null : profile?.displayName?.slice(0, 1)}
              </Avatar>
              <span>{profile?.displayName}</span>
              <Tag color="blue">{roleName}</Tag>
            </div>
          </Dropdown>
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>

      <Modal
        open={profileOpen}
        title="个人资料"
        onCancel={() => setProfileOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Tabs
          items={[
            {
              key: 'basic',
              label: '基本资料',
              children: (
                <Form form={profileForm} layout="vertical">
                  <Form.Item label="头像">
                    <Space align="start">
                      <Upload
                        listType="picture-card"
                        accept="image/*"
                        showUploadList={false}
                        customRequest={async ({ file, onSuccess, onError }: any) => {
                          try {
                            const url = await uploadImage(file as File);
                            profileForm.setFieldValue('avatarUrl', url);
                            onSuccess?.({});
                          } catch (e) {
                            message.error((e as Error).message);
                            onError?.(e as Error);
                          }
                        }}
                      >
                        {avatarUrl ? (
                          <img src={avatarUrl} alt="头像" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <div>
                            <PlusOutlined />
                            <div style={{ marginTop: 8 }}>上传头像</div>
                          </div>
                        )}
                      </Upload>
                      {avatarUrl ? (
                        <Button size="small" type="link" onClick={() => profileForm.setFieldValue('avatarUrl', '')}>
                          清除头像
                        </Button>
                      ) : null}
                    </Space>
                  </Form.Item>
                  <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
                    <Input maxLength={32} />
                  </Form.Item>
                  <Form.Item name="mobile" label="手机号" tooltip="列表与资料页均按 138****1234 脱敏展示">
                    <Input maxLength={20} placeholder="11 位手机号" />
                  </Form.Item>
                  <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="工号">{profile?.employeeNo || '—'}</Descriptions.Item>
                    <Descriptions.Item label="登录账号">{profile?.username}</Descriptions.Item>
                  </Descriptions>
                  <Button type="primary" onClick={saveProfile}>
                    保存资料
                  </Button>
                </Form>
              ),
            },
            {
              key: 'password',
              label: '修改密码',
              children: (
                <Form form={pwdForm} layout="vertical">
                  <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
                    <Input.Password />
                  </Form.Item>
                  <Form.Item
                    name="newPassword"
                    label="新密码"
                    rules={[{ required: true, message: '请输入新密码' }]}
                    extra="需同时包含字母与数字"
                  >
                    <Input.Password />
                  </Form.Item>
                  <Form.Item
                    name="confirmPassword"
                    label="确认新密码"
                    rules={[{ required: true, message: '请再次输入新密码' }]}
                  >
                    <Input.Password />
                  </Form.Item>
                  <Button type="primary" onClick={savePassword}>
                    确认修改
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Modal>

      {/* 强制改密（方案 F8-10）：密码过期或管理员重置后必须修改，否则不能继续使用 */}
      <Modal
        open={forcePwdOpen}
        title="请先修改密码"
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={[
          <Button
            key="logout"
            onClick={() => {
              clearPasswordNotice();
              setForcePwdOpen(false);
              logout();
              navigate('/login');
            }}
          >
            退出登录
          </Button>,
          <Button key="ok" type="primary" onClick={submitForcedPassword}>
            确认修改
          </Button>,
        ]}
        width={480}
        destroyOnClose
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={passwordNotice || '请先修改密码'} />
        <Form form={forcePwdForm} layout="vertical">
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, message: '请输入新密码' }]}
            extra="需同时包含字母与数字，至少 8 位"
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
