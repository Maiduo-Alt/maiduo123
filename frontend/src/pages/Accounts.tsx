import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../store/auth';

export default function Accounts() {
  const { profile } = useAuth();
  const [list, setList] = useState<any[]>([]);
  /** 开放难度弹窗（方案 4.4：管理员/带教直接为客服开放指定难度） */
  const [unlockTarget, setUnlockTarget] = useState<any>(null);
  const [unlockLevels, setUnlockLevels] = useState<string[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<any>({ page: 1, pageSize: 10 });
  const [modal, setModal] = useState<{ open: boolean; record?: any }>({ open: false });
  const [form] = Form.useForm();

  const load = async (patch: any = {}) => {
    const next = { ...query, ...patch };
    setQuery(next);
    setLoading(true);
    try {
      const [res, groupList] = await Promise.all([
        api<any>('/accounts', { query: next }),
        api<any[]>('/groups'),
      ]);
      setList(res.list || []);
      setTotal(res.total || 0);
      setGroups(groupList || []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (modal.record) {
        await api(`/accounts/${modal.record.id}`, {
          method: 'PUT',
          body: { displayName: values.displayName, roleCode: values.roleCode, groupId: values.groupId, status: values.status },
        });
      } else {
        await api('/accounts', {
          method: 'POST',
          body: {
            username: values.username,
            password: values.password,
            displayName: values.displayName,
            roleCode: values.roleCode,
            groupId: values.groupId,
          },
        });
      }
      message.success('已保存');
      setModal({ open: false });
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const readOnly = profile?.roleCode !== 'admin';
  const roleName = (code: string) => ({ admin: '管理员', leader: '主管/带教', agent: '客服' }[code] || code);

  return (
    <Card
      className="page-card"
      bordered={false}
      title="账号"
      extra={
        <Space>
          <Input.Search placeholder="搜索用户名 / 姓名" allowClear style={{ width: 200 }} onSearch={(v) => load({ keyword: v, page: 1 })} />
          <Select
            allowClear
            placeholder="角色"
            style={{ width: 130 }}
            onChange={(v) => load({ role: v, page: 1 })}
            options={[
              { value: 'admin', label: '管理员' },
              { value: 'leader', label: '主管/带教' },
              { value: 'agent', label: '客服' },
            ]}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={readOnly}
            onClick={() => {
              setModal({ open: true });
              form.resetFields();
              form.setFieldsValue({ roleCode: 'agent', status: 1 });
            }}
          >
            新建账号
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={{
          total,
          current: query.page,
          pageSize: query.pageSize,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 个账号`,
          onChange: (page, pageSize) => load({ page, pageSize }),
        }}
        columns={[
          { title: '用户名', dataIndex: 'username', width: 140 },
          { title: '姓名', dataIndex: 'displayName', width: 140 },
          { title: '工号', dataIndex: 'employeeNo', width: 120, render: (v) => v || '-' },
          { title: '角色', dataIndex: 'roleCode', width: 120, render: (v) => <Tag color="blue">{roleName(v)}</Tag> },
          { title: '所属小组', dataIndex: 'groupName', width: 140, render: (v) => v || '-' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v) => (v === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '最近登录',
            dataIndex: 'lastLoginAt',
            width: 180,
            render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
          },
          {
            title: '操作',
            width: 220,
            render: (_, row: any) => (
              <Space>
                <Button
                  type="link"
                  disabled={readOnly}
                  onClick={() => {
                    setModal({ open: true, record: row });
                    form.setFieldsValue({ ...row, groupId: row.groupId, status: row.status });
                  }}
                >
                  编辑
                </Button>
                <Button
                  type="link"
                  disabled={readOnly}
                  onClick={() => {
                    let pwd = '';
                    Modal.confirm({
                      title: `重置 ${row.displayName} 的密码`,
                      content: (
                        <Input.Password placeholder="新密码（至少 8 位，含字母与数字）" onChange={(e) => (pwd = e.target.value)} />
                      ),
                      onOk: async () => {
                        try {
                          await api(`/accounts/${row.id}/reset-password`, { method: 'POST', body: { password: pwd } });
                          message.success('密码已重置');
                        } catch (e) {
                          message.error((e as Error).message);
                          throw e;
                        }
                      },
                    });
                  }}
                >
                  重置密码
                </Button>
                <Button
                  type="link"
                  disabled={readOnly}
                  onClick={() => {
                    setUnlockTarget(row);
                    setUnlockLevels(['L2']);
                  }}
                >
                  开放难度
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal open={modal.open} title={modal.record ? '编辑账号' : '新建账号'} onCancel={() => setModal({ open: false })} onOk={save} destroyOnClose>
        <Form form={form} layout="vertical">
          {!modal.record && (
            <>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input />
              </Form.Item>
              <Form.Item
                name="password"
                label="初始密码"
                rules={[{ required: true, message: '请输入初始密码' }, { min: 8, message: '密码至少 8 位' }]}
              >
                <Input.Password />
              </Form.Item>
            </>
          )}
          <Form.Item name="displayName" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="roleCode" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select
              options={[
                { value: 'admin', label: '管理员' },
                { value: 'leader', label: '主管/带教' },
                { value: 'agent', label: '客服' },
              ]}
            />
          </Form.Item>
          <Form.Item name="groupId" label="所属小组">
            <Select allowClear options={groups.map((g) => ({ value: g.id, label: `${g.name}（${g.memberCount} 人）` }))} />
          </Form.Item>
          {modal.record && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: 1, label: '启用' },
                  { value: 0, label: '停用' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 开放难度（方案 4.4：管理员/带教直接为客服开放指定难度） */}
      <Modal
        open={!!unlockTarget}
        title={`为 ${unlockTarget?.displayName || ''} 开放难度`}
        onCancel={() => setUnlockTarget(null)}
        onOk={async () => {
          if (!unlockLevels.length) {
            message.error('请至少选择一个难度档位');
            return;
          }
          try {
            await api(`/accounts/${unlockTarget.id}/unlock-levels`, {
              method: 'POST',
              body: { levels: unlockLevels },
            });
            message.success(`已开放：${unlockLevels.join(' / ')}`);
            setUnlockTarget(null);
            load();
          } catch (e) {
            message.error((e as Error).message);
          }
        }}
        okText="确认开放"
        width={460}
      >
        <Checkbox.Group
          value={unlockLevels}
          onChange={(values) => setUnlockLevels(values as string[])}
          options={[
            { value: 'L1', label: 'L1 话术适应' },
            { value: 'L2', label: 'L2 简单' },
            { value: 'L3', label: 'L3 进阶' },
            { value: 'L4', label: 'L4 困难' },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          开放后该客服可以进入对应难度的训练；任务训练与模拟训练都计入解锁进度。
        </Typography.Paragraph>
      </Modal>
    </Card>
  );
}
