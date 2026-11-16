import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn(), getToken: vi.fn(() => 'token'), setToken: vi.fn() }));

import { api } from '../api/client';
import { useAuth } from './auth';

describe('登录状态恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({ profile: null, passwordNotice: null });
  });

  it('页面初始化根据服务端个人资料恢复强制改密提示', async () => {
    const profile = { id: 1, username: 'agent', displayName: '客服', roleCode: 'agent', groupId: 1, mustChangePassword: true, notice: '请立即修改密码' };
    vi.mocked(api).mockResolvedValueOnce(profile);
    await useAuth.getState().load();
    expect(useAuth.getState().profile).toEqual(profile);
    expect(useAuth.getState().passwordNotice).toBe('请立即修改密码');
  });

  it('完成改密后重新加载会清除旧的提示', async () => {
    useAuth.setState({ passwordNotice: '请立即修改密码' });
    vi.mocked(api).mockResolvedValueOnce({ id: 1, username: 'agent', displayName: '客服', roleCode: 'agent', groupId: 1, mustChangePassword: false, notice: null });
    await useAuth.getState().load();
    expect(useAuth.getState().passwordNotice).toBeNull();
  });
});
