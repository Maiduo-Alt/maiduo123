import { create } from 'zustand';
import { api, getToken, setToken } from '../api/client';

export interface Profile {
  id: number;
  username: string;
  displayName: string;
  roleCode: 'admin' | 'leader' | 'agent';
  groupId: number | null;
  employeeNo?: string | null;
  mobile?: string | null;
  preference?: Record<string, any> | null;
  avatarUrl?: string | null;
}

interface AuthState {
  profile: Profile | null;
  loading: boolean;
  /** 方案 F8-10：密码过期或管理员重置后，登录会要求先改密 */
  passwordNotice: string | null;
  login: (username: string, password: string) => Promise<{ mustChangePassword: boolean; notice: string | null }>;
  clearPasswordNotice: () => void;
  logout: () => void;
  load: () => Promise<void>;
  hasRole: (...roles: string[]) => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  profile: null,
  loading: false,
  passwordNotice: null,
  async login(username, password) {
    set({ loading: true });
    try {
      const data = await api<{
        token: string;
        profile: Profile;
        mustChangePassword?: boolean;
        notice?: string | null;
      }>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setToken(data.token);
      set({ profile: data.profile, passwordNotice: data.mustChangePassword ? data.notice || '请先修改密码' : null });
      return { mustChangePassword: Boolean(data.mustChangePassword), notice: data.notice ?? null };
    } finally {
      set({ loading: false });
    }
  },
  clearPasswordNotice() {
    set({ passwordNotice: null });
  },
  logout() {
    setToken(null);
    set({ profile: null, passwordNotice: null });
  },
  async load() {
    if (!getToken()) return;
    try {
      const profile = await api<Profile>('/auth/profile');
      set({ profile });
    } catch {
      set({ profile: null });
    }
  },
  hasRole(...roles) {
    const profile = get().profile;
    if (!profile) return false;
    return roles.includes(profile.roleCode);
  },
}));
